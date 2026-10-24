import { sql, type Tx } from '../db';
import { enqueue } from '../jobs/queue';
import { DomainError } from './errors';
import { chatEvent } from './journal';

/**
 * Реакции поста канала — счётчиками (message_reaction_counts), а не списком «кто поставил»: на 200 000 подписчиков
 * событие со списком было бы O(N) на каждую реакцию. Своя реакция — строка reactions (как в группе), она же даёт
 * «моя» при чтении и перенос счётчика при смене эмодзи.
 *
 * Событие reactionCounts — не на каждую реакцию, а не чаще раза в секунду на пост: задача reactions.flush с ключом
 * секундного окна w и runAt = конец окна. w берётся из часов базы ПОСЛЕ замка строки сообщения: обработчик читает
 * счётчики под for share той же строки, поэтому изменение, успевшее до его чтения, в событие попало, а более
 * позднее ждало его замка и получило новое w (обработчик стартует не раньше w + 1) — свою задачу. Без потерь.
 */

export type Counts = [string, number][];

/** Счётчики поста: больше — раньше, при равенстве — по коду эмодзи (collate "C": тот же порядок, что у клиента). */
export async function readCounts(db: Tx | typeof sql, chatId: number, id: number): Promise<Counts> {
  const rows = await db`select emoji, n from message_reaction_counts where chat_id = ${chatId} and message_id = ${id} and n > 0 order by n desc, emoji collate "C"`;
  return rows.map((r) => [r.emoji as string, Number(r.n)]);
}

/** Реакция на пост (null — снять) в транзакции reactMessage: права уже проверены. Ответ — счётчики и моя. */
export async function reactPost(tx: Tx, userId: number, chatId: number, id: number, historyFrom: number, emoji: string | null): Promise<{ reactions: []; counts: Counts; mine: string | null }> {
  // замок строки сообщения: смены счётчиков одного поста идут по очереди, обработчик окна ждёт их (for share)
  const [m] = await tx`select deleted from messages where chat_id = ${chatId} and id = ${id} and id >= ${historyFrom} for update`;
  if (!m || m.deleted) throw new DomainError('not_found', 'message');
  const [old] = await tx`select emoji from reactions where chat_id = ${chatId} and message_id = ${id} and user_id = ${userId}`;
  const prev = (old?.emoji as string | undefined) ?? null;
  if (prev !== emoji) {
    if (prev) {
      await tx`update message_reaction_counts set n = n - 1 where chat_id = ${chatId} and message_id = ${id} and emoji = ${prev}`;
      await tx`delete from message_reaction_counts where chat_id = ${chatId} and message_id = ${id} and emoji = ${prev} and n <= 0`;
    }
    if (emoji) {
      await tx`insert into message_reaction_counts (chat_id, message_id, emoji, n) values (${chatId}, ${id}, ${emoji}, 1)
               on conflict (chat_id, message_id, emoji) do update set n = message_reaction_counts.n + 1`;
      await tx`insert into reactions (chat_id, message_id, user_id, emoji) values (${chatId}, ${id}, ${userId}, ${emoji})
               on conflict (chat_id, message_id, user_id) do update set emoji = excluded.emoji, created_at = now()`;
    } else {
      await tx`delete from reactions where chat_id = ${chatId} and message_id = ${id} and user_id = ${userId}`;
    }
    // окно — по часам базы и только после замка строки (см. выше); clock_timestamp, а не now() начала транзакции
    const [{ w }] = await tx`select floor(extract(epoch from clock_timestamp()))::bigint as w`;
    const sec = Number(w);
    await enqueue(tx, 'reactions.flush', { chatId, id }, { dedupeKey: `reactions:${chatId}:${id}:${sec}`, runAt: new Date((sec + 1) * 1000) });
  }
  return { reactions: [], counts: await readCounts(tx, chatId, id), mine: emoji };
}

/** Задача reactions.flush: счётчики поста — одним событием в журнал канала. Пост удалён или канал пропал — ничего. */
export async function flushReactionCounts(p: { chatId: number; id: number }): Promise<void> {
  const chatId = Number(p.chatId), id = Number(p.id);
  await sql.begin(async (tx) => {
    const [m] = await tx`select m.deleted, c.deleted_at from messages m join chats c on c.id = m.chat_id
                          where m.chat_id = ${chatId} and m.id = ${id} for share of m`;
    if (!m || m.deleted || m.deleted_at) return;   // удалённый пост уходит событием messageDeleted
    await chatEvent(tx, chatId, { type: 'reactionCounts', chatId, id, counts: await readCounts(tx, chatId, id) }, 'channel');
  });
}
