// Ключи файлов, зашифрованных на клиенте: клиент создаёт ключ и присылает его при заявке на загрузку, сервер хранит
// его завёрнутым KMS (keys.attachment_keys). Нужен серверу для двух вещей: отдать ключ в сообщении (там он запечатан
// ключом чата) и обработать файл в воркере (превью, перепаковка видео). Хранилище файлов видит только шифр.
import { encryptedSize, FILE_CHUNK, FILE_HEADER, chunkCount, importFileKey, newNonceBase, openChunk, readHeader, sealChunk, sealedRange, writeHeader } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { CryptoError, importAesKey, open, seal } from './aead';
import { getKms } from './kms';
import { fileCtx, unwrapFor, wrapFor } from './keyBinding';

const TTL_MS = 10 * 60_000, MAX = 2000;
const keys = new Map<string, { raw: Uint8Array; at: number }>();

export async function storeFileKey(db: Tx | typeof sql, attachmentId: string, raw: Uint8Array): Promise<void> {
  const kms = getKms();
  await db`insert into keys.attachment_keys (attachment_id, wrapped, kek_id, bound) values (${attachmentId}, ${Buffer.from(await wrapFor(kms, fileCtx(attachmentId), raw))}, ${kms.id}, true)
           on conflict (attachment_id) do nothing`;
}

/** Ключ файла (сырые 32 байта) или null — файл не шифровался или ключ уничтожен. */
export async function fileKey(attachmentId: string, db: Tx | typeof sql = sql): Promise<Uint8Array | null> {
  const e = keys.get(attachmentId);
  if (e && Date.now() - e.at < TTL_MS) return e.raw;
  const [row] = await db`select wrapped, kek_id from keys.attachment_keys where attachment_id = ${attachmentId}`;
  if (!row) return null;
  const raw = await unwrapFor(fileCtx(attachmentId), row.wrapped as Uint8Array, row.kek_id as string);
  if (db === sql) { keys.set(attachmentId, { raw, at: Date.now() }); if (keys.size > MAX) keys.delete(keys.keys().next().value!); }
  return raw;
}
export function forgetFile(attachmentId: string): void { keys.delete(attachmentId); }
export function resetFileKeyCache(): void { keys.clear(); }

/* ---------- имя, название, исполнитель — шифром ключа файла ---------- */

const metaAad = (id: string) => `attachments|${id}|meta`;
export type FileMeta = { name: string; title: string | null; performer: string | null };

export async function sealMeta(attachmentId: string, raw: Uint8Array, m: FileMeta): Promise<Buffer> {
  return Buffer.from(await seal(await importAesKey(raw), 0, JSON.stringify(m), metaAad(attachmentId)));
}

/** Открыть строки attachments на месте: name/title/performer из meta (ключ файла). */
export async function openAttachmentRows<T extends Record<string, unknown>>(rows: T[], db: Tx | typeof sql = sql): Promise<T[]> {
  await Promise.all(rows.map(async (r) => {
    if (!r.meta) return;
    const id = r.id as string;
    const raw = await fileKey(id, db);
    const row = r as Record<string, unknown>;
    if (!raw) { row.name = 'file'; return; }
    try {
      const m = JSON.parse(await open(await importAesKey(raw), new Uint8Array(r.meta as Uint8Array), metaAad(id))) as FileMeta;
      row.name = m.name; row.title = m.title; row.performer = m.performer;
    } catch (e) { if (!(e instanceof CryptoError)) throw e; row.name = 'file'; }
  }));
  return rows;
}

/* ---------- файлы на диске воркера: потоково, без чтения целиком в память ---------- */

/** Расшифровать объект (файл src) в dst. Не наш формат — просто копия. */
export async function decryptFile(src: string, dst: string, raw: Uint8Array): Promise<void> {
  const f = Bun.file(src);
  const h = readHeader(new Uint8Array(await f.slice(0, FILE_HEADER).arrayBuffer()));
  if (!h) { await Bun.write(dst, f); return; }
  const key = await importFileKey(raw);
  const w = Bun.file(dst).writer();
  try {
    for (let i = 0; i < chunkCount(h.size, h.chunk); i++) {
      const [s, e] = sealedRange(h, i);
      w.write(await openChunk(key, h, i, new Uint8Array(await f.slice(s, e).arrayBuffer())));
      await w.flush();
    }
  } finally { await w.end(); }
}

/** Зашифровать файл src в dst ключом raw (новая основа nonce). Возвращает размер объекта. */
export async function encryptFile(src: string, dst: string, raw: Uint8Array, chunk = FILE_CHUNK): Promise<number> {
  const f = Bun.file(src);
  const h = { chunk, size: f.size, base: newNonceBase() };
  const key = await importFileKey(raw);
  const w = Bun.file(dst).writer();
  try {
    w.write(writeHeader(h));
    for (let i = 0; i < chunkCount(h.size, h.chunk); i++) {
      w.write(await sealChunk(key, h, i, new Uint8Array(await f.slice(i * chunk, Math.min(h.size, (i + 1) * chunk)).arrayBuffer())));
      await w.flush();
    }
  } finally { await w.end(); }
  return encryptedSize(h.size, chunk);
}
