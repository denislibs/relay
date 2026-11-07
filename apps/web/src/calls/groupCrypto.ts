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
