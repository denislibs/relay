import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { newChallenge } from '../src/deviceAuth';
import { makeChat, resetDb } from './helpers';
import { startRealtime } from '../src/realtime';
import { sendMessage } from '../src/domain/messages';

const server = createServer({ port: 0 });
const stopRealtime = await startRealtime(server);
const base = `http://localhost:${server.port}`;
afterAll(async () => { await stopRealtime(); server.stop(true); });
beforeEach(resetDb);

const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const device = async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  const sign = async (purpose: string, nonce: string) => Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`relay-device|${purpose}|${nonce}`))).toString('base64');
  return { spki, sign };
};
const cookie = (long?: string, access?: string) => ({ cookie: [long && `relay_session=${long}`, access && `relay_access=${access}`].filter(Boolean).join('; ') });
const accessOf = (res: Response) => /relay_access=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? null;
async function refresh(long: string, dev: Awaited<ReturnType<typeof device>>, withKey = true) {
  const { nonce } = await (await fetch(`${base}/session/challenge`)).json() as { nonce: string };
  return fetch(`${base}/session/refresh`, { method: 'POST', headers: { ...cookie(long), 'content-type': 'application/json' }, body: JSON.stringify({ nonce, sig: await dev.sign('refresh', nonce), ...(withKey ? { key: dev.spki } : {}) }) });
}

test('first refresh binds the device key; then the long cookie alone opens nothing — only the short access cookie does', async () => {
  const a = await login('Анна'), dev = await device();
  expect((await fetch(`${base}/me`, { headers: cookie(a.token) })).status).toBe(200);   // ещё не привязан — как раньше
  const r = await refresh(a.token, dev);
  expect(r.status).toBe(200);
  const access = accessOf(r)!;
  expect(access).toBeTruthy();
  const stolen = await fetch(`${base}/me`, { headers: cookie(a.token) });
  expect(stolen.status).toBe(401);
  expect(await stolen.json()).toEqual({ code: 'access_expired' });
  expect(stolen.headers.get('x-relay-auth')).toBe('refresh');
  expect((await fetch(`${base}/me`, { headers: cookie(a.token, access) })).status).toBe(200);
  // следующее обновление — подписью тем же ключом (ключ можно и не присылать)
  expect((await refresh(a.token, dev, false)).status).toBe(200);
});

test('a stolen long cookie cannot be refreshed without the device key; a foreign key, a stale or forged challenge are refused', async () => {
  const a = await login('Анна'), dev = await device(), thief = await device();
  await refresh(a.token, dev);
  expect((await refresh(a.token, thief)).status).toBe(401);
  const old = await newChallenge(Date.now() - 3 * 60_000);
  const late = await fetch(`${base}/session/refresh`, { method: 'POST', headers: { ...cookie(a.token), 'content-type': 'application/json' }, body: JSON.stringify({ nonce: old, sig: await dev.sign('refresh', old) }) });
  expect(late.status).toBe(401);
  const forged = '123.abc.def';
  expect((await fetch(`${base}/session/refresh`, { method: 'POST', headers: { ...cookie(a.token), 'content-type': 'application/json' }, body: JSON.stringify({ nonce: forged, sig: await dev.sign('refresh', forged) }) })).status).toBe(401);
  expect((await fetch(`${base}/session/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);   // без сеанса
});

function socket(headers: Record<string, string>) {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers } as never);
  const frames: Record<string, unknown>[] = [];
  let closed: number | null = null;
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  ws.onclose = (e) => { closed = e.code; };
  const until = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await Bun.sleep(10); return f(); };
  return { ws, frames, closed: () => closed, until, opened: new Promise((r) => { ws.onopen = r; }) };
}

test('WebSocket of a bound session runs frames only after the device signs the challenge; a wrong signature closes it', async () => {
  const a = await login('Анна'), dev = await device();
  const access = accessOf(await refresh(a.token, dev))!;
  const s = socket(cookie(a.token, access));
  await s.opened;
  await s.until(() => s.frames.some((f) => f.op === 'challenge'));
  const nonce = s.frames.find((f) => f.op === 'challenge')!.nonce as string;
  s.ws.send(JSON.stringify({ op: 'hello', lastSeq: 0 }));
  await Bun.sleep(150);
  expect(s.frames.some((f) => f.op === 'hello')).toBe(false);          // ждёт подписи
  s.ws.send(JSON.stringify({ op: 'prove', sig: await dev.sign('ws', nonce) }));
  expect(await s.until(() => s.frames.some((f) => f.op === 'hello'))).toBe(true);   // кадр из очереди выполнен
  s.ws.close();

  // один долгий cookie (доступ истёк или украден) — сокет не открывается вовсе (AUTH-1)
  const longOnly = socket(cookie(a.token));
  expect(await longOnly.until(() => longOnly.closed() !== null)).toBe(true);
  expect(longOnly.frames).toEqual([]);

  const bad = socket(cookie(a.token, access));
  await bad.opened;
  await bad.until(() => bad.frames.some((f) => f.op === 'challenge'));
  bad.ws.send(JSON.stringify({ op: 'prove', sig: await (await device()).sign('ws', bad.frames[0].nonce as string) }));
  expect(await bad.until(() => bad.closed() === 4401)).toBe(true);
});

test('an unbound session works as before (no challenge); logout clears both cookies', async () => {
  const a = await login('Борис');
  const s = socket(cookie(a.token));
  await s.opened;
  s.ws.send(JSON.stringify({ op: 'hello', lastSeq: 0 }));
  expect(await s.until(() => s.frames.some((f) => f.op === 'hello'))).toBe(true);
  expect(s.frames.some((f) => f.op === 'challenge')).toBe(false);
  s.ws.close();
  const out = await fetch(`${base}/logout`, { method: 'POST', headers: cookie(a.token) });
  const set = out.headers.getSetCookie?.() ?? [out.headers.get('set-cookie') ?? ''];
  expect(set.join(' ')).toContain('relay_session=;');
  expect(set.join(' ')).toContain('relay_access=;');
});

test('a new sign-in in the same browser drops the short access cookie of the previous session', async () => {
  const res = await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name: 'Вера' }) });
  const set = (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']).join(' ');
  expect(set).toContain('relay_session=');
  expect(set).toContain('relay_access=;');
});

test('AUTH-1: until the device proof the socket gets nothing — not even a new direct message; after it, sync brings the message', async () => {
  const a = await login('Анна'), b = await login('Борис'), dev = await device();
  const access = accessOf(await refresh(a.token, dev))!;
  const chatId = await makeChat([a.userId, b.userId]);
  const s = socket(cookie(a.token, access));
  await s.opened;
  await s.until(() => s.frames.some((f) => f.op === 'challenge'));
  await sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body: 'секрет до подписи' });
  await Bun.sleep(400);
  expect(s.frames.map((f) => f.op)).toEqual(['challenge']);   // ни push, ни typing, ни presence
  s.ws.send(JSON.stringify({ op: 'prove', sig: await dev.sign('ws', s.frames[0].nonce as string) }));
  s.ws.send(JSON.stringify({ op: 'hello', lastSeq: 0 }));
  s.ws.send(JSON.stringify({ op: 'sync', since: 0 }));
  expect(await s.until(() => JSON.stringify(s.frames).includes('секрет до подписи'))).toBe(true);
  s.ws.close();
});

test('DOS-1: oversized frames and frame floods close the socket', async () => {
  const a = await login('Вера');
  const big = socket(cookie(a.token));
  await big.opened;
  big.ws.send(JSON.stringify({ op: 'typing', chatId: 1, pad: 'x'.repeat(300 * 1024) }));
  expect(await big.until(() => big.closed() !== null)).toBe(true);
  const flood = socket(cookie(a.token));
  await flood.opened;
  for (let i = 0; i < 150; i++) flood.ws.send(JSON.stringify({ op: 'ping' }));
  expect(await flood.until(() => flood.closed() === 4008)).toBe(true);
});
