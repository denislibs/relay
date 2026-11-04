import { sql, type Tx } from '../db';
import { logAdminAction } from './adminLog';
import { assertMember } from './chats';
import { DomainError } from './errors';
import { chatEvent } from './journal';
import { isServiceChat } from './service';
import { canPin, groupCtx } from './groupRights';

// Закреплённые сообщения: любой участник закрепляет и открепляет; всем участникам уходит новый список (новые сверху).
// В журнал действий идут все, кроме своего сообщения у обычного участника (не админа): это не действие над чужим.
export const PINS_MAX = 100;

export async function pinnedIds(db: Tx | typeof sql, chatId: number): Promise<number[]> {
  const rows = await db`select message_id from pinned_messages where chat_id = ${chatId} order by message_id desc limit ${PINS_MAX}`;
  return rows.map((r) => Number(r.message_id));
}

async function broadcast(tx: Tx, chatId: number): Promise<number[]> {
  const ids = await pinnedIds(tx, chatId);
  await chatEvent(tx, chatId, { type: 'pins', chatId, ids });
  return ids;
}

export async function pinMessage(userId: number, chatId: number, id: number): Promise<{ ids: number[] }> {
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId);
    if (!canPin(ctx)) throw new DomainError('forbidden', 'pin');
    if (await isServiceChat(tx, chatId)) throw new DomainError('forbidden');
    const [m] = await tx`select sender_id from messages where chat_id = ${chatId} and id = ${id} and not deleted and (expires_at is null or expires_at > now()) and service_type is null`;
    if (!m) throw new DomainError('not_found', 'message');
    const [{ n }] = await tx`select count(*)::int as n from pinned_messages where chat_id = ${chatId}`;
    if (n >= PINS_MAX) throw new DomainError('too_long', 'pins limit');
    const ins = await tx`insert into pinned_messages (chat_id, message_id, pinned_by) values (${chatId}, ${id}, ${userId}) on conflict do nothing returning 1`;
    const author = Number(m.sender_id);
    if (ins.length && (ctx.admin || author !== userId)) await logAdminAction(tx, chatId, userId, 'message_pinned', { messageId: id, target: author });
    return { ids: ins.length ? await broadcast(tx, chatId) : await pinnedIds(tx, chatId) };
  });
}

/** id = null — открепить все. */
export async function unpinMessage(userId: number, chatId: number, id: number | null): Promise<{ ids: number[] }> {
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId);
    if (!canPin(ctx)) throw new DomainError('forbidden', 'pin');
    const del = id == null
      ? await tx`delete from pinned_messages where chat_id = ${chatId} returning 1`
      : await tx`delete from pinned_messages where chat_id = ${chatId} and message_id = ${id} returning 1`;
    if (del.length && id == null) await logAdminAction(tx, chatId, userId, 'all_unpinned', { count: del.length });
    else if (del.length) {
      const [m] = await tx`select sender_id from messages where chat_id = ${chatId} and id = ${id}`;
      const author = m ? Number(m.sender_id) : undefined;
      if (ctx.admin || author !== userId) await logAdminAction(tx, chatId, userId, 'message_unpinned', { messageId: id!, ...(author != null ? { target: author } : {}) });
    }
    return { ids: del.length ? await broadcast(tx, chatId) : await pinnedIds(tx, chatId) };
  });
}

/** Сообщение удалили — снять с закрепа (в той же транзакции). */
export async function unpinDeleted(tx: Tx, chatId: number, id: number): Promise<void> {
  const del = await tx`delete from pinned_messages where chat_id = ${chatId} and message_id = ${id} returning 1`;
  if (del.length) await broadcast(tx, chatId);
}
