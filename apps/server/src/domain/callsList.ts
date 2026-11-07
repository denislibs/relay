import type { CallEndReason, ProfilePhoto } from '@relay/protocol';
import { sql } from '../db';
import { nameForSql } from './profile';

/**
 * Список «Звонки» (docs/plans/2026-11-07-relay-calls-features.md, этап 2): звонки 1:1 — служебные сообщения call в
 * личных чатах пользователя (автор — звонящий), без удалённых и без скрытой очисткой истории части. Имя собеседника —
 * глазами пользователя (контактное). Новые пропущенные — входящие без ответа новее отметки calls_seen_at.
 */

export type CallRow = {
  id: number; chatId: number; peerId: number; name: string; photo: ProfilePhoto | null;
  outgoing: boolean; video: boolean; reason: CallEndReason; duration?: number; at: string;
  conference?: { callId: string; names: string[]; count: number };   // звонок без группы: чата нет, строка — кто был
};

/** Пропущенный глазами адресата: не ответил, звонящий сбросил, пока звонило, или был занят. */
export const MISSED: CallEndReason[] = ['missed', 'cancelled', 'busy'];
const PAGE = 50;

export async function listCalls(userId: number, o: { before?: { at: string; id: number }; missed?: boolean } = {}): Promise<{ calls: CallRow[]; more: boolean }> {
  const before = o.before ?? null;
  const rows = await sql`
    select x.*, p.user_id as peer, (select ${nameForSql(userId)} from users u where u.id = p.user_id) as name,
           (select u.photo from users u where u.id = p.user_id) as photo
      from chat_members cm
      join chats c on c.id = cm.chat_id and c.kind = 'direct' and c.deleted_at is null
      join chat_members p on p.chat_id = cm.chat_id and p.user_id <> ${userId}
      cross join lateral (
        select m.id, m.chat_id, m.sender_id, m.service_data, m.created_at
          from messages m
         where m.chat_id = cm.chat_id and m.service_type = 'call' and not m.deleted and m.id >= cm.history_from
           and (m.expires_at is null or m.expires_at > now())
           ${before ? sql`and (m.created_at, m.id) < (${before.at}::timestamptz, ${before.id}::bigint)` : sql``}
           ${o.missed ? sql`and m.sender_id <> ${userId} and m.service_data->'call'->>'reason' = any(${MISSED})` : sql``}
         order by m.id desc
         limit ${PAGE + 1}) x
     where cm.user_id = ${userId}
     order by x.created_at desc, x.id desc
     limit ${PAGE + 1}`;
  const calls = rows.slice(0, PAGE).map((r): CallRow => {
    const d = (r.service_data as { call?: { video?: boolean; reason?: CallEndReason; duration?: number } } | null)?.call ?? {};
    return {
      id: Number(r.id), chatId: Number(r.chat_id), peerId: Number(r.peer), name: String(r.name ?? ''), photo: (r.photo as ProfilePhoto | null) ?? null,
      outgoing: Number(r.sender_id) === userId, video: d.video === true, reason: d.reason ?? 'ended',
      ...(d.duration != null ? { duration: d.duration } : {}), at: new Date(r.created_at as string).toISOString(),
    };
  });
  // звонки без группы, где я был (во «Все»; пропущенных у них нет) — сливаются с личными по времени
  const conf = o.missed ? [] : await sql`
    select gc.id, gc.started_by, gc.started_at, gc.duration,
           (select count(*)::int from group_call_members x where x.call_id = gc.id) as count,
           (select array_agg(n) from (select ${nameForSql(userId)} as n from group_call_members x join users u on u.id = x.user_id
              where x.call_id = gc.id and x.user_id <> ${userId} order by x.joined_at limit 3) t) as names
      from group_call_members me
      join group_calls gc on gc.id = me.call_id and gc.kind = 'conference' and gc.ended_at is not null
     where me.user_id = ${userId}
       ${before ? sql`and gc.started_at < ${before.at}::timestamptz` : sql``}
     order by gc.started_at desc
     limit ${PAGE + 1}`;
  const confRows = conf.map((r): CallRow => ({
    id: 0, chatId: 0, peerId: Number(r.started_by ?? 0), name: ((r.names as string[] | null) ?? []).join(', '), photo: null,
    outgoing: Number(r.started_by) === userId, video: false, reason: 'ended', ...(r.duration != null ? { duration: Number(r.duration) } : {}),
    at: new Date(r.started_at as string).toISOString(), conference: { callId: r.id as string, names: (r.names as string[] | null) ?? [], count: Number(r.count) },
  }));
  const all = [...calls, ...confRows].sort((p, q) => (p.at < q.at ? 1 : p.at > q.at ? -1 : q.id - p.id));
  return { calls: all.slice(0, PAGE), more: rows.length > PAGE || conf.length > PAGE || all.length > PAGE };
}

/** Новые пропущенные (бейдж «Звонки»): входящие без ответа новее отметки «видел список». Не больше 99. */
export async function unseenMissed(userId: number): Promise<number> {
  const [r] = await sql`
    select count(*)::int as n from (
      select 1
        from chat_members cm
        join chats c on c.id = cm.chat_id and c.kind = 'direct' and c.deleted_at is null
        join messages m on m.chat_id = cm.chat_id and m.service_type = 'call' and not m.deleted and m.id >= cm.history_from
       where cm.user_id = ${userId} and m.sender_id <> ${userId}
         and m.service_data->'call'->>'reason' = any(${MISSED})
         and m.created_at > coalesce((select calls_seen_at from user_settings where user_id = ${userId}), '-infinity')
       limit 99) t`;
  return Number(r?.n ?? 0);
}

export async function markCallsSeen(userId: number): Promise<{ ok: true }> {
  await sql`insert into user_settings (user_id, calls_seen_at) values (${userId}, now())
            on conflict (user_id) do update set calls_seen_at = now()`;
  return { ok: true };
}
