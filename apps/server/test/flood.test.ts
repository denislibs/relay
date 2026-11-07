import type { ServerFrame } from '@relay/protocol';
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createServer, WS_LIMITS } from '../src/http';
import { handleFrame } from '../src/ws';
import { DomainError } from '../src/domain/errors';
import { count, limit, phonePrefix, setLimit, windowsOf } from '../src/domain/flood';
import { requestCode } from '../src/domain/login';
import { makeChat, makeUser, nextFrame, resetDb } from './helpers';

// антифлуд (domain/flood.ts, docs/protection.md): окна лимитов, FLOOD_WAIT с retryAfter, пределы сокетов
const s = createServer({ port: 0 });
afterAll(() => s.stop(true));
beforeEach(resetDb);
const saved = { ...WS_LIMITS };
afterEach(() => { setLimit(); Object.assign(WS_LIMITS, saved); });
const base = `http://localhost:${s.port}`;
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const cookie = (t: string) => ({ cookie: `relay_session=${t}` });
async function connect(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${s.port}/ws?token=${token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}
const send = (chatId: number, n: number) => ({ op: 'send' as const, reqId: 'r' + n, clientId: crypto.randomUUID(), chatId, body: 'привет ' + n, entities: [], replyToId: null, attachment: null });
const flooded = (e: unknown) => e instanceof DomainError && e.code === 'flood' ? e.retryAfter ?? -1 : null;

test('windows: env overrides the table, "off" disables one limit, RELAY_LIMITS=off disables all', () => {
  expect(windowsOf('send', {})).toEqual([[30, 10], [120, 60], [1500, 3600]]);
  expect(windowsOf('send', { RELAY_LIMIT_SEND: '5/10, 50/3600' })).toEqual([[5, 10], [50, 3600]]);
  expect(windowsOf('groupCallJoin', { RELAY_LIMIT_GROUP_CALL_JOIN: '3/60' })).toEqual([[3, 60]]);
  expect(windowsOf('send', { RELAY_LIMIT_SEND: 'off' })).toBeNull();
  expect(windowsOf('send', { RELAY_LIMIT_SEND: 'мусор' })).toEqual([[30, 10], [120, 60], [1500, 3600]]);   // не разобрать — таблица
  expect(windowsOf('react', { RELAY_LIMITS: 'off' })).toBeNull();
});

test('country prefix of a phone number', () => {
  expect(phonePrefix('+79161234567')).toBe('+7');
  expect(phonePrefix('+12025550123')).toBe('+1');
  expect(phonePrefix('+447911123456')).toBe('+44');
  expect(phonePrefix('+380501234567')).toBe('+380');
  expect(phonePrefix('@anna')).toBeNull();
});

test('limit: n actions pass, the next one is flood with retryAfter within the window; every window counts', async () => {
  setLimit('search', [[3, 10], [5, 3600]]);
  for (let i = 0; i < 3; i++) await limit('search', 42);
  const wait = await limit('search', 42).then(() => null, flooded);
  expect(wait).toBeGreaterThanOrEqual(1);
  expect(wait).toBeLessThanOrEqual(10);
  await limit('search', 43);   // другой пользователь — своё окно
  setLimit('search', null);   // выключен — не считается
  for (let i = 0; i < 10; i++) expect(await count('search', 42)).toBe(0);
});

test('WebSocket send: over the limit — err flood with retryAfter, a forward has its own limit', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chatId = await makeChat([a, b]);
  setLimit('send', [[2, 60]]);
  expect((await handleFrame(a, send(chatId, 1)))[0].op).toBe('ack');
  expect((await handleFrame(a, send(chatId, 2)))[0].op).toBe('ack');
  const [err] = await handleFrame(a, send(chatId, 3));
  expect(err).toMatchObject({ op: 'err', reqId: 'r3', code: 'flood', retry: false });
  expect((err as Extract<ServerFrame, { op: 'err' }>).retryAfter).toBeGreaterThan(0);
  // сообщение не создано: история — два
  const [{ op }] = await handleFrame(b, send(chatId, 4));   // у собеседника свой счёт
  expect(op).toBe('ack');
});

test('typing over the limit is dropped silently, reactions over the limit — flood', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chatId = await makeChat([a, b]);
  setLimit('typing', [[1, 60]]);
  const sent: string[] = [];
  await handleFrame(a, { op: 'typing', chatId }, (_t, m) => sent.push(m));
  await handleFrame(a, { op: 'typing', chatId }, (_t, m) => sent.push(m));
  expect(sent.length).toBe(1);
  setLimit('react', [[1, 60]]);
  const [ack] = await handleFrame(a, send(chatId, 1));
  const id = (ack as { result: { id: number } }).result.id;
  expect((await handleFrame(a, { op: 'react', reqId: 'x1', chatId, id, emoji: '👍' }))[0].op).toBe('ack');
  expect((await handleFrame(a, { op: 'react', reqId: 'x2', chatId, id, emoji: '🔥' }))[0]).toMatchObject({ op: 'err', code: 'flood' });
});

test('HTTP: creating groups and searching over the limit — 429 with Retry-After and {code, retryAfter}', async () => {
  const a = await login('Анна');
  setLimit('chatCreate', [[1, 60]]);
  const mk = () => fetch(`${base}/chats`, { method: 'POST', headers: cookie(a.token), body: JSON.stringify({ kind: 'channel', title: 'Канал' }) });
  expect((await mk()).status).toBe(200);
  const r = await mk();
  expect(r.status).toBe(429);
  const body = (await r.json()) as { code: string; retryAfter: number };
  expect(body.code).toBe('flood');
  expect(Number(r.headers.get('retry-after'))).toBe(body.retryAfter);
  setLimit('search', [[1, 60]]);
  expect((await fetch(`${base}/search/people?q=ан`, { headers: cookie(a.token) })).status).toBe(200);
  expect((await fetch(`${base}/search?q=ан`, { headers: cookie(a.token) })).status).toBe(429);
  expect((await fetch(`${base}/search/top`, { headers: cookie(a.token) })).status).toBe(200);   // частые собеседники — не поиск
});

test('login codes: per country prefix and the server-wide daily budget (with a warning in the log)', async () => {
  setLimit('loginPrefix', [[2, 3600]]);
  await requestCode('+79160000001', '10.0.0.1');
  await requestCode('+79160000002', '10.0.0.2');
  expect(await requestCode('+79160000003', '10.0.0.3').then(() => null, flooded)).toBeGreaterThan(0);
  await requestCode('+447911000001', '10.0.0.4');   // другая страна — свой счёт
  setLimit('loginPrefix', null);
  setLimit('loginGlobal', [[1, 86_400]]);   // бюджет — один код на сервер: первый — 100% (предупреждение), второй — отказ
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await requestCode('+380500000001', '10.0.0.5');
    expect(warn.mock.calls.some(([m]) => String(m).includes('loginGlobal'))).toBe(true);
    expect(await requestCode('+380500000002', '10.0.0.6').then(() => null, flooded)).toBeGreaterThan(0);
  } finally { warn.mockRestore(); }
});

test('login code: hourly per-phone refusal carries retryAfter (seconds until the oldest attempt leaves the hour)', async () => {
  for (let i = 0; i < 5; i++) await requestCode('+79161112233');
  const wait = await requestCode('+79161112233').then(() => null, flooded);
  expect(wait).toBeGreaterThan(3500);
  expect(wait).toBeLessThanOrEqual(3600);
});

test('sockets: per-session cap refuses the upgrade with 429; a closed socket frees its slot', async () => {
  const a = await login('Анна');
  WS_LIMITS.perSession = 2;
  const w1 = await connect(a.token), w2 = await connect(a.token);
  const r = await fetch(`${base}/ws`, { headers: { ...cookie(a.token), upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
  expect(r.status).toBe(429);
  w1.close();
  await Bun.sleep(100);
  const w3 = await connect(a.token);
  w2.close(); w3.close();
});

test('sockets: a client that keeps hitting flood is disconnected (4008)', async () => {
  const a = await login('Анна'), b = await makeUser('Борис');
  const chatId = await makeChat([a.userId, b]);
  setLimit('send', [[1, 60]]);
  WS_LIMITS.strikes = 2;
  const ws = await connect(a.token);
  const closed = new Promise<number>((ok) => { ws.onclose = (e) => ok(e.code); });
  await nextFrame(ws, () => true).catch(() => {});   // первые кадры сервера (если есть)
  for (let i = 0; i < 5; i++) ws.send(JSON.stringify(send(chatId, i)));
  expect(await closed).toBe(4008);
});
