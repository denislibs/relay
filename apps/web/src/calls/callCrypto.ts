/**
 * Ключи звонка (docs/plans/2026-11-06-relay-calls.md, «Протокол ключей»). Сервер Relay — недоверенный почтальон:
 *
 *  1. звонящий: эфемерная пара A, на сервер — только обязательство commit = SHA-256(«relay-call-commit» ‖ callId ‖ pubA);
 *  2. адресат (ответил): эфемерная пара B, отдаёт pubB;
 *  3. звонящий раскрывает pubA, адресат сверяет с обязательством — подобрать ключ под эмодзи посредник не успеет;
 *  4. оба: ECDH(A, B) → HKDF с солью «стенограмма» (callId, участники, commit, оба ключа) → ключ сигналинга на каждое
 *     направление и ключ эмодзи.
 *
 * Сигналинг — AES-256-GCM: IV из номера пакета (ключ своего направления — номер не повторится), AAD — звонок,
 * направление и номер; повтор и слишком старый номер — отказ. Ключи неэкспортируемые, живут один звонок.
 * Кривая — P-256: ECDH на ней есть во всех браузерах (X25519 — не везде, а договариваться о кривой пришлось бы
 * до того, как адресат увидит ключ звонящего).
 */

const enc = new TextEncoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const REPLAY_WINDOW = 64;

export type Role = 'caller' | 'callee';

const b64u = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64u = (s: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
};
export { b64u as toB64u };

const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

/** Части без двусмысленности склейки: каждая — с длиной впереди. */
function framed(parts: (string | Uint8Array)[]): Uint8Array {
  const bytes = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
  const out = new Uint8Array(bytes.reduce((n, b) => n + 4 + b.length, 0));
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const b of bytes) { dv.setUint32(o, b.length); out.set(b, o + 4); o += 4 + b.length; }
  return out;
}

export interface Ephemeral { priv: CryptoKey; pub: string }

/** Эфемерная пара на звонок: закрытый ключ неэкспортируемый. */
export async function ephemeral(): Promise<Ephemeral> {
  const pair = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']) as CryptoKeyPair;
  return { priv: pair.privateKey, pub: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))) };
}

/** Обязательство звонящего на свой ключ. */
export async function commitOf(callId: string, pubA: string): Promise<string> {
  return b64u(await sha256(framed(['relay-call-commit', callId, pubA])));
}

export interface Session {
  /** 4 эмодзи — одинаковые у обоих, если посредника нет */
  emoji: string[];
  seal(msg: unknown): Promise<string>;
  /** null — подделка, повтор или чужое направление */
  open(data: string): Promise<unknown | null>;
}

export class CallCryptoError extends Error {}

/**
 * Общий ключ звонка. Адресат передаёт commit с сервера и pubA из callConfirm: несовпадение — CallCryptoError
 * (сервер подменил ключ). Неверная точка кривой — тоже ошибка (WebCrypto проверяет при импорте).
 */
export async function deriveSession(p: { role: Role; callId: string; caller: number; callee: number; commit: string; pubA: string; pubB: string; mine: Ephemeral }): Promise<Session> {
  if ((await commitOf(p.callId, p.pubA)) !== p.commit) throw new CallCryptoError('commit mismatch');
  const theirs = p.role === 'caller' ? p.pubB : p.pubA;
  if ((p.role === 'caller' ? p.pubA : p.pubB) !== p.mine.pub) throw new CallCryptoError('own key mismatch');
  const raw = fromB64u(theirs);
  if (!raw || raw.length !== 65) throw new CallCryptoError('bad peer key');
  let peer: CryptoKey;
  try { peer = await crypto.subtle.importKey('raw', raw, ECDH, false, []); } catch { throw new CallCryptoError('bad peer key'); }
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, p.mine.priv, 256));
  const transcript = await sha256(framed(['relay-call-v1', p.callId, String(p.caller), String(p.callee), p.commit, p.pubA, p.pubB]));
  const ikm = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey', 'deriveBits']);
  secret.fill(0);
  const aes = (info: string) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: transcript, info: enc.encode(info) }, ikm,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const [toCallee, toCaller] = await Promise.all([aes('relay-call caller->callee'), aes('relay-call callee->caller')]);
  const sas = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: transcript, info: enc.encode('relay-call emoji') }, ikm, 256));

  const outKey = p.role === 'caller' ? toCallee : toCaller, inKey = p.role === 'caller' ? toCaller : toCallee;
  const outDir = p.role === 'caller' ? 'c2a' : 'a2c', inDir = p.role === 'caller' ? 'a2c' : 'c2a';
  let sent = 0, top = 0;
  const seen = new Set<number>();
  const iv = (seq: number) => { const b = new Uint8Array(12); new DataView(b.buffer).setBigUint64(4, BigInt(seq)); return b; };
  const aad = (dir: string, seq: number) => framed([p.callId, dir, String(seq)]);

  return {
    emoji: emojiOf(sas),
    async seal(msg) {
      const seq = ++sent;
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv(seq), additionalData: aad(outDir, seq) }, outKey, enc.encode(JSON.stringify(msg))));
      const out = new Uint8Array(8 + ct.length);
      new DataView(out.buffer).setBigUint64(0, BigInt(seq));
      out.set(ct, 8);
      return b64u(out);
    },
    async open(data) {
      const b = fromB64u(data);
      if (!b || b.length < 8 + 16) return null;
      const seq = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(0));
      if (!Number.isSafeInteger(seq) || seq < 1 || seen.has(seq) || seq <= top - REPLAY_WINDOW) return null;
      let plain: Uint8Array;
      try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv(seq), additionalData: aad(inDir, seq) }, inKey, b.subarray(8))); }
      catch { return null; }
      seen.add(seq);
      if (seq > top) { top = seq; for (const s of seen) if (s <= top - REPLAY_WINDOW) seen.delete(s); }
      try { return JSON.parse(new TextDecoder().decode(plain)); } catch { return null; }
    },
  };
}

/**
 * Таблица эмодзи для сверки: 256 простых, хорошо различимых и есть во всех системных шрифтах (без флагов, тонов
 * кожи и составных). 4 эмодзи по 8 бит — 2³² вариантов; посредник получает одну попытку (обязательство), так что
 * шанс совпасть случайно — 1 к 4 млрд.
 */
export const EMOJI = [...
  '🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🐔🐧🐦🐤🦆🦅🦉🦇🐺🐗🐴🦄🐝🐛🦋🐌🐞🐜🦗🕷🦂🐢🐍🦎🦖🦕🐙🦑🦐🦞🦀🐡🐠🐟🐬🐳🐋🦈🐊🐅🐆🦓🦍🐘🦛🦏🐪🐫🦒🦘🐃🐂🐄🐎🐖🐏🐑🦙🐐🦌🐕🐩🐈🐓🦃🦚🦜🦢🦩🕊🐇🦝🦨🦡🦦🦥🐁🐀🐿🦔🌵🎄🌲🌳🌴🌱🌿🍀🍁🍄🌷🌹🌻🌼🌸🌺🌎🌙⭐🌞🌈🔥💧🌊⛄❄🍏🍎🍐🍊🍋🍌🍉🍇🍓🍈🍒🍑🥭🍍🥥🥝🍅🍆🥑🥦🥕🌽🌶🥔🥐🍞🥨🧀🥚🥞🥓🍗🍔🍟🍕🌭🥪🌮🌯🍝🍜🍲🍣🍤🍙🍚🍦🍩🍪🎂🍰🧁🍫🍬🍭🍯☕🍵🍺🍷🥤⚽🏀🏈⚾🎾🏐🏉🎱🏓🏸🥊🎯🎳⛳🛹🎿🛷🥌🎣🎲🧩🎮🎹🥁🎷🎺🎸🎻🎤🎧🎨🎬🚗🚕🚌🚎🚓🚑🚒🚜🚲🛴🛵🏍🚂✈🚀🛸🚁⛵🚤⚓🏠🏰🗽🗼🎡🎢⛺🌋💡🔦📷📺📻⏰⌛📱💻⌨🖨🔑🔒🔔📚✏📌📎✂🧲🧪🔭🔬💊🧸🎁🎈🎀👑💎🧭🪁🛶'
].slice(0, 256);

function emojiOf(sas: Uint8Array): string[] {
  return [0, 1, 2, 3].map((i) => EMOJI[sas[i] % EMOJI.length]);
}
