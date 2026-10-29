import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Engine } from '../src/engine';
import { meView } from '../src/profile';
import { sql } from '../../../apps/server/src/db';
import { sendMessage } from '../../../apps/server/src/domain/messages';
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

test('personal channel: rides userUpdated to the peer, shows at once for self; channel post is cached for offline', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  await srv.chat(a.token, [a.userId, b.userId]);
  const hdr = { cookie: `relay_session=${a.token}`, 'content-type': 'application/json' };
  const ch = (await (await fetch(`${srv.base}/chats`, { method: 'POST', headers: hdr, body: JSON.stringify({ kind: 'channel', title: 'Новости', memberIds: [] }) })).json()).id as number;
  await put(a.token, `/groups/${ch}/username`, { username: 'anna_news' });
  await sendMessage(a.userId, { chatId: ch, clientId: crypto.randomUUID(), body: 'свежий пост' });
  const ea = await open(srv.config(a)), cfgB = srv.config(b), eb = await open(cfgB);
  ea.connect(); eb.connect();
  await Promise.all([ea.whenIdle(), eb.whenIdle()]);
  expect(await ea.call({ type: 'personalChannels' })).toEqual({ channels: [{ id: ch, title: 'Новости', username: 'anna_news', photo: null, members: 1 }] });

  const peer = watchInto(eb, { kind: 'user', userId: a.userId });
  await peer.until((l) => l[0]?.name === 'Анна');
  const self = watchInto(ea, { kind: 'me' });
  const pc = { id: ch, title: 'Новости', username: 'anna_news', photo: null, members: 1 };
  await ea.call({ type: 'setPersonalChannel', channel: pc });
  await self.until((l) => l[0]?.personalChannel?.id === ch);
  await peer.until((l) => l[0]?.personalChannel?.id === ch);

  expect(await eb.call({ type: 'channelPost', chatId: ch, cached: true })).toBeNull();   // ещё не открывали
  const post = await eb.call({ type: 'channelPost', chatId: ch }) as { last: { body: string } };
  expect(post.last.body).toBe('свежий пост');

  await ea.call({ type: 'setPersonalChannel', channel: null });
  await peer.until((l) => l[0]?.personalChannel === null);

  // кэш поста — в IndexedDB: холодный старт без сети отдаёт его сразу
  await eb.close(); engines.splice(engines.indexOf(eb), 1);
  const cold = await open(cfgB);
  expect((await cold.call({ type: 'channelPost', chatId: ch }) as { last: { body: string } }).last.body).toBe('свежий пост');
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

/** HTTP-запросы движка к /users (обёртка над fetch на время теста). */
function countUsersFetches() {
  const urls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    if (/\/users(\?|\/\d)/.test(u)) urls.push(u);
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = real; } };
}

test('people: 50 unknown people come in one batch; strangers are not re-asked', async () => {
  const a = await srv.login('Анна');
  const others: { userId: number }[] = [];
  for (let i = 0; i < 50; i++) others.push(await srv.login('Человек ' + i));
  const stranger = await srv.login('Незнакомец');
  await srv.chat(a.token, [a.userId, ...others.map((o) => o.userId)]);
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const ids = [...others.map((o) => o.userId), stranger.userId];
  for (const id of ids) expect(ea.store.users.get(id)).toBeUndefined();   // группа не приносит профили участников
  const f = countUsersFetches();
  try {
    const people = watchInto(ea, { kind: 'people', ids });
    const l = await people.until((x) => x.length === 50);
    expect(l[0]).toEqual({ key: String(others[0].userId), id: others[0].userId, name: 'Человек 0', photo: null });
    expect(l.map((x) => x.id)).toEqual(others.map((o) => o.userId));   // порядок — как в запросе; незнакомца нет
    // новая подписка и пересчёты не спрашивают незнакомца заново
    const again = watchInto(ea, { kind: 'people', ids: [stranger.userId, others[1].userId] });
    await again.until((x) => x.length === 1);
    await ea.whenIdle();
    await Bun.sleep(50);
    expect(f.urls.length).toBe(1);
    expect(f.urls[0]).toContain('/users?ids=');
  } finally { f.restore(); }
});

test('people: two tabs of one worker asking the same ids make one request', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис'), c = await srv.login('Вера');
  await srv.chat(a.token, [a.userId, b.userId, c.userId]);
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const f = countUsersFetches();
  try {
    const ids = [b.userId, c.userId];
    const t1 = watchInto(ea, { kind: 'people', ids });
    const t2 = watchInto(ea, { kind: 'people', ids: [c.userId, b.userId] });
    await Bun.sleep(8);   // кадр прошёл, запрос уже в пути
    const t3 = watchInto(ea, { kind: 'people', ids });
    for (const t of [t1, t2, t3]) await t.until((x) => x.length === 2);
    expect(t2.list().map((x) => x.name)).toEqual(['Вера', 'Борис']);
    await ea.whenIdle();
    expect(f.urls.length).toBe(1);
  } finally { f.restore(); }
});

test('people: userUpdated changes only that person; offline restart shows names and photos from IndexedDB', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис'), c = await srv.login('Вера');
  await srv.chat(a.token, [a.userId, b.userId, c.userId]);
  const photo = { id: crypto.randomUUID(), small: crypto.randomUUID(), thumb: 'data:image/jpeg;base64,AAAA', at: 1 };
  await sql`update users set photo = ${sql.json(photo as never)} where id = ${c.userId}`;
  const cfgA = srv.config(a);
  const ea = await open(cfgA), eb = await open(srv.config(b));
  ea.connect(); eb.connect();
  await Promise.all([ea.whenIdle(), eb.whenIdle()]);
  const people = watchInto(ea, { kind: 'people', ids: [b.userId, c.userId] });
  await people.until((x) => x.length === 2);
  expect(people.list()[1]).toMatchObject({ name: 'Вера', photo });
  const before = people.patches.length;

  await eb.call({ type: 'updateProfile', firstName: 'Борис', lastName: 'Новый' });
  await people.until((x) => x[0]?.name === 'Борис Новый');
  const diffs = people.patches.slice(before).filter((p) => p.op === 'diff');
  expect(diffs.flatMap((p) => (p.op === 'diff' ? p.upsert.map((u) => u.key) : []))).toEqual([String(b.userId)]);   // Веру не трогали

  await ea.close(); engines.splice(engines.indexOf(ea), 1);
  const cold = await open(cfgA);   // без connect: сети нет
  const p2 = watchInto(cold, { kind: 'people', ids: [b.userId, c.userId] });
  const l = await p2.until((x) => x.length === 2);
  expect(l).toEqual([
    { key: String(b.userId), id: b.userId, name: 'Борис Новый', photo: null },
    { key: String(c.userId), id: c.userId, name: 'Вера', photo },
  ]);
});
