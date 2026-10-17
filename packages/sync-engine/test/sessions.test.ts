import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import type { SessionInfo } from '@relay/protocol';
import { sql } from '../../../apps/server/src/db';
import { Engine } from '../src/engine';
import { sessionsView } from '../src/sessions';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const call = (token: string, method: string, path: string) => fetch(srv.base + path, { method, headers: { cookie: `relay_session=${token}` } });
const dbExists = async (name: string) => (await indexedDB.databases()).some((d) => d.name === name);

test('sessionTerminated → terminal status, local data wiped, no reconnect', async () => {
  const a1 = await srv.login('Анна'), a2 = await srv.login('Анна'), b = await srv.login('Борис');
  await srv.chat(a2.token, [a2.userId, b.userId]);
  const cfg = srv.config(a2);
  const e = await open(cfg);
  let gone = false;
  e.onTerminated(() => { gone = true; });
  const st = watchInto(e, { kind: 'status' });
  e.connect();
  await e.whenIdle();
  expect(e.store.chats.size).toBe(1);
  expect(await dbExists(cfg.dbName)).toBe(true);

  const list = (await (await call(a1.token, 'GET', '/sessions')).json()) as SessionInfo[];
  const other = list.find((s) => !s.current)!;
  expect((await call(a1.token, 'DELETE', `/sessions/${other.id}`)).status).toBe(200);
  await st.until((l) => l[0]?.terminated === true && l[0]?.online === false);
  const end = Date.now() + 3000;
  while (!gone && Date.now() < end) await Bun.sleep(10);
  expect(gone).toBe(true);
  expect(e.store.chats.size).toBe(0);
  expect(await dbExists(cfg.dbName)).toBe(false);
  // переподключения нет
  await Bun.sleep(300);
  expect(e.status().online).toBe(false);
});

test('a 401 on HTTP (session gone while offline) also ends in the terminal status', async () => {
  const a = await srv.login('Анна');
  const e = await open(srv.config(a));
  const st = watchInto(e, { kind: 'status' });
  await sql`delete from sessions`;
  e.connect();   // подключение отвергнуто (401) → проверка сеанса → terminated
  await st.until((l) => l[0]?.terminated === true);
});

test('listSessions passthrough; terminate via ops hides the session at once; ttl via ops updates settings', async () => {
  const a1 = await srv.login('Анна'), a2 = await srv.login('Анна');
  const e = await open(srv.config(a1));
  expect(await e.call({ type: 'listSessions' })).toEqual({ offline: true });
  e.connect();
  await e.whenIdle();
  const r = (await e.call({ type: 'listSessions' })) as { sessions: SessionInfo[] };
  expect(r.sessions.map((s) => s.current)).toEqual([true, false]);
  const other = r.sessions[1];

  e.disconnect();
  await e.call({ type: 'terminateSession', id: other.id });
  expect(e.ops.list.map((o) => o.key)).toEqual(['session:' + other.id]);
  expect(sessionsView(r.sessions, e.ops.list.map((o) => o.key)).map((s) => s.id)).toEqual([r.sessions[0].id]);

  const settings = watchInto(e, { kind: 'settings' });
  await e.call({ type: 'setSessionsTtl', days: 30 });
  await settings.until((l) => l[0]?.sessionsTtlDays === 30 && l[0]?.pending === true);
  e.connect();
  await e.whenIdle();
  await settings.until((l) => l[0]?.sessionsTtlDays === 30 && l[0]?.pending === false);
  expect((await call(a2.token, 'GET', '/me')).status).toBe(401);
  const after = (await e.call({ type: 'listSessions' })) as { sessions: SessionInfo[] };
  expect(after.sessions.map((s) => s.id)).toEqual([r.sessions[0].id]);
  expect(e.status().terminated).toBeUndefined();
});

test('sessionsView: others hides everything but the current session', () => {
  const s = (id: number, current = false): SessionInfo => ({ id, device: 'd', ip: null, createdAt: '', lastActiveAt: '', current, online: false });
  const list = [s(1, true), s(2), s(3)];
  expect(sessionsView(list, []).map((x) => x.id)).toEqual([1, 2, 3]);
  expect(sessionsView(list, ['session:3', 'notify:direct']).map((x) => x.id)).toEqual([1, 2]);
  expect(sessionsView(list, ['sessions:others']).map((x) => x.id)).toEqual([1]);
});
