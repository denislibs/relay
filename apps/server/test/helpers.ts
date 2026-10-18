import { sql } from '../src/db';
import { settlePushes } from '../src/domain/push';

export async function resetDb(): Promise<void> {
  // push в фоне из прошлого теста не должен столкнуться с truncate (deadlock)
  await settlePushes();
  await sql`truncate sessions, chats, chat_members, messages, user_seq, updates restart identity cascade`;
  // системного пользователя «Relay» (миграция 108) не трогаем
  await sql`delete from users where not system`;
  // engine-тесты делают truncate users на общей базе и стирают строку миграции 108 — вернуть, если пропала
  await sql`insert into users (name, system) select 'Relay', true where not exists (select 1 from users where system)`;
}

export async function makeUser(name = 'user'): Promise<number> {
  const [row] = await sql`insert into users (name) values (${name}) returning id`;
  return row.id as number;
}

import { createChat } from '../src/domain/chats';

export function makeChat(memberIds: number[], kind: 'direct' | 'group' = memberIds.length > 2 ? 'group' : 'direct'): Promise<number> {
  return createChat(kind, kind === 'group' ? 'Группа' : null, memberIds);
}

import type { ServerFrame } from '@relay/protocol';

/** Ждёт первый кадр, удовлетворяющий условию. */
export function nextFrame(ws: WebSocket, match: (f: ServerFrame) => boolean, timeoutMs = 3000): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', on); reject(new Error('timeout waiting for frame')); }, timeoutMs);
    function on(e: MessageEvent) {
      const f = JSON.parse(String(e.data)) as ServerFrame;
      if (match(f)) { clearTimeout(timer); ws.removeEventListener('message', on); resolve(f); }
    }
    ws.addEventListener('message', on);
  });
}

// ---- «браузер» для Web Push: ключи подписки и расшифровка по RFC 8291 ----
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const enc = new TextEncoder();
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, n * 8));
}
export async function pushBrowser() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys: { p256dh: b64u(pub), auth: b64u(auth) },
    async decrypt(body: Uint8Array) {
      const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), rec = body.slice(21 + idlen);
      const as = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, pair.privateKey, 256));
      const ikm = await hkdf(auth, shared, cat(enc.encode('WebPush: info\0'), pub, asPub), 32);
      const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, rec));
      return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
    },
  };
}
