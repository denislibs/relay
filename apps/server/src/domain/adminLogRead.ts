import {
  ADMIN_LOG_ACTIONS, ADMIN_LOG_LABELS, ADMIN_LOG_PAGE_MAX, ADMIN_LOG_RETENTION_HOURS, hideSpoilers,
  type AdminLogAction, type AdminLogEntry, type AdminLogMessage, type AdminLogPage, type AdminLogUser,
} from '@relay/protocol';
import { peerKey } from '../crypto/peerKey';
import { sql } from '../db';
import { getMessagesByIds } from './chats';
import { DomainError } from './errors';
import { groupCtx, isCommunity } from './groupRights';
import { nameForSql } from './profile';

const ACTIONS = new Set<string>(ADMIN_LOG_ACTIONS);
const LIST_MAX = 64, Q_MAX = 64, BODY_MAX = 160;

const posInt = (raw: string, what: string): number => {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new DomainError('bad_frame', what);
  return n;
};
const csv = (raw: string | null) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Разбор запроса: всё от клиента проверяется, неизвестный тип и не число — отказ, а не пустая выдача. */
export function parseAdminLogQuery(p: URLSearchParams): { before: number | null; limit: number; actions: AdminLogAction[]; actors: number[]; q: string } {
  const before = p.get('before') ? posInt(p.get('before')!, 'before') : null;
  const limit = p.get('limit') ? Math.min(posInt(p.get('limit')!, 'limit'), ADMIN_LOG_PAGE_MAX) : 50;
  const actions = csv(p.get('actions'));
  if (actions.length > ADMIN_LOG_ACTIONS.length || actions.some((a) => !ACTIONS.has(a))) throw new DomainError('bad_frame', 'actions');
  const actors = csv(p.get('actors'));
  if (actors.length > LIST_MAX) throw new DomainError('bad_frame', 'actors');
  const q = (p.get('q') ?? '').trim();
  if ([...q].length > Q_MAX) throw new DomainError('too_long', 'q');
  return { before, limit, actions: actions as AdminLogAction[], actors: actors.map((a) => posInt(a, 'actors')), q };
}

/**
 * Страница журнала, новые сверху. Только текущий админ или владелец: право проверяется на каждый запрос (снятый с поста и
 * вышедший теряют доступ сразу, удалённый чат — not_found). Старше срока не отдаётся и до прихода adminLog.trim.
 *
 * q ищет только по именам исполнителей (как их видит читатель) и названиям типов: открытого текста сообщений нет.
 * Сообщение подставляется тем же getMessagesByIds, что и обычное чтение: удалённое, вышедшее по сроку, скрытое
 * history_from — не вернётся, и у записи будет message: null. У админа со скрытой историей (стал админом после
 * вступления) записи об этих сообщениях теряют ссылку и автора: журнал не должен открывать то, что скрыто в чате.
 */
export async function adminLogPage(viewer: number, chatId: number, params: URLSearchParams): Promise<AdminLogPage> {
  const { before, limit, actions, actors, q } = parseAdminLogQuery(params);
  const ctx = await groupCtx(sql, chatId, viewer);
  isCommunity(ctx);
  if (!ctx.admin) throw new DomainError('forbidden', 'admin_log');

  const like = q ? '%' + q.toLowerCase().replace(/[%_\\]/g, (c) => '\\' + c) + '%' : null;
  const byLabel = q ? ADMIN_LOG_ACTIONS.filter((a) => ADMIN_LOG_LABELS[a].toLowerCase().includes(q.toLowerCase())) : [];
  const rows = await sql`
    select l.id, l.action, l.actor_id, l.data, l.at from admin_log l left join users u on u.id = l.actor_id
     where l.chat_id = ${chatId} and l.at > now() - make_interval(hours => ${ADMIN_LOG_RETENTION_HOURS})
       ${before != null ? sql`and l.id < ${before}` : sql``}
       ${actions.length ? sql`and l.action = any(${actions}::text[])` : sql``}
       ${actors.length ? sql`and l.actor_id = any(${actors}::bigint[])` : sql``}
       ${like ? sql`and (lower(${nameForSql(viewer)}) like ${like} or l.action = any(${byLabel}::text[]))` : sql``}
     order by l.id desc limit ${limit + 1}`;
  const page = rows.slice(0, limit);

  const entries = page.map((r) => {
    const data = { ...(r.data as Record<string, unknown>) };
    if (typeof data.messageId === 'number' && data.messageId < ctx.historyFrom) { delete data.messageId; delete data.target; delete data.at; data.hidden = true; }
    return { id: Number(r.id), action: r.action as AdminLogAction, at: new Date(r.at as string).toISOString(), actorId: r.actor_id == null ? null : Number(r.actor_id), data } as AdminLogEntry;
  });

  const msgIds = [...new Set(entries.flatMap((e) => { const m = (e.data as { messageId?: number }).messageId; return m != null && e.action !== 'message_deleted' ? [m] : []; }))];
  const messages = new Map<number, AdminLogMessage>();
  for (const m of await getMessagesByIds(viewer, chatId, msgIds)) {
    messages.set(m.id, { id: m.id, kind: m.kind, body: m.kind === 'poll' ? (m.poll?.question ?? '') : hideSpoilers(m.body ?? '', m.entities ?? []).slice(0, BODY_MAX), ...(m.threadId != null ? { threadId: m.threadId } : {}) });
  }
  for (const e of entries) {
    const m = (e.data as { messageId?: number }).messageId;
    if (m != null && e.action !== 'message_deleted') e.message = messages.get(m) ?? null;
  }

  const userIds = [...new Set(entries.flatMap((e) => { const t = (e.data as { target?: number }).target; return [e.actorId, t].filter((x): x is number => x != null); }))];
  const urows = userIds.length ? await sql`
    select u.id, ${nameForSql(viewer)} as name,
           case when exists (select 1 from blocks b where b.owner_id = u.id and b.user_id = ${viewer}) then null else u.photo end as photo
      from users u where u.id = any(${userIds}::bigint[])` : [];
  const known = new Map(urows.map((r) => [Number(r.id), r]));
  // пользователя нет (удалён) — name null: имя и фото не восстанавливаем, клиент покажет нейтрально
  const users: AdminLogUser[] = userIds.map((id) => {
    const r = known.get(id);
    return { id, name: r ? (r.name as string) : null, photo: r ? ((r.photo as AdminLogUser['photo']) ?? null) : null, ...(r && id !== viewer ? { key: peerKey(viewer, id) } : {}) };
  });

  // название другого чата — только если читатель его и так видит: состоит в нём или чат сейчас связан с этим
  const chatIds = [...new Set(entries.flatMap((e) => (e.action === 'linked_chat_changed' ? [e.data.from, e.data.to].filter((x): x is number => x != null) : [])))];
  const chats = chatIds.length ? await sql`
    select c.id, c.title from chats c
     where c.id = any(${chatIds}::bigint[]) and c.deleted_at is null
       and (c.linked_chat_id = ${chatId} or exists (select 1 from chat_members m where m.chat_id = c.id and m.user_id = ${viewer}))` : [];

  return { entries, users, chats: chats.map((c) => ({ id: Number(c.id), title: (c.title as string | null) ?? '' })), hasMore: rows.length > limit };
}
