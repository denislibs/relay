import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sql } from '../../../apps/server/src/db';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const journal = async (userId: number) => Number((await sql`select count(*)::int as n from updates where user_id = ${userId} and type = 'userUpdated'`)[0].n);

test('offline profile edit shows at once, survives a restart, goes out after connect', async () => {
  const a = await srv.login('Анна');
  const cfg = srv.config(a);
  const ea = await open(cfg);
  ea.connect();
  await ea.whenIdle();
  const me = watchInto(ea, { kind: 'me' });
  await me.until((l) => l[0]?.name === 'Анна');
  ea.disconnect();

  await ea.call({ type: 'updateProfile', firstName: 'Анна', lastName: 'Офлайн', bio: 'Привет 👋' });
  const shown = await me.until((l) => l[0]?.name === 'Анна Офлайн');
  expect(shown[0]).toMatchObject({ firstName: 'Анна', lastName: 'Офлайн', bio: 'Привет 👋' });
  const ops = watchInto(ea, { kind: 'ops' });
  await ops.until((l) => l[0]?.pending === 1);

  await ea.close(); engines.length = 0;                 // закрыли вкладку, сети всё ещё нет
  const again = await open(cfg);
  const me2 = watchInto(again, { kind: 'me' });
  await me2.until((l) => l[0]?.name === 'Анна Офлайн');   // правка видна и после перезапуска
  expect((await sql`select last_name from users where id = ${a.userId}`)[0].last_name).toBeNull();

  again.connect();
  await again.whenIdle();
  const ops2 = watchInto(again, { kind: 'ops' });
  await ops2.until((l) => l[0]?.pending === 0);
  const [row] = await sql`select name, last_name, bio from users where id = ${a.userId}`;
  expect(row).toMatchObject({ name: 'Анна Офлайн', last_name: 'Офлайн', bio: 'Привет 👋' });
  await me2.until((l) => l[0]?.name === 'Анна Офлайн' && l[0]?.bio === 'Привет 👋');
});

test('ops with the same key coalesce: one PATCH with merged fields', async () => {
  const a = await srv.login('Анна');
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  ea.disconnect();
  const before = await journal(a.userId);

  await ea.call({ type: 'updateProfile', firstName: 'Первое' });
  await ea.call({ type: 'updateProfile', bio: 'о себе' });
  await ea.call({ type: 'updateProfile', firstName: 'Второе' });
  await ea.call({ type: 'setUsername', username: 'anna_tester' });
  const ops = watchInto(ea, { kind: 'ops' });
  const l = await ops.until((x) => x[0]?.pending === 2);
  expect(l[0].keys).toEqual(['profile', 'username']);
  const me = watchInto(ea, { kind: 'me' });
  await me.until((x) => x[0]?.firstName === 'Второе' && x[0]?.bio === 'о себе' && x[0]?.username === 'anna_tester');

  ea.connect();
  await ea.whenIdle();
  await ops.until((x) => x[0]?.pending === 0);
  const [row] = await sql`select first_name, bio, username from users where id = ${a.userId}`;
  expect(row).toEqual({ first_name: 'Второе', bio: 'о себе', username: 'anna_tester' });
  expect(await journal(a.userId)).toBe(before + 2);   // один PATCH и один PUT, а не три запроса профиля
});

test('409 reverts the optimistic username and reports opFailed', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  await fetch(`${srv.base}/me/username`, { method: 'PUT', headers: { cookie: `relay_session=${b.token}` }, body: JSON.stringify({ username: 'boris_taken' }) });
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const me = watchInto(ea, { kind: 'me' });
  const ops = watchInto(ea, { kind: 'ops' });
  await me.until((l) => l[0]?.userId === a.userId);
  await ops.until((l) => l.length === 1);

  ea.disconnect();   // чтобы увидеть оптимистичное значение до ответа сервера
  await ea.call({ type: 'setUsername', username: 'boris_taken' });
  await me.until((l) => l[0]?.username === 'boris_taken');
  ea.connect();
  await me.until((l) => l[0]?.username === null);
  const f = await ops.until((l) => (l[0]?.failures as unknown[]).length === 1);
  expect(f[0].pending).toBe(0);
  expect((f[0].failures as { key: string; code: string }[])[0]).toMatchObject({ key: 'username', code: 'username_taken' });

  // невалидное имя: 400 → тоже откат, второй отказ с новым id
  await ea.call({ type: 'setUsername', username: '1bad' });
  const f2 = await ops.until((l) => (l[0]?.failures as unknown[]).length === 2);
  const [x, y] = f2[0].failures as { id: number; code: string }[];
  expect(y.id).toBeGreaterThan(x.id);
  expect(y.code).toBe('username_invalid');
  await me.until((l) => l[0]?.username === null);
});

test('network error is retried with backoff, then the op goes out', async () => {
  const a = await srv.login('Анна');
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const real = globalThis.fetch;
  let failed = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH' && failed < 2) { failed++; return Promise.reject(new TypeError('network')); }
    return real(input, init);
  }) as typeof fetch;
  try {
    await ea.call({ type: 'updateProfile', bio: 'со второй попытки' });
    const ops = watchInto(ea, { kind: 'ops' });
    await ops.until((l) => l[0]?.pending === 0, 5000);
    expect(failed).toBe(2);
    expect((await sql`select bio from users where id = ${a.userId}`)[0].bio).toBe('со второй попытки');
  } finally {
    globalThis.fetch = real;
  }
});
