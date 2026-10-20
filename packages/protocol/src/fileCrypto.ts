// Формат зашифрованного файла вложения (v1). Один и тот же код — в браузере (движок, Service Worker, страница),
// в воркере сервера (обработка видео и фото) и в тестах. Только WebCrypto: AES-256-GCM и HKDF-SHA256.
//
//   заголовок 24 байта: 'RLF1' | размер куска (uint32 BE) | исходный размер (uint64 BE) | основа nonce (8 байт)
//   куски: AES-256-GCM(кусок открытого текста), nonce = основа ‖ номер куска (uint32 BE),
//          AAD = «relay-file|<номер>|<1 — последний, 0 — нет>» → длина куска + 16 байт тега
//
// Номер в nonce и AAD — куски нельзя переставить; признак «последний» — файл нельзя незаметно обрезать.
// Основа nonce случайна у каждого объекта: один ключ файла можно использовать для перепакованного оригинала,
// не повторяя nonce. Копии (превью, 720p) шифруются ключами, выведенными из ключа файла (variantKey).

export const FILE_MAGIC = 'RLF1';
export const FILE_HEADER = 24;
export const FILE_CHUNK = 512 * 1024;
export const FILE_TAG = 16;

const enc = new TextEncoder();
const aadFor = (i: number, last: boolean) => enc.encode(`relay-file|${i}|${last ? 1 : 0}`);
const iv = (base: Uint8Array, i: number) => { const v = new Uint8Array(12); v.set(base, 0); new DataView(v.buffer).setUint32(8, i); return v; };

/** Сколько кусков у файла этого размера (у пустого — один пустой кусок: признак «последний» есть всегда). */
export const chunkCount = (size: number, chunk = FILE_CHUNK) => Math.max(1, Math.ceil(size / chunk));
/** Размер объекта в хранилище для исходного размера. */
export const encryptedSize = (size: number, chunk = FILE_CHUNK) => FILE_HEADER + size + FILE_TAG * chunkCount(size, chunk);

export interface FileHeader { chunk: number; size: number; base: Uint8Array }

export function writeHeader(h: FileHeader): Uint8Array {
  const out = new Uint8Array(FILE_HEADER);
  out.set(enc.encode(FILE_MAGIC), 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, h.chunk);
  dv.setBigUint64(8, BigInt(h.size));
  out.set(h.base, 16);
  return out;
}

/** Заголовок или null — не наш формат (файл до шифрования). */
export function readHeader(b: Uint8Array): FileHeader | null {
  if (b.length < FILE_HEADER || new TextDecoder().decode(b.subarray(0, 4)) !== FILE_MAGIC) return null;
  const dv = new DataView(b.buffer, b.byteOffset, FILE_HEADER);
  return { chunk: dv.getUint32(4), size: Number(dv.getBigUint64(8)), base: b.slice(16, 24) };
}

export const importFileKey = (raw: Uint8Array): Promise<CryptoKey> => crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
export const newFileKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
export const newNonceBase = (): Uint8Array => crypto.getRandomValues(new Uint8Array(8));

/** Ключ копии (preview, 720…) из ключа файла: HKDF — копии не хранят своих ключей. */
export async function variantKey(fileKey: Uint8Array, name: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', fileKey as BufferSource, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`relay-file-variant|${name}`) }, k, 256));
}

/** Кусок i шифром (детерминированно при тех же ключе и основе: повтор загрузки части даёт те же байты). */
export async function sealChunk(key: CryptoKey, h: FileHeader, i: number, plain: Uint8Array): Promise<Uint8Array> {
  const last = i === chunkCount(h.size, h.chunk) - 1;
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv(h.base, i), additionalData: aadFor(i, last) }, key, plain as BufferSource));
}

export async function openChunk(key: CryptoKey, h: FileHeader, i: number, sealed: Uint8Array): Promise<Uint8Array> {
  const last = i === chunkCount(h.size, h.chunk) - 1;
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv(h.base, i), additionalData: aadFor(i, last) }, key, sealed as BufferSource));
  } catch {
    throw new Error(`file chunk ${i}: wrong key or damaged data`);
  }
}

/** Где в объекте лежит кусок i шифром: [начало, конец) байт. */
export function sealedRange(h: Pick<FileHeader, 'chunk' | 'size'>, i: number): [number, number] {
  const start = FILE_HEADER + i * (h.chunk + FILE_TAG);
  const plainLen = Math.min(h.chunk, h.size - i * h.chunk);
  return [start, start + Math.max(0, plainLen) + FILE_TAG];
}

/**
 * Источник шифра для загрузки: байты [a, b) объекта, не читая весь файл — только задетые куски
 * (части multipart режутся по любым границам). size — размер объекта.
 */
export interface SealedSource { size: number; slice(a: number, b: number): Promise<Blob> }

export function sealedSource(file: Blob, key: CryptoKey, h: FileHeader): SealedSource {
  const size = encryptedSize(h.size, h.chunk);
  const head = writeHeader(h);
  const piece = async (i: number) => sealChunk(key, h, i, new Uint8Array(await file.slice(i * h.chunk, Math.min(h.size, (i + 1) * h.chunk)).arrayBuffer()));
  return {
    size,
    async slice(a: number, b: number): Promise<Blob> {
      b = Math.min(b, size);
      const parts: BlobPart[] = [];
      if (a < FILE_HEADER) parts.push(head.slice(a, Math.min(b, FILE_HEADER)));
      const per = h.chunk + FILE_TAG;
      const from = Math.max(0, Math.floor((Math.max(a, FILE_HEADER) - FILE_HEADER) / per));
      for (let i = from; i < chunkCount(h.size, h.chunk); i++) {
        const [s, e] = sealedRange(h, i);
        if (s >= b) break;
        const c = await piece(i);
        parts.push(c.slice(Math.max(0, a - s), Math.min(c.length, b - s)) as BlobPart);
        if (e >= b) break;
      }
      return new Blob(parts as BlobPart[]);
    },
  };
}

/** Зашифровать файл целиком (небольшие файлы, копии в воркере). */
export async function sealFile(file: Blob, key: CryptoKey, chunk = FILE_CHUNK): Promise<Blob> {
  const h = { chunk, size: file.size, base: newNonceBase() };
  return sealedSource(file, key, h).slice(0, encryptedSize(file.size, chunk));
}

/** Расшифровать объект целиком: по кускам (в памяти — текущий кусок и готовые). Не наш формат — вернуть как есть. */
export async function openFile(sealed: Blob, key: CryptoKey, type = ''): Promise<Blob> {
  const h = readHeader(new Uint8Array(await sealed.slice(0, FILE_HEADER).arrayBuffer()));
  if (!h) return sealed;
  const out: BlobPart[] = [];
  for (let i = 0; i < chunkCount(h.size, h.chunk); i++) {
    const [s, e] = sealedRange(h, i);
    out.push(await openChunk(key, h, i, new Uint8Array(await sealed.slice(s, e).arrayBuffer())) as BlobPart);
  }
  return new Blob(out, { type });
}

/** Какие куски нужны для байт [a, b] открытого текста (включительно) — для ответов на Range. */
export function chunksFor(h: Pick<FileHeader, 'chunk' | 'size'>, a: number, b: number): { first: number; last: number } {
  return { first: Math.floor(a / h.chunk), last: Math.min(chunkCount(h.size, h.chunk) - 1, Math.floor(b / h.chunk)) };
}

export const toBase64 = (b: Uint8Array): string => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
