import { sql } from '../db';
import { enqueue } from '../jobs/queue';
import { appendUpdates } from './journal';

/**
 * Задача chat.purge {chatId, after, phase?}: чистка мягко удалённого (deleted_at) канала или группы страницами —
 * никакой гигантской транзакции на 200 000 участников. Сначала участники: страница chat_members по user_id после
 * after → chatRemoved в личные журналы страницы и удаление этих строк одной транзакцией, продолжение — следующей
 * задачей. Затем сообщения страницами по id; в конце строка chats (каскадом — журнал чата, ключи, ссылки).
 * Повтор задачи безопасен: страница берётся по курсору, продолжение — с dedupe_key.
 */

/** Размер страницы (тесты уменьшают, чтобы пройти несколько страниц). */
export const PURGE = { page: 1000 };

export type PurgeJob = { chatId: number; after?: number; phase?: 'members' | 'messages' };

export async function purgeStep(p: PurgeJob): Promise<void> {
  const chatId = Number(p.chatId), after = Number(p.after ?? 0), page = PURGE.page;
  await sql.begin(async (tx) => {
    const [c] = await tx`select deleted_at from chats where id = ${chatId} for update`;
    if (!c || !c.deleted_at) return;   // уже вычищен (повтор) или не удалялся
    if (p.phase !== 'messages') {
      const rows = await tx`select user_id from chat_members where chat_id = ${chatId} and user_id > ${after} order by user_id limit ${page}`;
      const ids = rows.map((r) => Number(r.user_id));
      if (ids.length) {
        await appendUpdates(tx, ids.map((userId) => ({ userId, update: { type: 'chatRemoved' as const, chatId } })));
        await tx`delete from chat_members where chat_id = ${chatId} and user_id = any(${ids}::bigint[])`;
        await tx`delete from drafts where chat_id = ${chatId} and user_id = any(${ids}::bigint[])`;
        await tx`delete from message_mentions where chat_id = ${chatId} and user_id = any(${ids}::bigint[])`;
        await tx`delete from unread_reactions where chat_id = ${chatId} and user_id = any(${ids}::bigint[])`;
      }
      const last = ids[ids.length - 1];
      if (ids.length === page) await enqueue(tx, 'chat.purge', { chatId, after: last }, { dedupeKey: `chat.purge:${chatId}:m:${last}` });
      else await enqueue(tx, 'chat.purge', { chatId, phase: 'messages', after: 0 }, { dedupeKey: `chat.purge:${chatId}:x:0` });
      return;
    }
    const del = await tx`
      delete from messages where chat_id = ${chatId}
         and id in (select id from messages where chat_id = ${chatId} and id > ${after} order by id limit ${page})
      returning id`;
    if (del.length === page) {
      const last = Math.max(...del.map((r) => Number(r.id)));
      await enqueue(tx, 'chat.purge', { chatId, phase: 'messages', after: last }, { dedupeKey: `chat.purge:${chatId}:x:${last}` });
      return;
    }
    await tx`delete from chats where id = ${chatId}`;
  });
}
