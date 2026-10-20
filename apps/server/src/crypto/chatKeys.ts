// Ключи чатов: случайный DEK на чат (и версию), в базе — только завёрнутый KMS. Развёрнутые ключи держим в памяти
// (LRU, 10 минут): открытие чата — один вызов KMS, дальше только AES. Одновременные запросы одного ключа — один вызов.
// Создание ключа — вне транзакции вызывающего (autocommit): откат его транзакции не должен оставить в кэше ключ,
// которого нет в базе, иначе сообщения запечатаются ключом-призраком.
import { sql } from '../db';
import { CryptoError, importAesKey, randomKey } from './aead';
import { getKms } from './kms';

export interface ChatKey { version: number; key: CryptoKey }

const TTL_MS = 10 * 60_000;
const MAX = 5000;
const keys = new Map<string, { key: CryptoKey; at: number }>();       // «чат:версия» → ключ
const current = new Map<number, { version: number; at: number }>();  // чат → текущая версия
const inflight = new Map<string, Promise<unknown>>();

function remember(chatId: number, version: number, key: CryptoKey): void {
  const k = chatId + ':' + version;
  keys.delete(k);
  keys.set(k, { key, at: Date.now() });
  if (keys.size > MAX) keys.delete(keys.keys().next().value!);   // самый давний (Map хранит порядок вставки)
}
function cached(chatId: number, version: number): CryptoKey | null {
  const k = chatId + ':' + version, e = keys.get(k);
  if (!e || Date.now() - e.at > TTL_MS) { if (e) keys.delete(k); return null; }
  keys.delete(k); keys.set(k, e);   // наверх LRU
  return e.key;
}
function once<T>(id: string, fn: () => Promise<T>): Promise<T> {
  let p = inflight.get(id) as Promise<T> | undefined;
  if (!p) { p = fn().finally(() => inflight.delete(id)); inflight.set(id, p); }
  return p;
}

async function unwrapRow(chatId: number, version: number, wrapped: Uint8Array): Promise<CryptoKey> {
  const key = await importAesKey(await getKms().unwrap(new Uint8Array(wrapped)));
  remember(chatId, version, key);
  return key;
}

/** Ключ для расшифровки: конкретная версия. Ключа нет — чат удалён (ключ уничтожен): CryptoError('no_key'). */
export async function chatKey(chatId: number, version: number): Promise<CryptoKey> {
  return cached(chatId, version) ?? once(`k:${chatId}:${version}`, async () => {
    const [row] = await sql`select wrapped_dek from keys.chat_keys where chat_id = ${chatId} and version = ${version}`;
    if (!row) throw new CryptoError('no_key', `no key for chat ${chatId} v${version}`);
    return unwrapRow(chatId, version, row.wrapped_dek as Uint8Array);
  });
}

/** Ключ для шифрования: текущая (последняя) версия; у чата ещё нет ключа — создаём. */
export async function currentChatKey(chatId: number): Promise<ChatKey> {
  const c = current.get(chatId);
  if (c && Date.now() - c.at < TTL_MS) {
    const key = cached(chatId, c.version);
    if (key) return { version: c.version, key };
  }
  return once(`c:${chatId}`, async () => {
    let [row] = await sql`select version, wrapped_dek from keys.chat_keys where chat_id = ${chatId} order by version desc limit 1`;
    if (!row) {
      const kms = getKms();
      const wrapped = await kms.wrap(randomKey());
      // параллельный процесс мог создать раньше — тогда берём его ключ
      await sql`insert into keys.chat_keys (chat_id, version, wrapped_dek, kek_id) values (${chatId}, 1, ${Buffer.from(wrapped)}, ${kms.id}) on conflict do nothing`;
      [row] = await sql`select version, wrapped_dek from keys.chat_keys where chat_id = ${chatId} order by version desc limit 1`;
      if (!row) throw new CryptoError('no_key', `chat ${chatId} is gone`);
    }
    const version = row.version as number;
    const key = cached(chatId, version) ?? await unwrapRow(chatId, version, row.wrapped_dek as Uint8Array);
    current.set(chatId, { version, at: Date.now() });
    return { version, key };
  });
}

/** Новая версия ключа чата: новые записи — им, старые читаются своими версиями. */
export async function rotateChatKey(chatId: number): Promise<number> {
  const kms = getKms();
  const wrapped = await kms.wrap(randomKey());
  const [row] = await sql`
    insert into keys.chat_keys (chat_id, version, wrapped_dek, kek_id)
    select ${chatId}, coalesce(max(version), 0) + 1, ${Buffer.from(wrapped)}, ${kms.id} from keys.chat_keys where chat_id = ${chatId}
    returning version`;
  current.delete(chatId);
  return row.version as number;
}

/** Забыть ключи чата в памяти этого процесса (чат удалён — ключ уничтожен). */
export function forgetChat(chatId: number): void {
  current.delete(chatId);
  for (const k of [...keys.keys()]) if (k.startsWith(chatId + ':')) keys.delete(k);
}
/** Тесты: очистить кэш. */
export function resetChatKeyCache(): void { keys.clear(); current.clear(); }
