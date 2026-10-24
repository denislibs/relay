import { sql } from '../db';
import { DomainError } from './errors';
import { appendUpdates } from './journal';
import { clearUnreadMark } from './chatFlags';

export async function markRead(userId: number, chatId: number, upToId: number): Promise<{ lastReadId: number; changed: boolean }> {
  return sql.begin(async (tx) => {
    const [me] = await tx`select last_read_id from chat_members where chat_id = ${chatId} and user_id = ${userId} for update`;
    if (!me) throw new DomainError('not_member');
    await clearUnreadMark(tx, userId, chatId);   // прочитал (даже без новых сообщений) — пометка «непрочитанное» снята
    const [{ max }] = await tx`select coalesce(max(id), 0) as max from messages where chat_id = ${chatId}`;
    if (upToId > (max as number)) throw new DomainError('not_found', 'message');
    const current = me.last_read_id as number;
    if (upToId <= current) return { lastReadId: current, changed: false };

    await tx`update chat_members set last_read_id = ${upToId} where chat_id = ${chatId} and user_id = ${userId}`;
    const [c] = await tx`select kind from chats where id = ${chatId}`;
    // личный чат — собеседнику; группа — только авторам прочитанных сообщений (стоимость по сообщениям, не по участникам);
    // канал — никому: прочитанности постов нет (вместо галочек — просмотры), автор поста не узнаёт, кто читал
    const others = c.kind === 'direct'
      ? await tx`select user_id from chat_members where chat_id = ${chatId} and user_id <> ${userId}`
      : c.kind === 'channel' ? []
      : await tx`select distinct sender_id as user_id from messages where chat_id = ${chatId} and id > ${current} and id <= ${upToId} and sender_id <> ${userId}`;
    await appendUpdates(tx, [
      { userId, update: { type: 'readOwn', chatId, upToId } },
      ...others.map((o) => ({ userId: o.user_id as number, update: { type: 'readBy' as const, chatId, userId, upToId } })),
    ]);
    return { lastReadId: upToId, changed: true };
  });
}
