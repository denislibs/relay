// Ключ поиска: HMAC-SHA256 для токенов слов в индексе (search/tokens.ts). Случайные 32 байта, в базе — завёрнутые
// KMS (keys.search_key), в памяти процесса — развёрнутые. Утечка индекса без этого ключа даёт только «какие документы
// содержат одно и то же слово», но не сами слова.
import { sql } from '../db';
import { randomKey } from './aead';
import { getKms, kmsFor } from './kms';
import { SEARCH_CTX, unwrapFor, wrapFor } from './keyBinding';

let key: Promise<Buffer> | null = null;

export function searchKey(): Promise<Buffer> {
  return key ??= (async () => {
    let [row] = await sql`select wrapped, kek_id from keys.search_key where id = 1`;
    if (!row) {
      const kms = getKms();
      await kms.init?.();
      await sql`insert into keys.search_key (id, wrapped, kek_id, bound) values (1, ${Buffer.from(await wrapFor(kms, SEARCH_CTX, randomKey()))}, ${kms.id}, true) on conflict (id) do nothing`;
      [row] = await sql`select wrapped, kek_id from keys.search_key where id = 1`;   // гонка процессов — берём записанный первым
    }
    return Buffer.from(await unwrapFor(SEARCH_CTX, row.wrapped as Uint8Array, row.kek_id as string));
  })().catch((e) => { key = null; throw e; });
}

export function resetSearchKeyCache(): void { key = null; }

/** Смена главного ключа: перезавернуть ключ поиска текущим (сам ключ и индекс не меняются). */
export async function rewrapSearchKey(): Promise<boolean> {
  const cur = getKms();
  const [row] = await sql`select wrapped, kek_id from keys.search_key where id = 1`;
  if (!row) return false;
  const wrapped = new Uint8Array(row.wrapped as Uint8Array);
  if (row.kek_id === cur.id && !(await cur.stale?.(wrapped))) return false;
  const next = row.kek_id === cur.id && cur.rewrap ? await cur.rewrap(wrapped) : await cur.wrap(await kmsFor(row.kek_id as string).unwrap(wrapped, row.kek_id as string));
  await sql`update keys.search_key set wrapped = ${Buffer.from(next)}, kek_id = ${cur.id} where id = 1 and wrapped = ${Buffer.from(wrapped)}`;
  return true;
}
