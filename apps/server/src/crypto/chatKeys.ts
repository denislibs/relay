// Ключи чатов: случайный DEK на чат (и версию), в базе — только завёрнутый KMS. Развёрнутые ключи держим в памяти
// (LRU, 10 минут): открытие чата — один вызов KMS, дальше только AES. Одновременные запросы одного ключа — один вызов.
// Создание ключа — вне транзакции вызывающего (autocommit): откат его транзакции не должен оставить в кэше ключ,
// которого нет в базе, иначе сообщения запечатаются ключом-призраком.
import { sql, type Tx } from '../db';
import { CryptoError, importAesKey, randomKey } from './aead';
import { getKms } from './kms';
import { chatCtx, unwrapFor, wrapFor } from './keyBinding';

export interface ChatKey { version: number; key: CryptoKey }

const TTL_MS = 10 * 60_000;
const MAX = 5000;
const keys = new Map<string, { key: CryptoKey; at: number }>();       // «чат:версия» → ключ
const current = new Map<number, { version: number; at: number }>();  // чат → текущая версия
const inflight = new Map<string, Promise<unknown>>();
const expiring = new Map<string, { version: number; at: number }>();   // «чат:конец корзины» → срочная версия

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

async function unwrapRow(chatId: number, version: number, wrapped: Uint8Array, kekId?: string): Promise<CryptoKey> {
  const key = await importAesKey(await unwrapFor(chatCtx(chatId), wrapped, kekId));
  remember(chatId, version, key);
  return key;
}

/**
 * Ключ для расшифровки: конкретная версия. Ключа нет — чат удалён (ключ уничтожен): CryptoError('no_key').
 * tx — читать в транзакции вызывающего (ключ мог появиться в ней же); так прочитанный ключ в кэш не идёт.
 */
export async function chatKey(chatId: number, version: number, tx?: Tx): Promise<CryptoKey> {
  const hit = cached(chatId, version);
  if (hit) return hit;
  if (tx) {
    const [row] = await tx`select wrapped_dek, kek_id from keys.chat_keys where chat_id = ${chatId} and version = ${version}`;
    if (!row) throw new CryptoError('no_key', `no key for chat ${chatId} v${version}`);
    return importAesKey(await unwrapFor(chatCtx(chatId), row.wrapped_dek as Uint8Array, row.kek_id as string));
  }
  return once(`k:${chatId}:${version}`, async () => {
    const [row] = await sql`select wrapped_dek, kek_id from keys.chat_keys where chat_id = ${chatId} and version = ${version}`;
    if (!row) throw new CryptoError('no_key', `no key for chat ${chatId} v${version}`);
    return unwrapRow(chatId, version, row.wrapped_dek as Uint8Array, row.kek_id as string);
  });
}

/**
 * Ключ для шифрования: текущая (последняя) версия; у чата ещё нет ключа — создаём.
 * tx — транзакция вызывающего, если чат создан в ней же (ещё не виден снаружи): ключ создаётся в ней и в кэш не
 * попадает — откат не оставит в памяти ключ, которого нет в базе. Уже закэшированный ключ берётся и так.
 */
export async function currentChatKey(chatId: number, tx?: Tx): Promise<ChatKey> {
  const c = current.get(chatId);
  if (c && Date.now() - c.at < TTL_MS) {
    const key = cached(chatId, c.version);
    if (key) return { version: c.version, key };
  }
  if (tx) {
    let [row] = await tx`select version, wrapped_dek, kek_id from keys.chat_keys where chat_id = ${chatId} and expires_at is null order by version desc limit 1`;
    if (!row) {
      const kms = getKms();
      const wrapped = await wrapFor(kms, chatCtx(chatId), randomKey());
      [row] = await tx`insert into keys.chat_keys (chat_id, version, wrapped_dek, kek_id, bound) values (${chatId}, 1, ${Buffer.from(wrapped)}, ${kms.id}, true)
        on conflict (chat_id, version) do update set chat_id = excluded.chat_id returning version, wrapped_dek, kek_id`;
    }
    return { version: row.version as number, key: await importAesKey(await unwrapFor(chatCtx(chatId), row.wrapped_dek as Uint8Array, row.kek_id as string)) };
  }
  return once(`c:${chatId}`, async () => {
    let [row] = await sql`select version, wrapped_dek, kek_id from keys.chat_keys where chat_id = ${chatId} and expires_at is null order by version desc limit 1`;
    if (!row) {
      const kms = getKms();
      const wrapped = await wrapFor(kms, chatCtx(chatId), randomKey());
      // параллельный процесс мог создать раньше — тогда берём его ключ
      await sql`insert into keys.chat_keys (chat_id, version, wrapped_dek, kek_id, bound) values (${chatId}, 1, ${Buffer.from(wrapped)}, ${kms.id}, true) on conflict do nothing`;
      [row] = await sql`select version, wrapped_dek, kek_id from keys.chat_keys where chat_id = ${chatId} and expires_at is null order by version desc limit 1`;
      if (!row) throw new CryptoError('no_key', `chat ${chatId} is gone`);
    }
    const version = row.version as number;
    const key = cached(chatId, version) ?? await unwrapRow(chatId, version, row.wrapped_dek as Uint8Array, row.kek_id as string);
    current.set(chatId, { version, at: Date.now() });
    return { version, key };
  });
}

/** Корзина срочного ключа — сутки: ключ живёт не дольше суток после срока своих сообщений, а ключей у чата — по дню срока. */
export const EXPIRY_BUCKET_MS = 24 * 3600_000;
export const expiryBucket = (at: number): number => Math.ceil(at / EXPIRY_BUCKET_MS) * EXPIRY_BUCKET_MS;

/**
 * Срочный ключ: для сообщений со сроком expiresAt (автоудаление, domain/autoDelete.ts). Номер версии лежит в шифре, поэтому
 * чтение идёт обычным chatKey. Как и в currentChatKey: с tx создаётся в транзакции и в кэш не идёт, без tx — кэшируется
 * (sendMessage греет его до транзакции: внутри неё он берётся из памяти, без вызова KMS на каждое сообщение).
 */
export async function expiringChatKey(chatId: number, expiresAt: Date | number, tx?: Tx): Promise<ChatKey> {
  const end = expiryBucket(+expiresAt), id = chatId + ':' + end, c = expiring.get(id);
  if (c && Date.now() - c.at < TTL_MS) {
    const key = cached(chatId, c.version);
    if (key) return { version: c.version, key };
  }
  const load = async (db: Tx | typeof sql) => {
    const at = new Date(end);
    let [row] = await db`select version, wrapped_dek, kek_id from keys.chat_keys where chat_id = ${chatId} and expires_at = ${at}`;
    if (!row) {
      const kms = getKms();
      const wrapped = await wrapFor(kms, chatCtx(chatId), randomKey());
      // параллельная отправка могла создать раньше — тогда её ключ (пропущенный номер последовательности не мешает)
      await db`insert into keys.chat_keys (chat_id, version, wrapped_dek, kek_id, bound, expires_at)
               values (${chatId}, nextval('keys.expiring_key_version'), ${Buffer.from(wrapped)}, ${kms.id}, true, ${at})
               on conflict (chat_id, expires_at) where expires_at is not null do nothing`;
      [row] = await db`select version, wrapped_dek, kek_id from keys.chat_keys where chat_id = ${chatId} and expires_at = ${at}`;
      if (!row) throw new CryptoError('no_key', `chat ${chatId} is gone`);
    }
    return row;
  };
  if (tx) {
    const row = await load(tx);
    return { version: row.version as number, key: await importAesKey(await unwrapFor(chatCtx(chatId), row.wrapped_dek as Uint8Array, row.kek_id as string)) };
  }
  return once(`e:${id}`, async () => {
    const row = await load(sql), version = row.version as number;
    const key = cached(chatId, version) ?? await unwrapRow(chatId, version, row.wrapped_dek as Uint8Array, row.kek_id as string);
    expiring.set(id, { version, at: Date.now() });
    return { version, key };
  });
}

/** Новая версия ключа чата: новые записи — им, старые читаются своими версиями. tx — в транзакции вызывающего. */
export async function rotateChatKey(chatId: number, tx?: Tx): Promise<number> {
  const kms = getKms();
  const wrapped = await wrapFor(kms, chatCtx(chatId), randomKey());
  const db = tx ?? sql;
  const [row] = await db`
    insert into keys.chat_keys (chat_id, version, wrapped_dek, kek_id, bound)
    select ${chatId}, coalesce(max(version), 0) + 1, ${Buffer.from(wrapped)}, ${kms.id}, true from keys.chat_keys where chat_id = ${chatId} and expires_at is null
    returning version`;
  current.delete(chatId);
  return row.version as number;
}

/**
 * Уничтожить прошлое чата (crypto-shredding): новая версия ключа для того, что будет дальше, все прежние версии
 * удаляются — всё, что ими запечатано, не открыть больше нигде: ни в базе, ни в бэкапах данных (бэкапы ключей
 * хранятся коротко). Другие процессы забывают ключи по NOTIFY chat_keys (keyEvents.ts).
 */
export async function shredChatHistory(tx: Tx, chatId: number): Promise<number> {
  const version = await rotateChatKey(chatId, tx);
  await tx`delete from keys.chat_keys where chat_id = ${chatId} and version <> ${version}`;   // и срочные (их номера выше)
  forgetChat(chatId);
  return version;
}

/** Забыть ключи чата в памяти этого процесса (чат удалён — ключ уничтожен). */
export function forgetChat(chatId: number): void {
  current.delete(chatId);
  for (const k of [...keys.keys()]) if (k.startsWith(chatId + ':')) keys.delete(k);
  for (const k of [...expiring.keys()]) if (k.startsWith(chatId + ':')) expiring.delete(k);
}
/** Тесты: очистить кэш. */
export function resetChatKeyCache(): void { keys.clear(); current.clear(); expiring.clear(); }
