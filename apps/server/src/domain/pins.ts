import { sql, type Tx } from '../db';
import { assertMember } from './chats';
import { DomainError } from './errors';
import { fanOut } from './journal';
import { isServiceChat } from './service';

// Закреплённые сообщения: любой участник закрепляет и открепляет; всем участникам уходит новый список (новые сверху).
export const PINS_MAX = 100;

export async function pinnedIds(db: Tx | typeof sql, chatId: number): Promise<number[]> {
  const rows = await db`select message_id from pinned_messages where chat_id = ${chatId} order by message_id desc limit ${PINS_MAX}`;
  return rows.map((r) => Number(r.message_id));
}

async function broadcast(tx: Tx, chatId: number): Promise<number[]> {
  const ids = await pinnedIds(tx, chatId);
  const members = await tx`select user_id from chat_members where chat_id = ${chatId}`;
  await fanOut(tx, members.map((m) => Number(m.user_id)), { type: 'pins', chatId, ids });
  return ids;
}

export async function pinMessage(userId: number, chatId: number, id: number): Promise<{ ids: number[] }> {
  return sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    if (await isServiceChat(tx, chatId)) throw new DomainError('forbidden');
    const [m] = await tx`select 1 from messages where chat_id = ${chatId} and id = ${id} and not deleted and service_type is null`;
    if (!m) throw new DomainError('not_found', 'message');
    const [{ n }] = await tx`select count(*)::int as n from pinned_messages where chat_id = ${chatId}`;
    if (n >= PINS_MAX) throw new DomainError('too_long', 'pins limit');
    const ins = await tx`insert into pinned_messages (chat_id, message_id, pinned_by) values (${chatId}, ${id}, ${userId}) on conflict do nothing returning 1`;
    return { ids: ins.length ? await broadcast(tx, chatId) : await pinnedIds(tx, chatId) };
  });
}

/** id = null — открепить все. */
export async function unpinMessage(userId: number, chatId: number, id: number | null): Promise<{ ids: number[] }> {
  return sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    const del = id == null
      ? await tx`delete from pinned_messages where chat_id = ${chatId} returning 1`
      : await tx`delete from pinned_messages where chat_id = ${chatId} and message_id = ${id} returning 1`;
    return { ids: del.length ? await broadcast(tx, chatId) : await pinnedIds(tx, chatId) };
  });
}

/** Сообщение удалили — снять с закрепа (в той же транзакции). */
export async function unpinDeleted(tx: Tx, chatId: number, id: number): Promise<void> {
  const del = await tx`delete from pinned_messages where chat_id = ${chatId} and message_id = ${id} returning 1`;
  if (del.length) await broadcast(tx, chatId);
}
