import { afterAll, beforeEach, expect, test } from 'bun:test';
import type { ServerFrame, SessionInfo } from '@relay/protocol';
import { sql } from '../src/db';
import { clientIp, parseDevice } from '../src/device';
import { getUpdates } from '../src/domain/journal';
import { resetPresence } from '../src/domain/presence';
import { announceLogin, confirmSession, listSessions, setLiveCheckMs, sweepInactive, terminateOthers, terminateSession, touchLive } from '../src/domain/sessions';
import { createSession, sessionFromToken } from '../src/auth';
import { createServer } from '../src/http';
import { startRealtime } from '../src/realtime';
import { makeUser, nextFrame, resetDb } from './helpers';

const server = createServer({ port: 0 });
const stopRealtime = await startRealtime(server);
const base = `http://localhost:${server.port}`;
afterAll(async () => { await stopRealtime(); server.stop(true); });
beforeEach(async () => { await resetDb(); resetPresence(); setLiveCheckMs(60_000); });

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
};

test('User-Agent → coarse device name', () => {
  const cases: [string | null, string][] = [
    [UA.chromeMac, 'Chrome 141, macOS'],
    [UA.safariIos, 'Safari 18, iOS'],
    [UA.firefoxWin, 'Firefox 140, Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'Edge 141, Windows'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 'Chrome 141, Android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1', 'Chrome 141, iOS'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox 140, Linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'Safari 18, macOS'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/120.0.0.0', 'Opera 120, Windows'],
    ['Bun/1.4.2', 'Браузер'],
    ['', 'Браузер'],
    [null, 'Браузер'],
  ];
  for (const [ua, want] of cases) expect([ua, parseDevice(ua)]).toEqual([ua, want]);
});

type U = { userId: number; token: string };
const login = async (name: string, ua = UA.chromeMac): Promise<U> =>
  (await (await fetch(`${base}/dev/login`, { method: 'POST', headers: { 'user-agent': ua }, body: JSON.stringify({ name }) })).json()) as U;
const call = (u: U, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { cookie: `relay_session=${u.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const list = async (u: U) => (await (await call(u, 'GET', '/sessions')).json()) as SessionInfo[];
const openWs = async (u: U) => {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?token=${u.token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
};
const closed = (ws: WebSocket) => new Promise<number>((r) => { if (ws.readyState === WebSocket.CLOSED) r(-1); else ws.addEventListener('close', (e) => r(e.code)); });

test('list shows every own session, the current one first, with device and ip', async () => {
  const a1 = await login('Анна', UA.chromeMac);
  const a2 = await login('Анна', UA.safariIos);
  await login('Борис');
  const l = await list(a2);
  expect(l.length).toBe(2);
  expect(l[0]).toMatchObject({ current: true, device: 'Safari 18, iOS', online: true, unconfirmed: false });
  expect(l[1]).toMatchObject({ current: false, device: 'Chrome 141, macOS' });
  expect(typeof l[0].ip).toBe('string');
  expect(Date.parse(l[0].createdAt)).toBeGreaterThan(0);
  expect(Date.parse(l[0].lastActiveAt)).toBeGreaterThan(0);
  expect((await list(a1))[0]).toMatchObject({ id: l[1].id, current: true });
  expect((await fetch(`${base}/sessions`)).status).toBe(401);
});

test("can't terminate another user's session (404) or the current one (400)", async () => {
  const a = await login('Анна'), b = await login('Борис');
  const [bs] = await list(b);
  expect((await call(a, 'DELETE', `/sessions/${bs.id}`)).status).toBe(404);
  expect((await call(a, 'DELETE', '/sessions/999999')).status).toBe(404);
  const [as] = await list(a);
  expect((await call(a, 'DELETE', `/sessions/${as.id}`)).status).toBe(400);
  expect((await call(b, 'GET', '/me')).status).toBe(200);
  expect((await call(a, 'GET', '/me')).status).toBe(200);
});

test('terminated session: its ws gets sessionTerminated and closes, the next HTTP is 401', async () => {
  const a1 = await login('Анна'), a2 = await login('Анна', UA.firefoxWin);
  const ws2 = await openWs(a2);
  const [, other] = await list(a1);
  expect(other.device).toBe('Firefox 140, Windows');
  expect((await list(a1)).find((s) => s.id === other.id)?.online).toBe(true);   // живой сокет
  const frame = nextFrame(ws2, (f) => f.op === 'sessionTerminated');
  const code = closed(ws2);
  const r = await call(a1, 'DELETE', `/sessions/${other.id}`);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, id: other.id });
  expect(await frame).toEqual({ op: 'sessionTerminated', reason: 'terminated' });
  expect(await code).toBe(4001);
  expect((await call(a2, 'GET', '/me')).status).toBe(401);
  expect((await list(a1)).map((s) => s.id)).not.toContain(other.id);
});

test('others=1 terminates every other session and keeps the current one', async () => {
  const a1 = await login('Анна'), a2 = await login('Анна'), a3 = await login('Анна'), b = await login('Борис');
  const w2 = await openWs(a2), w3 = await openWs(a3);
  const got = Promise.all([nextFrame(w2, (f) => f.op === 'sessionTerminated'), nextFrame(w3, (f) => f.op === 'sessionTerminated')]);
  const r = await call(a1, 'DELETE', '/sessions?others=1');
  expect(r.status).toBe(200);
  expect(((await r.json()) as { ids: number[] }).ids.length).toBe(2);
  await got;
  const l = await list(a1);
  expect(l.map((s) => s.current)).toEqual([true]);
  expect((await call(a2, 'GET', '/me')).status).toBe(401);
  expect((await call(a3, 'GET', '/me')).status).toBe(401);
  expect((await call(b, 'GET', '/me')).status).toBe(200);
});

test("logout closes the other tab's socket of the same session", async () => {
  const a = await login('Анна');
  const tab1 = await openWs(a), tab2 = await openWs(a);
  const f2 = nextFrame(tab2, (f) => f.op === 'sessionTerminated');
  const c2 = closed(tab2);
  const r = await call(a, 'POST', '/logout');
  expect(r.status).toBe(200);
  expect(await f2).toEqual({ op: 'sessionTerminated', reason: 'logout' });
  expect(await c2).toBe(4001);
  await closed(tab1);
  expect((await call(a, 'GET', '/me')).status).toBe(401);
});

test('TTL: inactive sessions stop working at once and the sweep deletes them; the ttl change goes to the journal', async () => {
  const a1 = await login('Анна'), a2 = await login('Анна');
  const [cur, other] = await list(a1);
  await sql`update sessions set last_active_at = now() - interval '10 days' where id = ${other.id}`;
  // по умолчанию 180 дней — сеанс жив
  expect((await call(a2, 'GET', '/me')).status).toBe(200);
  await sql`update sessions set last_active_at = now() - interval '10 days' where id = ${other.id}`;

  for (const body of [{ days: 8 }, { days: '30' }, null, {}]) expect((await call(a1, 'PUT', '/settings/sessions-ttl', body)).status).toBe(400);
  const r = await call(a1, 'PUT', '/settings/sessions-ttl', { days: 7 });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ sessionsTtlDays: 7, seq: 1 });
  expect((await getUpdates(a1.userId, 0)).items.map((i) => i.update)).toEqual([
    { type: 'settingsChanged', settings: { notify: { direct: { muted: false, preview: true }, group: { muted: false, preview: true } }, sessionsTtlDays: 7 } },
  ]);
  // смена срока сразу завершила неактивный сеанс
  expect((await list(a1)).map((s) => s.id)).toEqual([cur.id]);
  expect((await call(a2, 'GET', '/me')).status).toBe(401);
  // повтор того же значения журнал не трогает
  expect(await (await call(a1, 'PUT', '/settings/sessions-ttl', { days: 7 })).json()).toMatchObject({ seq: 1 });

  // неактивный дольше срока не действует ещё до чистки; чистка удаляет его строку
  const a3 = await login('Анна');
  const id3 = (await list(a3))[0].id;
  await sql`update sessions set last_active_at = now() - interval '8 days' where id = ${id3}`;
  expect((await call(a3, 'GET', '/me')).status).toBe(401);
  expect(await sweepInactive()).toEqual([id3]);
  expect((await sql`select count(*)::int as n from sessions where id = ${id3}`)[0].n).toBe(0);
});

test('login sweeps the user’s own inactive sessions', async () => {
  const a1 = await login('Анна'), b = await login('Борис');
  await sql`update sessions set last_active_at = now() - interval '200 days'`;
  await login('Анна');
  const left = await sql`select user_id from sessions order by id`;
  expect(left.map((r) => Number(r.user_id))).toEqual([b.userId, a1.userId]);
});

test('last_active_at is touched at most once a minute', async () => {
  const a = await login('Анна');
  const [s] = await list(a);
  await sql`update sessions set last_active_at = now() - interval '30 seconds' where id = ${s.id}`;
  const before = (await sql`select last_active_at from sessions where id = ${s.id}`)[0].last_active_at as Date;
  await call(a, 'GET', '/me');
  expect(((await sql`select last_active_at from sessions where id = ${s.id}`)[0].last_active_at as Date).getTime()).toBe(before.getTime());
  await sql`update sessions set last_active_at = now() - interval '2 minutes' where id = ${s.id}`;
  await call(a, 'GET', '/me');
  const after = (await sql`select last_active_at from sessions where id = ${s.id}`)[0].last_active_at as Date;
  expect(Date.now() - after.getTime()).toBeLessThan(10_000);
});

test('a ws frame of another session never reaches this one', async () => {
  const a1 = await login('Анна'), a2 = await login('Анна');
  const w1 = await openWs(a1), w2 = await openWs(a2);
  const seen: ServerFrame[] = [];
  w1.addEventListener('message', (e) => seen.push(JSON.parse(String(e.data))));
  const [, other] = await list(a1);
  const done = closed(w2);
  await call(a1, 'DELETE', `/sessions/${other.id}`);
  await done;
  await Bun.sleep(50);
  expect(seen.some((f) => f.op === 'sessionTerminated')).toBe(false);
  expect(w1.readyState).toBe(WebSocket.OPEN);
  w1.close();
});

test('x-forwarded-for: trusted only behind a proxy, and only the entry our proxy appended', () => {
  const srvIp = { requestIP: () => ({ address: '::ffff:10.0.0.9' }) };
  const req = (xff?: string) => new Request('http://x/', { headers: xff ? { 'x-forwarded-for': xff } : {} });
  const env = { p: process.env.TRUST_PROXY, h: process.env.TRUST_PROXY_HOPS };
  try {
    delete process.env.TRUST_PROXY; delete process.env.TRUST_PROXY_HOPS;
    expect(clientIp(req('6.6.6.6'), srvIp)).toBe('10.0.0.9');            // по умолчанию заголовку не верим
    process.env.TRUST_PROXY = '1';
    expect(clientIp(req('6.6.6.6, 203.0.113.7'), srvIp)).toBe('203.0.113.7');   // поддельная левая запись не берётся
    expect(clientIp(req('203.0.113.7'), srvIp)).toBe('203.0.113.7');
    expect(clientIp(req(), srvIp)).toBe('10.0.0.9');
    process.env.TRUST_PROXY_HOPS = '2';   // CDN → nginx: вторая справа
    expect(clientIp(req('6.6.6.6, 198.51.100.4, 10.1.1.1'), srvIp)).toBe('198.51.100.4');
    expect(clientIp(req('10.1.1.1'), srvIp)).toBe('10.0.0.9');           // цепочка короче числа прокси — адрес сокета
  } finally {
    if (env.p === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = env.p;
    if (env.h === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = env.h;
  }
});

test('ws frames count as activity: a long-lived socket keeps its session out of the sweep', async () => {
  const a = await login('Анна');
  await call(a, 'PUT', '/settings/sessions-ttl', { days: 7 });
  const ws = await openWs(a);
  const [s] = await list(a);
  await sql`update sessions set last_active_at = now() - interval '6 days 23 hours' where id = ${s.id}`;
  setLiveCheckMs(0);
  ws.send(JSON.stringify({ op: 'ping' }));
  await nextFrame(ws, (f) => f.op === 'pong');
  const [row] = await sql`select last_active_at from sessions where id = ${s.id}`;
  expect(Date.now() - (row.last_active_at as Date).getTime()).toBeLessThan(10_000);
  await sql`update sessions set last_active_at = now() - interval '6 days 23 hours' where id = ${s.id}`;
  expect(await touchLive()).toEqual([]);   // минутный проход по живым сокетам тоже отмечает активность
  expect(await sweepInactive()).toEqual([]);
  expect(ws.readyState).toBe(WebSocket.OPEN);
  ws.close();
});

test('session row deleted without NOTIFY: the socket is closed on its next frame or minute check', async () => {
  const a1 = await login('Анна'), a2 = await login('Анна');
  const w1 = await openWs(a1), w2 = await openWs(a2);
  const [s1, s2] = (await list(a1)).sort((x, y) => x.id - y.id);
  setLiveCheckMs(0);
  // кадр, который что-то меняет, не выполняется: сокет получает sessionTerminated и закрывается
  await sql`delete from sessions where id = ${s1.id}`;
  const f1 = nextFrame(w1, (f) => f.op === 'sessionTerminated'), c1 = closed(w1);
  w1.send(JSON.stringify({ op: 'draft', reqId: 'r1', chatId: 1, text: 'x' }));
  expect(await f1).toEqual({ op: 'sessionTerminated', reason: 'terminated' });
  expect(await c1).toBe(4001);
  // молчащий сокет — минутный проход touchLive
  await sql`delete from sessions where id = ${s2.id}`;
  const f2 = nextFrame(w2, (f) => f.op === 'sessionTerminated'), c2 = closed(w2);
  expect(await touchLive()).toEqual([s2.id]);
  await f2;
  expect(await c2).toBe(4001);
});

test('sliding expiry: an active session gets a fresh expires_at and cookie', async () => {
  const a = await login('Анна');
  const [s] = await list(a);
  const fresh = await call(a, 'GET', '/me');
  expect(fresh.headers.get('set-cookie')).toBeNull();   // свежий сеанс — cookie не трогаем
  await sql`update sessions set expires_at = now() + interval '10 days' where id = ${s.id}`;
  const r = await call(a, 'GET', '/me');
  expect(r.status).toBe(200);
  expect(r.headers.get('set-cookie')).toContain('Max-Age=' + 366 * 86400);
  const [row] = await sql`select expires_at from sessions where id = ${s.id}`;
  expect((row.expires_at as Date).getTime() - Date.now()).toBeGreaterThan(365 * 86_400_000);
});

test('DELETE /sessions without others=1 → 400', async () => {
  const a1 = await login('Анна'); await login('Анна');
  expect((await call(a1, 'DELETE', '/sessions')).status).toBe(400);
  expect((await list(a1)).length).toBe(2);
});

test('new code login: unconfirmed, announced in the service chat, cannot terminate others until confirmed', async () => {
  const a = await makeUser('Анна');
  const old = (await sessionFromToken(await createSession(a)))!.sessionId;
  const newToken = await createSession(a, undefined, { confirmed: false });
  const fresh = (await sessionFromToken(newToken))!.sessionId;
  await announceLogin(a, newToken);

  const list = await listSessions(a, old);
  expect(list.find((s) => s.id === fresh)).toMatchObject({ unconfirmed: true });
  const [msg] = await sql`select body from messages where service_type = 'new_login' order by id desc limit 1`;
  expect(msg.body).toContain('Новый вход');
  const types = (await sql`select type from updates where user_id = ${a} order by seq`).map((r) => r.type);
  expect(types).toContain('sessionsChanged');

  await expect(terminateSession(a, fresh, old)).rejects.toMatchObject({ code: 'fresh_session' });
  await expect(terminateOthers(a, fresh)).rejects.toMatchObject({ code: 'fresh_session' });
  await expect(confirmSession(a, fresh, old)).rejects.toMatchObject({ code: 'fresh_session' });
  await expect(confirmSession(a, fresh, fresh)).rejects.toMatchObject({ code: 'bad_frame' });   // себя не подтверждают
  await confirmSession(a, old, fresh);
  expect((await listSessions(a, old)).find((s) => s.id === fresh)).toMatchObject({ unconfirmed: false });
  await terminateOthers(a, fresh);   // подтверждённый сеанс снова может завершать другие
});

test('a week-old unconfirmed session counts as confirmed', async () => {
  const a = await makeUser('Борис');
  const t = await createSession(a, undefined, { confirmed: false });
  const id = (await sessionFromToken(t))!.sessionId;
  await sql`update sessions set created_at = now() - interval '8 days' where id = ${id}`;
  expect((await listSessions(a, id))[0]).toMatchObject({ unconfirmed: false });
});
