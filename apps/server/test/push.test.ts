import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => { server.stop(true); push.stop(true); });
beforeEach(async () => { await resetDb(); got.length = 0; status = 201; });

// поддельный push-сервис: копит запросы, отвечает status
const got: { auth: string; encoding: string; body: Uint8Array }[] = [];
let status = 201;
const push = Bun.serve({ port: 0, async fetch(req) {
  got.push({ auth: req.headers.get('authorization') ?? '', encoding: req.headers.get('content-encoding') ?? '', body: new Uint8Array(await req.arrayBuffer()) });
  return new Response(null, { status });
} });
const endpoint = (n: number) => `http://localhost:${push.port}/ep/${n}`;

const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const enc = new TextEncoder();
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, n * 8));
}

/** Браузер: ключи подписки и расшифровка по RFC 8291. */
async function browser() {
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
      expect(plain[plain.length - 1]).toBe(2);
      return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
    },
  };
}

const waitFor = async (n: number) => { for (let i = 0; i < 50 && got.length < n; i++) await Bun.sleep(20); };

test('offline member gets an encrypted push signed with the VAPID key; sender and muted chats do not', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]), other = await makeChat([a, b, await makeUser('Вера')]);
  const br = await browser();
  const { subscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(1), keys: br.keys, muted: [other] });
  await subscribe(a, { endpoint: endpoint(2), keys: (await browser()).keys });

  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'привет' });
  await sendMessage(a, { chatId: other, clientId: crypto.randomUUID(), body: 'в заглушённый' });
  await waitFor(1); await Bun.sleep(100);
  expect(got.length).toBe(1);
  expect(got[0].encoding).toBe('aes128gcm');
  expect(await br.decrypt(got[0].body)).toEqual({ chatId: chat, id: message.id, title: 'Анна', body: 'привет' });

  // подпись JWT проверяется публичным ключом из /push/key
  const { key } = await (await fetch(`${base}/push/key`)).json() as { key: string };
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(got[0].auth)!;
  expect(m[4]).toBe(key);
  const pub = await crypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(m[3], 'base64url'), enc.encode(`${m[1]}.${m[2]}`))).toBe(true);
  expect(JSON.parse(Buffer.from(m[2], 'base64url').toString()).aud).toBe(`http://localhost:${push.port}`);
});

test('gone subscription is forgotten; HTTP subscribe needs a session', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const { subscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(3), keys: (await browser()).keys });
  status = 410;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'x' });
  await waitFor(1); await Bun.sleep(100);
  expect((await sql`select count(*)::int as n from push_subscriptions`)[0].n).toBe(0);
  expect((await fetch(`${base}/push/subscription`, { method: 'POST', body: JSON.stringify({ endpoint: endpoint(4), keys: { p256dh: 'x', auth: 'y' } }) })).status).toBe(401);
});
