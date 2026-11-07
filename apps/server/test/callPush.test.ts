import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { expireRing } from '../src/domain/calls';
import '../src/jobs/kinds';
import { drainJobs } from '../src/jobs/worker';
import { nextFrame, resetDb } from './helpers';

// звонок адресату без открытых вкладок доходит пушем; конец звонка — тоже (закрыть уведомление / «пропущенный»);
// «Отклонить» из уведомления — HTTP, только адресатом
const s = createServer({ port: 0 });
const base = `http://localhost:${s.port}`;
const got: { body: Uint8Array; ttl: string }[] = [];
const pushSrv = Bun.serve({ port: 0, async fetch(req) { got.push({ body: new Uint8Array(await req.arrayBuffer()), ttl: req.headers.get('ttl') ?? '' }); return new Response(null, { status: 201 }); } });
afterAll(() => { s.stop(true); pushSrv.stop(true); });
beforeEach(async () => { await resetDb(); got.length = 0; });

type Login = { userId: number; token: string };
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as Login;
const cookie = (l: Login) => ({ cookie: `relay_session=${l.token}` });
async function connect(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${s.port}/ws?token=${token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ op: 'hello', lastSeq: 0 }));
  await nextFrame(ws, (f) => f.op === 'hello');
  return ws;
}
let n = 0;
async function call(ws: WebSocket, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqId = 'p' + ++n;
  const got = nextFrame(ws, (f) => (f.op === 'ack' || f.op === 'err') && f.reqId === reqId);
  ws.send(JSON.stringify({ ...frame, reqId }));
  const f = await got;
  if (f.op === 'err') throw new Error(f.code);
  return (f as { result: Record<string, unknown> }).result;
}

const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const enc = new TextEncoder();
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
/** Браузер адресата: подписка и расшифровка пуша (RFC 8291). */
async function subscribed(l: Login, i: number, hideText = false) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const r = await fetch(`${base}/push/subscription`, { method: 'POST', headers: { ...cookie(l), 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: `http://localhost:${pushSrv.port}/ep/${i}`, keys: { p256dh: b64u(pub), auth: b64u(auth) }, hideText }) });
  expect(r.ok).toBe(true);
  return async (body: Uint8Array) => {
    const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), rec = body.slice(21 + idlen);
    const as = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, pair.privateKey, 256));
    const ikm = await hkdf(auth, shared, cat(enc.encode('WebPush: info\0'), pub, asPub), 32);
    const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
    const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, rec));
    return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
  };
}
const direct = async (a: Login, b: Login) =>
  ((await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: cookie(a), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number }).id;
const COMMIT = 'c'.repeat(43);

test('callee without open tabs: ring push with «Принять/Отклонить» data, short TTL; missed → «Пропущенный звонок»', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await direct(a, b);
  const open = await subscribed(b, 1);
  const wa = await connect(a.token);
  const callId = crypto.randomUUID();
  expect(await call(wa, { op: 'callRequest', callId, chatId, video: true, commit: COMMIT, tab: 'tabaaaaa' })).toEqual({ ok: true });
  await drainJobs();
  expect(got.length).toBe(1);
  expect(Number(got[0].ttl)).toBeLessThanOrEqual(60);
  expect(await open(got[0].body)).toEqual({ chatId, id: 0, title: 'Анна', body: 'Входящий видеозвонок', call: { id: callId, video: true } });

  got.length = 0;
  await expireRing((t, m) => void [t, m], callId);
  await drainJobs();
  expect(got.length).toBe(1);
  expect(await open(got[0].body)).toMatchObject({ chatId, title: 'Анна', body: 'Пропущенный звонок', call: { id: callId, end: true, missed: true } });
  wa.close();
});

test('callee with an open tab gets no push; hideText hides the caller', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await direct(a, b);
  const open = await subscribed(b, 2, true);
  const wa = await connect(a.token);
  const wb = await connect(b.token);
  expect(await call(wa, { op: 'callRequest', callId: crypto.randomUUID(), chatId, video: false, commit: COMMIT, tab: 'tabaaaaa' })).toEqual({ ok: true });
  await drainJobs();
  expect(got.length).toBe(0);
  process.env.RELAY_PRESENCE_GRACE_MS = '50';   // пауза «перезагрузка вкладки» — короткая, иначе он ещё онлайн
  wb.close();
  await Bun.sleep(400);   // сокет закрыт — адресат офлайн
  delete process.env.RELAY_PRESENCE_GRACE_MS;

  const callId = crypto.randomUUID();
  const c = await login('Вера');
  const chat2 = await direct(c, b);
  const wc = await connect(c.token);
  expect(await call(wc, { op: 'callRequest', callId, chatId: chat2, video: false, commit: COMMIT, tab: 'tabccccc' })).toEqual({ ok: true });
  await drainJobs();
  expect(got.length).toBe(1);
  expect(await open(got[0].body)).toMatchObject({ title: 'Relay', body: 'Входящий звонок', call: { id: callId } });
  wa.close(); wc.close();
});

test('decline from the notification: only the callee, only while ringing; caller hears «declined», push closes the notification', async () => {
  const a = await login('Анна'), b = await login('Борис'), x = await login('Чужой');
  const chatId = await direct(a, b);
  const open = await subscribed(b, 3);
  const wa = await connect(a.token);
  const callId = crypto.randomUUID();
  await call(wa, { op: 'callRequest', callId, chatId, video: false, commit: COMMIT, tab: 'tabaaaaa' });
  await drainJobs();
  got.length = 0;

  const stranger = await fetch(`${base}/calls/${callId}/decline`, { method: 'POST', headers: cookie(x) });
  expect(await stranger.json()).toEqual({ ok: false });
  expect((await fetch(`${base}/calls/${callId}/decline`, { method: 'POST', headers: cookie(a) }).then((r) => r.json()))).toEqual({ ok: false });   // звонящий — не так

  const ended = nextFrame(wa, (f) => f.op === 'callEnded');
  const r = await fetch(`${base}/calls/${callId}/decline`, { method: 'POST', headers: cookie(b) });
  expect(await r.json()).toEqual({ ok: true });
  expect(await ended).toMatchObject({ op: 'callEnded', callId, reason: 'declined' });
  await drainJobs();
  expect(got.length).toBe(1);
  const p = await open(got[0].body);
  expect(p.call).toEqual({ id: callId, end: true });
  expect((await fetch(`${base}/calls/${callId}/decline`, { method: 'POST', headers: cookie(b) }).then((r) => r.json()))).toEqual({ ok: false });
  expect((await fetch(`${base}/calls/${callId}/decline`, { method: 'POST' })).status).toBe(401);
  wa.close();
});

test('answered on another device: the notification on push-only devices closes at once, the call end sends nothing more', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await direct(a, b);
  const open = await subscribed(b, 4);
  const wa = await connect(a.token);
  const callId = crypto.randomUUID();
  await call(wa, { op: 'callRequest', callId, chatId, video: false, commit: COMMIT, tab: 'tabaaaaa' });
  await drainJobs();
  got.length = 0;
  const wb = await connect(b.token);   // Борис открыл вкладку и ответил
  expect(await call(wb, { op: 'callAccept', callId, tab: 'tabbbbbb', pub: 'b'.repeat(43) })).toEqual({ ok: true });
  await drainJobs();
  expect(got.length).toBe(1);
  expect((await open(got[0].body)).call).toEqual({ id: callId, end: true });
  got.length = 0;
  const ended = nextFrame(wb, (f) => f.op === 'callEnded');
  wa.send(JSON.stringify({ op: 'callHangup', callId }));
  await ended;
  await drainJobs();
  expect(got.length).toBe(0);
  wa.close(); wb.close();
});
