import { EMOJI, fromB64u, toB64u, type Ephemeral } from './callCrypto';

/**
 * Ключи группового звонка (docs/plans/2026-11-07-relay-group-calls.md, «Ключи»). У каждого участника — эфемерная
 * пара ECDH P-256 на звонок (pub уходит в состав через сервер). Кто говорит, тот на каждую эпоху создаёт случайный
 * ключ отправителя и раздаёт его каждому участнику отдельно: ECDH(мой, его) → HKDF (соль — звонок, эпоха, от кого,
 * кому) → AES-GCM. Сервер пересылает шифротекст и прочитать его не может. Эмодзи — по открытым ключам всех участников.
 */

const enc = new TextEncoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** Случайный ключ отправителя на эпоху (16 байт — ключ шифрования кадров LiveKit 128 бит выводится из него HKDF). */
export const senderKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

const pairCache = new Map<string, Promise<CryptoKey>>();

/** Общий секрет пары (мой закрытый, его открытый) → ключ для «от from к to» в эпохе epoch. */
async function pairKey(mine: Ephemeral, theirPub: string, info: string): Promise<CryptoKey> {
  const k = mine.pub + '|' + theirPub + '|' + info;   // своя пара — тоже в ключе кэша: другой участник получил бы чужой ключ
  let p = pairCache.get(k);
  if (!p) {
    p = (async () => {
      const raw = fromB64u(theirPub);
      if (!raw || raw.length !== 65) throw new Error('bad peer key');
      const peer = await crypto.subtle.importKey('raw', raw, ECDH, false, []);
      const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, mine.priv, 256);
      const ikm = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('relay-gcall-v1'), info: enc.encode(info) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    })();
    pairCache.set(k, p);
    if (pairCache.size > 2000) pairCache.clear();
    p.catch(() => pairCache.delete(k));
  }
  return p;
}

const infoOf = (callId: string, epoch: number, from: number, to: number) => `${callId}|${epoch}|${from}>${to}`;

/** Зашифровать свой ключ отправителя для участника (to — его сессия, theirPub — его открытый ключ). */
export async function sealSenderKey(p: { mine: Ephemeral; theirPub: string; callId: string; epoch: number; from: number; to: number; key: Uint8Array }): Promise<string> {
  const k = await pairKey(p.mine, p.theirPub, infoOf(p.callId, p.epoch, p.from, p.to));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(infoOf(p.callId, p.epoch, p.from, p.to)) }, k, p.key));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return toB64u(out);
}

/** Расшифровать ключ отправителя from (его открытый ключ — из состава). null — подделка или чужой адресат. */
export async function openSenderKey(p: { mine: Ephemeral; theirPub: string; callId: string; epoch: number; from: number; to: number; data: string }): Promise<Uint8Array | null> {
  const b = fromB64u(p.data);
  if (!b || b.length < 12 + 16 + 16) return null;
  try {
    const k = await pairKey(p.mine, p.theirPub, infoOf(p.callId, p.epoch, p.from, p.to));
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: enc.encode(infoOf(p.callId, p.epoch, p.from, p.to)) }, k, b.subarray(12)));
  } catch { return null; }
}

/** 4 эмодзи состава: одинаковые у всех, если сервер никому не подменил открытый ключ. */
export async function membersEmoji(callId: string, members: { session: number; pub: string }[]): Promise<string[]> {
  const list = [...members].sort((a, b) => a.session - b.session).map((m) => `${m.session}:${m.pub}`).join('\n');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('relay-gcall-emoji|' + callId + '\n' + list)));
  return [0, 1, 2, 3].map((i) => EMOJI[h[i] % EMOJI.length] + '️');
}

/**
 * Реакции и чат звонка — каналом данных LiveKit, шифром на ключе отправителя текущей эпохи (тот же, что у кадров, но
 * через HKDF со своей меткой: ключ кадров и ключ сообщений не совпадают). SFU видит только шифротекст и размер.
 * AAD — звонок, эпоха и идентичность отправителя: чужое сообщение не выдать за своё и не переиграть в другой эпохе.
 */
async function dataKey(raw: Uint8Array, aad: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('relay-gcall-data-v1'), info: enc.encode(aad) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const dataAad = (callId: string, epoch: number, identity: string) => `${callId}|${epoch}|${identity}`;

export async function sealData(raw: Uint8Array, p: { callId: string; epoch: number; identity: string }, msg: unknown): Promise<Uint8Array> {
  const aad = dataAad(p.callId, p.epoch, p.identity);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await dataKey(raw, aad), enc.encode(JSON.stringify(msg))));
  return enc.encode(JSON.stringify({ v: 1, e: p.epoch, n: toB64u(iv), c: toB64u(ct) }));
}

/** Эпоха конверта (какой ключ отправителя брать) — до расшифровки; null — не наш конверт. */
export function dataEpoch(bytes: Uint8Array): number | null {
  try { const o = JSON.parse(new TextDecoder().decode(bytes)) as { v?: number; e?: unknown }; return o.v === 1 && Number.isInteger(o.e) ? (o.e as number) : null; } catch { return null; }
}

export async function openData(raw: Uint8Array, p: { callId: string; identity: string }, bytes: Uint8Array): Promise<unknown | null> {
  try {
    const o = JSON.parse(new TextDecoder().decode(bytes)) as { v: number; e: number; n: string; c: string };
    const iv = fromB64u(o.n), ct = fromB64u(o.c);
    if (o.v !== 1 || !iv || !ct || iv.length !== 12) return null;
    const aad = dataAad(p.callId, o.e, p.identity);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(aad) }, await dataKey(raw, aad), ct as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { return null; }
}
