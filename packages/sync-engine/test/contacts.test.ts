import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { ContactsCache, contactsView } from '../src/contacts';
import { Engine } from '../src/engine';
import { openDb } from '../src/idb';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const closeOne = async (e: Engine) => { await e.close(); engines.splice(engines.indexOf(e), 1); };
const api = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${srv.base}${path}`, { method, headers: { cookie: `relay_session=${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const titleOf = (chatId: number) => (l: { id?: unknown; title?: unknown }[]) => l.find((c) => c.id === chatId)?.title;

test('offline add is visible at once (contacts + chat title), survives a restart, reaches the server on connect', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const cfg = srv.config(a);
  const ea = await open(cfg);
  ea.connect();
  await ea.whenIdle();
  const list = watchInto(ea, { kind: 'chatList', limit: 50 });
  await list.until((l) => titleOf(chatId)(l) === 'Борис');
  const contacts = watchInto(ea, { kind: 'contacts' });
  await contacts.until((l) => l.length === 0 && contacts.patches.length > 0);

  ea.disconnect();
  await ea.call({ type: 'addContact', userId: b.userId, firstName: ' Боря ', lastName: '' });
  await list.until((l) => titleOf(chatId)(l) === 'Боря');
  const c = await contacts.until((l) => l.length === 1);
  expect(c[0]).toMatchObject({ userId: b.userId, name: 'Боря', firstName: 'Боря', pending: true });

  await closeOne(ea);
  const cold = await open(cfg);   // без сети: операция в IDB
  const list2 = watchInto(cold, { kind: 'chatList', limit: 50 });
  await list2.until((l) => titleOf(chatId)(l) === 'Боря');
  cold.connect();
  await cold.whenIdle();
  const server = await (await api(a.token, 'GET', '/contacts')).json();
  expect(server.contacts.map((x: { firstName: string }) => x.firstName)).toEqual(['Боря']);
  const c2 = watchInto(cold, { kind: 'contacts' });
  const done = await c2.until((l) => l[0]?.pending === false);
  expect(done[0]).toMatchObject({ name: 'Боря', publicName: 'Борис' });
  expect(titleOf(chatId)(list2.list())).toBe('Боря');
  // у Бориса имя Анны не изменилось
  const lb = await (await api(b.token, 'GET', '/chats')).json();
  expect(lb.find((x: { id: number }) => x.id === chatId).peer.name).toBe('Анна');
});

test('remove restores the public name at once; edit while the add is queued merges into the add', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const list = watchInto(ea, { kind: 'chatList', limit: 50 });
  const contacts = watchInto(ea, { kind: 'contacts' });
  ea.disconnect();
  await ea.call({ type: 'addContact', userId: b.userId, firstName: 'Боря' });
  await ea.call({ type: 'updateContact', userId: b.userId, lastName: 'К', note: 'коллега' });
  await list.until((l) => titleOf(chatId)(l) === 'Боря К');
  ea.connect();
  await ea.whenIdle();
  await contacts.until((l) => l[0]?.pending === false && l[0]?.note === 'коллега' && l[0]?.name === 'Боря К');

  await ea.call({ type: 'updateContact', userId: b.userId, firstName: 'Борька' });   // PATCH
  await list.until((l) => titleOf(chatId)(l) === 'Борька К');
  await ea.whenIdle();
  expect((await (await api(a.token, 'GET', '/contacts')).json()).contacts[0]).toMatchObject({ firstName: 'Борька', lastName: 'К', note: 'коллега' });

  ea.disconnect();
  await ea.call({ type: 'removeContact', userId: b.userId });
  await list.until((l) => titleOf(chatId)(l) === 'Борис');   // ещё без ответа сервера
  await contacts.until((l) => l.length === 0);
  ea.connect();
  await ea.whenIdle();
  await Bun.sleep(30);
  expect(titleOf(chatId)(list.list())).toBe('Борис');
  expect((await (await api(a.token, 'GET', '/contacts')).json()).contacts).toEqual([]);
});

test('contactsChanged from another device renames the chat; a refused add (stranger) reverts', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис'), s = await srv.login('Чужой');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const list = watchInto(ea, { kind: 'chatList', limit: 50 });
  await api(a.token, 'POST', '/contacts', { userId: b.userId, firstName: 'Боб' });   // «другое устройство»
  await list.until((l) => titleOf(chatId)(l) === 'Боб');
  await api(a.token, 'DELETE', `/contacts/${b.userId}`);
  await list.until((l) => titleOf(chatId)(l) === 'Борис');

  const ops = watchInto(ea, { kind: 'ops' });
  const contacts = watchInto(ea, { kind: 'contacts' });
  await ea.call({ type: 'addContact', userId: s.userId, firstName: 'Кто-то' });
  await ea.whenIdle();
  const o = await ops.until((l) => (l[0]?.failures as unknown[])?.length === 1);
  expect((o[0].failures as { code: string }[])[0].code).toBe('not_found');
  await contacts.until((l) => l.length === 0);
});

test('resolveUser: found (cached for the add), not found, offline', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  await api(b.token, 'PUT', '/me/username', { username: 'boris_k' });
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const r = await ea.call({ type: 'resolveUser', query: '@boris_k' }) as { user: { id: number; name: string } };
  expect(r.user).toMatchObject({ id: b.userId, name: 'Борис' });
  expect(await ea.call({ type: 'resolveUser', query: '@nobody_here' })).toEqual({ notFound: true });
  // контакт без общего чата: имя и @username есть сразу (профиль в кэше)
  const contacts = watchInto(ea, { kind: 'contacts' });
  ea.disconnect();
  expect(await ea.call({ type: 'resolveUser', query: '@boris_k' })).toEqual({ offline: true });
  await ea.call({ type: 'addContact', userId: b.userId, firstName: 'Боря' });
  const c = await contacts.until((l) => l.length === 1);
  expect(c[0]).toMatchObject({ name: 'Боря', username: 'boris_k', publicName: 'Борис' });
});

test('contactsView replays ops in order over the base', () => {
  const user = { id: 2, name: 'Борис', firstName: 'Борис', lastName: '', publicName: 'Борис', username: null, bio: null, birthday: null, phone: null };
  const base = new Map([[2, { userId: 2, firstName: 'Боря', lastName: '', note: 'n', user }]]);
  const v = contactsView(base, [
    { id: 1, key: 'contact:2', method: 'PATCH', path: '/contacts/2', body: { lastName: ' К ' }, at: 0 },
    { id: 2, key: 'contact:3', method: 'POST', path: '/contacts', body: { userId: 3, firstName: 'Вера' }, at: 0 },
    { id: 3, key: 'contact:3', method: 'DELETE', path: '/contacts/3', at: 0 },
    { id: 4, key: 'profile', method: 'PATCH', path: '/me', body: { firstName: 'x' }, at: 0 },
  ], new Map());
  expect([...v.keys()]).toEqual([2]);
  expect(v.get(2)).toMatchObject({ firstName: 'Боря', lastName: 'К', note: 'n', pending: true });
});

test('race: a snapshot without the contact lands before the older journal removal → the public name still comes back', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  await api(a.token, 'POST', '/contacts', { userId: b.userId, firstName: 'Боря' });
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const list = watchInto(ea, { kind: 'chatList', limit: 50 });
  await list.until((l) => titleOf(chatId)(l) === 'Боря');
  ea.disconnect();
  // удалили на другом устройстве; снимок (seq 10) приходит раньше записи журнала (seq 9)
  const user = { id: b.userId, name: 'Борис', firstName: 'Борис', lastName: '', publicName: 'Борис', username: null, bio: null, birthday: null, phone: null };
  ea.store.contacts.applySnapshot([], 1000);
  ea.store.applyUpdate({ type: 'contactsChanged', removed: b.userId, user }, 999);
  watchInto(ea, { kind: 'counters' });   // проход подписок
  await list.until((l) => titleOf(chatId)(l) === 'Борис');
  expect(ea.store.chats.get(chatId)!.title).toBe('Борис');   // и в базе (IDB) — не только на экране
});

test('remote removal while closed: reopen shows the public name; cached profile loses the contact name', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  await api(b.token, 'PUT', '/me/username', { username: 'boris_k' });
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  await api(a.token, 'POST', '/contacts', { userId: b.userId, firstName: 'Боря' });
  const cfg = srv.config(a);
  const ea = await open(cfg);
  ea.connect();
  await ea.whenIdle();
  const user = watchInto(ea, { kind: 'user', userId: b.userId });
  await user.until((l) => l[0]?.name === 'Боря');
  await closeOne(ea);
  await api(a.token, 'DELETE', `/contacts/${b.userId}`);
  const e2 = await open(cfg);
  e2.connect();
  await e2.whenIdle();
  const list = watchInto(e2, { kind: 'chatList', limit: 50 });
  await list.until((l) => titleOf(chatId)(l) === 'Борис');
  const u2 = watchInto(e2, { kind: 'user', userId: b.userId });
  await u2.until((l) => l[0]?.name === 'Борис');
});

test('removal of a contact without a shared chat (server sends user: null) drops the contact name from the cache', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  await api(b.token, 'PUT', '/me/username', { username: 'boris_k' });
  await api(a.token, 'POST', '/contacts', { query: '@boris_k', firstName: 'Боря' });
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const user = watchInto(ea, { kind: 'user', userId: b.userId });
  await user.until((l) => l[0]?.name === 'Боря');
  await api(a.token, 'DELETE', `/contacts/${b.userId}`);
  await user.until((l) => l[0]?.name === 'Борис' && l[0]?.firstName === 'Борис');
});

test('after reset (epoch wipe) contacts are not «loaded» until a real snapshot', async () => {
  const db = await openDb('contacts-' + crypto.randomUUID());
  const c = new ContactsCache();
  c.applySnapshot([], 5);
  expect((await ContactsCache.load(db, c.collect().meta)).loaded).toBe(true);
  c.reset();
  expect((await ContactsCache.load(db, c.collect().meta)).loaded).toBe(false);
});
