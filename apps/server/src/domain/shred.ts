import type { Tx } from '../db';
import { enqueue } from '../jobs/queue';
import { referenced } from './storageGc';

/**
 * Уничтожение истории чата ниже below (crypto-shredding, CRYPTO-1 и CRYPTO-2) — в транзакции вызывающего, вместе
 * с уничтожением версий ключа чата:
 *  - строки сообщений ниже границы — удалены и пусты (вложение, текст, шифр): fileFor и поиск их больше не видят;
 *  - файлы, на которые больше никто не ссылается, теряют ключ (keys.attachment_keys; NOTIFY сбрасывает кэши всех
 *    процессов): объект в хранилище — шифр без ключа, сборка мусора удалит и его;
 *  - документы поиска этих сообщений удаляются (задача search.purgeChat).
 */
export async function shredHistory(tx: Tx, chatId: number, below: number): Promise<void> {
  const files = (await tx`select distinct attachment->>'id' as aid from messages where chat_id = ${chatId} and id < ${below} and attachment is not null`)
    .map((r) => r.aid as string | null).filter((x): x is string => !!x);
  await tx`update messages set deleted = true, attachment = null, content = null, body = '', entities = null, todo = null, blocks = null, link = null
            where chat_id = ${chatId} and id < ${below} and not deleted`;
  if (files.length) {
    await tx`delete from keys.attachment_keys k using attachments a
              where k.attachment_id = a.id and a.id = any(${[...new Set(files)]}::uuid[]) and not ${referenced(tx as never)}`;
  }
  await enqueue(tx, 'search.purgeChat', { chatId, below }, { dedupeKey: `search.purgeChat:${chatId}:${below}` });
}
