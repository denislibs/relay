import { afterAll, beforeEach, expect, test } from 'bun:test';
import type { ServerFrame, Update } from '@relay/protocol';
import { getUpdates } from '../src/domain/journal';
import { parseQuery } from '../src/domain/contacts';
import { resetPresence } from '../src/domain/presence';
import { createServer } from '../src/http';
import { makeChat, nextFrame, resetDb } from './helpers';

process.env.RELAY_PRESENCE_GRACE_MS = '60';
const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(async () => { await resetDb(); resetPresence(); });

type U = { userId: number; token: string };
async function login(name: string, phone?: string): Promise<U> {
  const res = await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name, phone }) });
  return (await res.json()) as U;
}
const call = (u: U, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { cookie: `relay_session=${u.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => [r.status, await r.json()] as const;
const journal = async (userId: number) => (await getUpdates(userId, 0)).items.map((i) => i.update);
const ofType = <T extends Update['type']>(us: Update[], t: T) => us.filter((u): u is Extract<Update, { type: T }> => u.type === t);
const peerName = async (u: U, chatId: number) => ((await (await call(u, 'GET', '/chats')).json()) as { id: number; peer: { name: string } | null }[]).find((c) => c.id === chatId)?.peer?.name;

test('parseQuery: @username, username, phone normalization', () => {
  expect(parseQuery('@Boris_K')).toEqual({ username: 'boris_k' });
  expect(parseQuery(' boris_k ')).toEqual({ username: 'boris_k' });
  expect(parseQuery('+7 (900) 123-45-67')).toEqual({ phone: '+79001234567' });
  expect(parseQuery('8 900 123 45 67')).toEqual({ phone: '+79001234567' });
  expect(parseQuery('9001234567')).toBeNull();   // без «+» — не номер
  expect(parseQuery('ab')).toBeNull();
  expect(parseQuery('')).toBeNull();
  expect(parseQuery(5)).toBeNull();
});

test('resolve by @username and by phone; self and unknown → 404; phone hidden', async () => {
  const a = await login('Анна'), b = await login('Борис Котов', '+79001234567');
  await call(b, 'PUT', '/me/username', { username: 'boris_k' });
  const [s1, u1] = await json(await call(a, 'GET', '/users/resolve?q=%40Boris_K'));
  expect(s1).toBe(200);
  expect(u1).toMatchObject({ id: b.userId, name: 'Борис Котов', publicName: 'Борис Котов', username: 'boris_k', phone: null });
  const [s2, u2] = await json(await call(a, 'GET', '/users/resolve?q=' + encodeURIComponent('8 (900) 123-45-67')));
  expect([s2, u2.id]).toEqual([200, b.userId]);
  expect((await call(b, 'GET', '/users/resolve?q=boris_k')).status).toBe(404);   // себя не находим
  const [s3, e3] = await json(await call(a, 'GET', '/users/resolve?q=nobody_here'));
  expect([s3, e3.code]).toEqual([404, 'not_found']);
  expect((await call(a, 'GET', '/users/resolve?q=%2B79990000000')).status).toBe(404);
  expect((await call(a, 'GET', '/users/resolve')).status).toBe(404);
});

test('add by query: contact name only for the owner (listChats, /users/:id, search), the other side sees the public name', async () => {
  const a = await login('Анна Смирнова'), b = await login('Борис Котов');
  await call(b, 'PUT', '/me/username', { username: 'boris_k' });
  const chatId = await makeChat([a.userId, b.userId]);
  const [st, c] = await json(await call(a, 'POST', '/contacts', { query: '@boris_k', firstName: ' Боря ', lastName: '' }));
  expect(st).toBe(200);
  expect(c).toMatchObject({ userId: b.userId, firstName: 'Боря', lastName: '', note: '', user: { id: b.userId, name: 'Боря', publicName: 'Борис Котов' }, presence: { online: false } });
  expect(typeof c.seq).toBe('number');

  expect(await peerName(a, chatId)).toBe('Боря');
  expect(await peerName(b, chatId)).toBe('Анна Смирнова');
  expect((await (await call(a, 'GET', `/users/${b.userId}`)).json()).name).toBe('Боря');
  expect((await (await call(b, 'GET', `/users/${a.userId}`)).json()).name).toBe('Анна Смирнова');

  // contactsChanged — владельцу, в журнал, seq ответа = seq записи
  const items = (await getUpdates(a.userId, 0)).items.filter((i) => i.update.type === 'contactsChanged');
  expect(items.length).toBe(1);
  expect(items[0].seq).toBe(c.seq);
  expect(ofType(await journal(b.userId), 'contactsChanged')).toEqual([]);

  const list = await (await call(a, 'GET', '/contacts')).json();
  expect(list.seq).toBe(c.seq);
  expect(list.contacts.map((x: { userId: number; firstName: string }) => [x.userId, x.firstName])).toEqual([[b.userId, 'Боря']]);
  expect((await (await call(b, 'GET', '/contacts')).json()).contacts).toEqual([]);
});

test('userUpdated to the owner carries the contact name; others get the public one; contacts owner becomes a viewer', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  await call(b, 'PUT', '/me/username', { username: 'boris_k' });
  await makeChat([b.userId, c.userId]);
  await call(a, 'POST', '/contacts', { query: 'boris_k', firstName: 'Боря', lastName: 'К' });   // общего чата нет
  await call(b, 'PATCH', '/me', { bio: 'новое' });
  const toA = ofType(await journal(a.userId), 'userUpdated');
  expect(toA.length).toBe(1);
  expect(toA[0].user).toMatchObject({ id: b.userId, name: 'Боря К', firstName: 'Боря', lastName: 'К', publicName: 'Борис', bio: 'новое' });
  const toC = ofType(await journal(c.userId), 'userUpdated');
  expect(toC[toC.length - 1].user).toMatchObject({ name: 'Борис', firstName: 'Борис', publicName: 'Борис' });
  // контакт без общего чата — профиль доступен владельцу; и самому контакту (у кого он в контактах)
  expect((await call(a, 'GET', `/users/${b.userId}`)).status).toBe(200);
  expect((await call(b, 'GET', `/users/${a.userId}`)).status).toBe(200);
  expect((await call(c, 'GET', `/users/${a.userId}`)).status).toBe(404);
});

test('upsert, PATCH with note, note limit, delete restores the public name', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await makeChat([a.userId, b.userId]);
  await call(a, 'POST', '/contacts', { userId: b.userId, firstName: 'Боря' });
  const [s1, c1] = await json(await call(a, 'POST', '/contacts', { userId: b.userId, firstName: 'Борис', lastName: 'Друг' }));
  expect([s1, c1.firstName, c1.lastName]).toEqual([200, 'Борис', 'Друг']);
  expect((await (await call(a, 'GET', '/contacts')).json()).contacts.length).toBe(1);

  const [s2, c2] = await json(await call(a, 'PATCH', `/contacts/${b.userId}`, { note: 'Коллега 😀'.padEnd(10, ' ') }));
  expect([s2, c2.note, c2.firstName]).toEqual([200, 'Коллега 😀', 'Борис']);
  expect((await call(a, 'PATCH', `/contacts/${b.userId}`, { note: '😀'.repeat(128) })).status).toBe(200);
  const [s3, e3] = await json(await call(a, 'PATCH', `/contacts/${b.userId}`, { note: '😀'.repeat(129) }));
  expect([s3, e3.code]).toEqual([400, 'note_too_long']);
  const [s4, e4] = await json(await call(a, 'PATCH', `/contacts/${b.userId}`, { firstName: '' }));
  expect([s4, e4.code]).toEqual([400, 'name_invalid']);
  expect((await call(a, 'POST', '/contacts', { userId: b.userId, firstName: 'x'.repeat(65) })).status).toBe(400);
  // upsert сохраняет заметку
  await call(a, 'POST', '/contacts', { userId: b.userId, firstName: 'Боря' });
  expect((await (await call(a, 'GET', '/contacts')).json()).contacts[0].note).toBe('😀'.repeat(128));
  expect(await peerName(a, chatId)).toBe('Боря');

  const [s5, r5] = await json(await call(a, 'DELETE', `/contacts/${b.userId}`));
  expect([s5, r5.removed, r5.user.name]).toEqual([200, b.userId, 'Борис']);
  expect(await peerName(a, chatId)).toBe('Борис');
  expect((await (await call(a, 'GET', `/users/${b.userId}`)).json()).name).toBe('Борис');
  const removed = ofType(await journal(a.userId), 'contactsChanged').pop()!;
  expect(removed).toMatchObject({ removed: b.userId, user: { name: 'Борис', publicName: 'Борис' } });
  // повторное удаление — не ошибка и без записи в журнал
  const before = (await getUpdates(a.userId, 0)).seq;
  expect((await call(a, 'DELETE', `/contacts/${b.userId}`)).status).toBe(200);
  expect((await getUpdates(a.userId, 0)).seq).toBe(before);
  expect((await call(a, 'PATCH', `/contacts/${b.userId}`, { note: 'x' })).status).toBe(404);
});

test('add: self, stranger by id and unknown query → 404; bad bodies → 400', async () => {
  const a = await login('Анна'), s = await login('Посторонний');
  expect((await call(a, 'POST', '/contacts', { userId: a.userId, firstName: 'Я' })).status).toBe(404);
  expect((await call(a, 'POST', '/contacts', { userId: s.userId, firstName: 'Чужой' })).status).toBe(404);
  expect((await call(a, 'POST', '/contacts', { query: '@nobody_here', firstName: 'Кто' })).status).toBe(404);
  expect((await call(a, 'POST', '/contacts', { userId: s.userId })).status).toBe(400);
  expect((await call(a, 'POST', '/contacts', 'x')).status).toBe(400);
  expect((await call(a, 'POST', '/contacts', { userId: 'x', firstName: 'Кто' })).status).toBe(400);
});

test('presence: a contact without a direct chat is announced to the owner and listed in /presence', async () => {
  const a = await login('Анна'), b = await login('Борис');
  await call(b, 'PUT', '/me/username', { username: 'boris_k' });
  await call(a, 'POST', '/contacts', { query: 'boris_k', firstName: 'Боря' });
  const wa = new WebSocket(`ws://localhost:${server.port}/ws?token=${a.token}`);
  await new Promise((r, j) => { wa.onopen = r; wa.onerror = j; });
  const online = nextFrame(wa, (f) => f.op === 'presence');
  const wb = new WebSocket(`ws://localhost:${server.port}/ws?token=${b.token}`);
  await new Promise((r, j) => { wb.onopen = r; wb.onerror = j; });
  expect(((await online) as Extract<ServerFrame, { op: 'presence' }>).items).toEqual([{ userId: b.userId, online: true, lastSeen: null }]);
  const pa = await (await call(a, 'GET', '/presence')).json();
  expect(pa.find((p: { userId: number }) => p.userId === b.userId)?.online).toBe(true);
  // в обратную сторону — нет: Борис не добавлял Анну
  expect((await (await call(b, 'GET', '/presence')).json())).toEqual([]);
  expect((await (await call(a, 'GET', '/contacts')).json()).contacts[0].presence.online).toBe(true);
  wa.close(); wb.close();
});
