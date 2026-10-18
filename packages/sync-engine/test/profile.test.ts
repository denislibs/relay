import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Engine } from '../src/engine';
import { meView } from '../src/profile';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const put = (token: string, path: string, body: unknown, method = 'PUT') =>
  fetch(`${srv.base}${path}`, { method, headers: { cookie: `relay_session=${token}` }, body: JSON.stringify(body) });

test('me comes from GET /me and is kept for an offline cold start', async () => {
  const a = await srv.login('Анна Смирнова');
  await put(a.token, '/me', { bio: 'о себе', birthday: { day: 29, month: 4, year: 1990 } }, 'PATCH');
  const cfg = srv.config(a);
  const ea = await open(cfg);
  ea.connect();
  await ea.whenIdle();
  const me = watchInto(ea, { kind: 'me' });
  const l = await me.until((x) => x.length === 1);
  expect(l[0]).toMatchObject({ userId: a.userId, name: 'Анна Смирнова', firstName: 'Анна', lastName: 'Смирнова', bio: 'о себе', birthday: { day: 29, month: 4, year: 1990 } });

  await ea.close(); engines.length = 0;
  const cold = await open(cfg);   // без connect: сети нет
  const me2 = watchInto(cold, { kind: 'me' });
  await me2.until((x) => x[0]?.bio === 'о себе');
});

test('userUpdated renames the direct chat and refreshes the user for the other side', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const cfgB = srv.config(b);
  const ea = await open(srv.config(a)), eb = await open(cfgB);
  ea.connect(); eb.connect();
  await Promise.all([ea.whenIdle(), eb.whenIdle()]);
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  await list.until((l) => l.find((c) => c.id === chatId)?.title === 'Анна');
  const user = watchInto(eb, { kind: 'user', userId: a.userId });
  await user.until((l) => l[0]?.name === 'Анна');   // нет в кэше — движок спросил GET /users/:id

  await ea.call({ type: 'updateProfile', firstName: 'Анна', lastName: 'Новая', bio: 'ссылка https://relay.dev 🚀' });
  await list.until((l) => l.find((c) => c.id === chatId)?.title === 'Анна Новая');
  const u = await user.until((l) => l[0]?.bio === 'ссылка https://relay.dev 🚀');
  expect(u[0]).toMatchObject({ id: a.userId, firstName: 'Анна', lastName: 'Новая', name: 'Анна Новая', phone: null });

  // кэш пользователей тоже переживает перезапуск
  await eb.close(); engines.splice(engines.indexOf(eb), 1);
  const eb2 = await open(cfgB);
  const u2 = watchInto(eb2, { kind: 'user', userId: a.userId });
  await u2.until((l) => l[0]?.name === 'Анна Новая');
});

test('checkUsername passes through to the server; offline answers offline', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  await put(b.token, '/me/username', { username: 'boris_taken' });
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  expect(await ea.call({ type: 'checkUsername', username: 'anna_free' })).toEqual({ ok: true });
  expect(await ea.call({ type: 'checkUsername', username: 'Boris_Taken' })).toEqual({ ok: false, reason: 'taken' });
  expect(await ea.call({ type: 'checkUsername', username: 'ab' })).toEqual({ ok: false, reason: 'invalid' });
  ea.disconnect();
  expect(await ea.call({ type: 'checkUsername', username: 'anna_free' })).toEqual({ offline: true });
});

test('meView applies queued patches in order', () => {
  const base = { userId: 1, name: 'А Б', firstName: 'А', lastName: 'Б', username: null, bio: null, birthday: null, phone: '+7', links: [] };
  const v = meView(base, [
    { id: 1, key: 'profile', method: 'PATCH', path: '/me', body: { firstName: '  Вера  ', bio: '  hi ' }, at: 0 },
    { id: 2, key: 'username', method: 'PUT', path: '/me/username', body: { username: '@Vera_X' }, at: 0 },
    { id: 3, key: 'profile', method: 'PATCH', path: '/me', body: { lastName: '', birthday: { day: 1, month: 2 } }, at: 0 },
    { id: 4, key: 'links', method: 'PATCH', path: '/me', body: { links: [{ service: 'github', handle: 'vera' }] }, at: 0 },
  ]);
  expect(v).toEqual({ userId: 1, name: 'Вера', firstName: 'Вера', lastName: '', username: 'vera_x', bio: 'hi', birthday: { day: 1, month: 2 }, phone: '+7', links: [{ service: 'github', handle: 'vera' }] });
  expect(meView(null, [])).toBeNull();
});

test('own profile is ordered by journal seq: a late older userUpdated does not roll back a newer response', async () => {
  const { ProfileCache } = await import('../src/profile');
  const p = new ProfileCache(1);
  const me = (bio: string, seq?: number) => ({ userId: 1, name: 'А', firstName: 'А', lastName: '', username: null, bio, birthday: null, phone: null, seq });
  const pub = (bio: string) => ({ id: 1, name: 'А', firstName: 'А', lastName: '', username: null, bio, birthday: null, phone: null });
  expect(p.setMe(me('ответ P2', 5))).toBe(true);
  p.applyUser(pub('эхо P1'), 4);                 // запись журнала P1 опоздала
  expect(p.me?.bio).toBe('ответ P2');
  p.applyUser(pub('эхо P2'), 5);                 // эхо того же состояния — ничего не меняет
  expect(p.me?.bio).toBe('ответ P2');
  expect(p.setMe(me('ответ P1', 4))).toBe(false); // запоздавший ответ
  p.applyUser(pub('с другого устройства'), 6);
  expect(p.me).toMatchObject({ bio: 'с другого устройства', seq: 6 });
});
