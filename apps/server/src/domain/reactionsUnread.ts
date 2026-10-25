import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { appendUpdates } from './journal';

/**
 * Непрочитанные реакции на мои сообщения (как в Telegram: кнопка «сердце» со счётчиком над «вниз»). Строка
 * unread_reactions — на сообщение, пока автор не увидит его на экране (readReactions с id) или не нажмёт
 * «прочитать все». Личный журнал: reaction — появилась чужая реакция на моё сообщение; reactionsRead — снято
 * (прочитал на другом устройстве, реакцию убрали, сообщение удалили). Посты канала реакций не копят: у поста
 * нет «автора-читателя», там счётчики.
 */
export const UNREAD_REACTIONS_PAGE = 50;

/**
 * После смены реакции reactor на сообщении (prev → next): новая чужая реакция — автору строка и событие (смена
 * эмодзи и повтор того же — нет: прочитанное не воскресает); реакцию убрали и чужих не осталось — строка долой.
 * Автор должен быть участником чата: ушедшему строк не копим.
 */
export async function noteReaction(tx: Tx, chatId: number, id: number, reactor: number, prev: string | null, next: string | null): Promise<void> {
  const [m] = await tx`select sender_id from messages where chat_id = ${chatId} and id = ${id}`;
  if (!m) return;
  const author = Number(m.sender_id);
  if (author === reactor || author <= 0) return;   // своя реакция и служебные/посты — не считаются
  if (next) {
    if (prev) return;   // смена или повтор эмодзи — ничего нового для автора
    const ins = await tx`insert into unread_reactions (user_id, chat_id, message_id)
      select ${author}, ${chatId}, ${id} where exists (select 1 from chat_members where chat_id = ${chatId} and user_id = ${author})
      on conflict do nothing returning 1`;
    if (ins.length) await appendUpdates(tx, [{ userId: author, update: { type: 'reaction', chatId, id } }]);
    return;
  }
  const [{ n }] = await tx`select count(*)::int as n from reactions where chat_id = ${chatId} and message_id = ${id} and user_id <> ${author}`;
  if (Number(n) > 0) return;
  const del = await tx`delete from unread_reactions where user_id = ${author} and chat_id = ${chatId} and message_id = ${id} returning 1`;
  if (del.length) await appendUpdates(tx, [{ userId: author, update: { type: 'reactionsRead', chatId, ids: [id] } }]);
}

/** Сообщение удалено или чат чистится: строки долой у всех (журнал — только тем, у кого они были). */
export async function dropUnreadReactions(tx: Tx, chatId: number, id: number): Promise<void> {
  const rows = await tx`delete from unread_reactions where chat_id = ${chatId} and message_id = ${id} returning user_id`;
  await appendUpdates(tx, rows.map((r) => ({ userId: Number(r.user_id), update: { type: 'reactionsRead' as const, chatId, ids: [id] } })));
}

/** Самые старые непрочитанные — для перехода «к следующей» (id по возрастанию). */
export async function unreadReactions(userId: number, chatId: number): Promise<{ ids: number[]; count: number }> {
  const [me] = await sql`select 1 from chat_members where chat_id = ${chatId} and user_id = ${userId}`;
  if (!me) throw new DomainError('not_member');
  const rows = await sql`select message_id from unread_reactions where user_id = ${userId} and chat_id = ${chatId} order by message_id limit ${UNREAD_REACTIONS_PAGE}`;
  const [{ count }] = await sql`select count(*)::int as count from unread_reactions where user_id = ${userId} and chat_id = ${chatId}`;
  return { ids: rows.map((r) => Number(r.message_id)), count: Number(count) };
}

/** Прочитал: увидел сообщения ids на экране или «прочитать все» (без ids). Остаток — для счётчика. */
export async function readReactions(userId: number, chatId: number, ids?: number[]): Promise<{ count: number }> {
  return sql.begin(async (tx) => {
    const [me] = await tx`select 1 from chat_members where chat_id = ${chatId} and user_id = ${userId}`;
    if (!me) throw new DomainError('not_member');
    const gone = ids
      ? await tx`delete from unread_reactions where user_id = ${userId} and chat_id = ${chatId} and message_id = any(${ids}::bigint[]) returning message_id`
      : await tx`delete from unread_reactions where user_id = ${userId} and chat_id = ${chatId} returning message_id`;
    if (gone.length) await appendUpdates(tx, [{ userId, update: { type: 'reactionsRead', chatId, ...(ids ? { ids: gone.map((r) => Number(r.message_id)) } : {}) } }]);
    const [{ count }] = await tx`select count(*)::int as count from unread_reactions where user_id = ${userId} and chat_id = ${chatId}`;
    return { count: Number(count) };
  });
}
