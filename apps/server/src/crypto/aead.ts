// Шифр поля в базе: AES-256-GCM, самоописываемый формат —
//   [1 байт версия формата][4 байта версия ключа чата, big-endian][12 байт nonce][шифртекст + тег 16 байт]
// AAD (проверяется, но не шифруется) привязывает шифр к месту: «таблица|чат|строка|поле». Переставить шифр
// в чужую строку или поле нельзя — open не пройдёт. Никакой своей криптографии: только WebCrypto.

export const FORMAT = 1;
const HEAD = 1 + 4 + 12;
const enc = new TextEncoder(), dec = new TextDecoder();

export class CryptoError extends Error {
  constructor(public code: 'bad_format' | 'bad_key' | 'tampered' | 'no_key', message?: string) { super(message ?? code); }
}

export async function seal(key: CryptoKey, version: number, plaintext: string | Uint8Array, aad: string): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const data = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(aad) }, key, data));
  const out = new Uint8Array(HEAD + ct.length);
  out[0] = FORMAT;
  new DataView(out.buffer).setUint32(1, version);
  out.set(nonce, 5);
  out.set(ct, HEAD);
  return out;
}

/** Версия ключа чата, которым запечатано (чтобы взять нужный ключ до расшифровки). */
export function keyVersionOf(sealed: Uint8Array): number {
  if (sealed.length < HEAD + 16 || sealed[0] !== FORMAT) throw new CryptoError('bad_format');
  return new DataView(sealed.buffer, sealed.byteOffset).getUint32(1);
}

export async function openBytes(key: CryptoKey, sealed: Uint8Array, aad: string): Promise<Uint8Array> {
  keyVersionOf(sealed);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(5, HEAD), additionalData: enc.encode(aad) }, key, sealed.subarray(HEAD)));
  } catch {
    throw new CryptoError('tampered', 'decryption failed: wrong key, wrong place or damaged data');
  }
}

export async function open(key: CryptoKey, sealed: Uint8Array, aad: string): Promise<string> {
  return dec.decode(await openBytes(key, sealed, aad));
}

export const importAesKey = (raw: Uint8Array, usages: KeyUsage[] = ['encrypt', 'decrypt']) =>
  crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages);

export const randomKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
