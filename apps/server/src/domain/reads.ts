import { sql } from '../db';
import { DomainError } from './errors';
import { appendUpdates } from './journal';
import { clearUnreadMark } from './chatFlags';
import { nameForSql } from './profile';

export async function markRead(userId: number, chatId: number, upToId: number): Promise<{ lastReadId: number; changed: boolean }> {
  return sql.begin(async (tx) => {
    const [me] = await tx`select m.last_read_id, c.deleted_at from chat_members m join chats c on c.id = m.chat_id
                           where m.chat_id = ${chatId} and m.user_id = ${userId} for update of m`;
    if (!me) throw new DomainError('not_member');
    if (me.deleted_at) throw new DomainError('not_found', 'chat');   // мягко удалённый — как groupCtx
    await clearUnreadMark(tx, userId, chatId);   // прочитал (даже без новых сообщений) — пометка «непрочитанное» снята
    const [{ max }] = await tx`select coalesce(max(id), 0) as max from messages where chat_id = ${chatId}`;
    if (upToId > (max as number)) throw new DomainError('not_found', 'message');
    const current = me.last_read_id as number;
    if (upToId <= current) return { lastReadId: current, changed: false };

    await tx`update chat_members set last_read_id = ${upToId} where chat_id = ${chatId} and user_id = ${userId}`;
    // упоминания основной ленты до upToId прочитаны (треды — своим чтением, threads.ts)
    await tx`delete from message_mentions where user_id = ${userId} and chat_id = ${chatId} and thread_id is null and message_id <= ${upToId}`;
    const [c] = await tx`select kind from chats where id = ${chatId}`;
    // личный чат — собеседнику; группа — только авторам прочитанных сообщений (стоимость по сообщениям, не по участникам);
    // канал — никому: прочитанности постов нет (вместо галочек — просмотры), автор поста не узнаёт, кто читал
    const others = c.kind === 'direct'
      ? await tx`select user_id from chat_members where chat_id = ${chatId} and user_id <> ${userId}`
      : c.kind === 'channel' ? []
      : await tx`select distinct sender_id as user_id from messages where chat_id = ${chatId} and id > ${current} and id <= ${upToId} and sender_id <> ${userId} and not post`;   // копия поста — от канала: автору не сообщаем, кто читал
    await appendUpdates(tx, [
      { userId, update: { type: 'readOwn', chatId, upToId } },
      ...others.map((o) => ({ userId: o.user_id as number, update: { type: 'readBy' as const, chatId, userId, upToId } })),
    ]);
    return { lastReadId: upToId, changed: true };
  });
}

/** Больше участников — «кто прочитал» не отдаём (как в Telegram: только в небольших группах). */
export const READ_BY_MAX = 100;

/**
 * «Кто прочитал» своё сообщение: только группа (не больше READ_BY_MAX участников), только автор, не комментарий и не копия
 * поста. Участники с last_read_id ≥ mid, кроме автора; имена — глазами автора (контактные).
 */
export async function readBy(userId: number, chatId: number, mid: number): Promise<{ id: number; name: string }[]> {
  const [c] = await sql`select c.kind, c.members_count, c.deleted_at from chat_members m join chats c on c.id = m.chat_id where m.chat_id = ${chatId} and m.user_id = ${userId}`;
  if (!c) throw new DomainError('not_member');
  if (c.deleted_at) throw new DomainError('not_found', 'chat');
  if (c.kind !== 'group') throw new DomainError('bad_frame', 'not a group');
  if (Number(c.members_count) > READ_BY_MAX) throw new DomainError('forbidden', 'too many members');
  const [m] = await sql`select sender_id, thread_id, origin, deleted, service_type from messages where chat_id = ${chatId} and id = ${mid}`;
  if (!m || m.deleted) throw new DomainError('not_found', 'message');
  if (Number(m.sender_id) !== userId || m.service_type) throw new DomainError('forbidden', 'not your message');
  if (m.thread_id != null || m.origin != null) throw new DomainError('bad_frame', 'comment or post copy');
  const rows = await sql`
    select u.id, ${nameForSql(userId)} as name from chat_members cm join users u on u.id = cm.user_id
     where cm.chat_id = ${chatId} and cm.user_id <> ${userId} and cm.last_read_id >= ${mid}
     order by u.id`;
  return rows.map((r) => ({ id: Number(r.id), name: r.name as string }));
}
