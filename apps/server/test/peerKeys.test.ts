import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { handleFrame } from '../src/ws';
import { peerKey, peerKeyOk } from '../src/crypto/peerKey';
import { makeChat, ref, refs, resetDb } from './helpers';

// H1 (аудит 2026-10-31): голый id человека ничего не открывает — нужен ключ доступа зрителя или сообщение, где человек назван.

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);
type U = { userId: number; token: string };
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const call = (u: U, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { cookie: `relay_session=${u.token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const res = async (r: Response) => [r.status, await r.json()];

test('a key is per viewer, fixed length, and checked in constant shape', () => {
  expect(peerKey(1, 2)).toHaveLength(16);
  expect(peerKey(1, 2)).toBe(peerKey(1, 2));
  expect(peerKey(1, 2)).not.toBe(peerKey(3, 2));   // ключ другого зрителя к тому же человеку
  expect(peerKeyOk(1, 2, peerKey(1, 2))).toBe(true);
  expect(peerKeyOk(3, 2, peerKey(1, 2))).toBe(false);
  for (const bad of [undefined, null, 5, '', 'x'.repeat(16), peerKey(1, 2) + 'A']) expect(peerKeyOk(1, 2, bad)).toBe(false);
  expect(peerKeyOk(7, 7, undefined)).toBe(true);   // себе ключ не нужен
});

test('a stranger cannot open a chat by bare id, by someone else\'s key, or tell a real id from a missing one', async () => {
  const a = await login('Анна'), b = await login('Борис'), s = await login('Посторонний');
  await makeChat([a.userId, b.userId]);
  const notFound = [404, { code: 'not_found' }];
  expect(await res(await call(s, 'POST', '/chats/direct', { userId: a.userId }))).toEqual(notFound);                         // без ключа
  expect(await res(await call(s, 'POST', '/chats/direct', { userId: a.userId, key: peerKey(b.userId, a.userId) }))).toEqual(notFound);   // ключ Бориса
  expect(await res(await call(s, 'POST', '/chats/direct', { userId: 999999, key: peerKey(s.userId, a.userId) }))).toEqual(notFound);  // такого нет — тот же ответ
  expect(await res(await call(s, 'POST', '/chats/direct', { userId: a.userId, via: { chatId: 1, messageId: 1 } }))).toEqual(notFound);  // чужое сообщение
  expect((await sql`select count(*)::int as n from chat_members where user_id = ${s.userId}`)[0].n).toBe(0);
  // группа и добавление в группу — так же
  expect(await res(await call(s, 'POST', '/chats', { title: 'Г', members: [{ id: a.userId }] }))).toEqual(notFound);
  const g = (await (await call(s, 'POST', '/chats', { kind: 'channel', title: 'К' })).json()).id as number;
  expect(await res(await call(s, 'POST', `/groups/${g}/members`, { users: [{ id: a.userId, key: peerKey(b.userId, a.userId) }] }))).toEqual(notFound);
  // старая форма с голыми id больше не принимается
  expect((await call(s, 'POST', `/groups/${g}/members`, { userIds: [a.userId] })).status).toBe(400);
  expect((await call(s, 'POST', '/users/' + a.userId + '/music')).status).not.toBe(200);
  expect(await res(await call(s, 'GET', `/users/${a.userId}/music`))).toEqual(notFound);
});

test('keys come from where the person is legitimately seen, and work there', async () => {
  const a = await login('Анна'), b = await login('Борис'), s = await login('Посторонний');
  await makeChat([a.userId, b.userId]);
  // Борис видит Анну (общий чат): ключ — в профиле, в GET /users?ids=, у собеседника в списке чатов
  const viaUsers = ((await (await call(b, 'GET', `/users?ids=${a.userId}`)).json()) as { users: { id: number; key?: string }[] }).users[0];
  expect(viaUsers.key).toBe(peerKey(b.userId, a.userId));
  const list = (await (await call(b, 'GET', '/chats')).json()) as { peer: { id: number; key?: string } | null }[];
  expect(list.find((c) => c.peer?.id === a.userId)?.peer?.key).toBe(viaUsers.key);
  // посторонний Анну не видит — и ключа не получает
  expect(((await (await call(s, 'GET', `/users?ids=${a.userId}`)).json()) as { users: unknown[] }).users).toEqual([]);
  // знакомство по @имени — законный путь: ключ приходит с найденным профилем и открывает чат
  await call(a, 'PUT', '/me/username', { username: 'anna_h1' });
  const found = (await (await call(s, 'POST', '/users/resolve', { query: '@anna_h1' })).json()) as { id: number; key: string };
  expect(found.key).toBe(peerKey(s.userId, a.userId));
  const r = await call(s, 'POST', '/chats/direct', { userId: a.userId, key: found.key });
  expect(r.status).toBe(200);
  // и поиск людей по точному @имени — с ключом
  const people = (await (await call(s, 'GET', '/search/people?q=anna_h1')).json()) as { people: { id: number; key: string }[] };
  expect(people.people[0]).toMatchObject({ id: a.userId, key: peerKey(s.userId, a.userId) });
});

test('a contact card: sharing needs a ref; the receiver can write to the person through the message (like inputUserFromMessage)', async () => {
  const a = await login('Анна'), b = await login('Борис'), v = await login('Вера');
  const ab = await makeChat([a.userId, b.userId]);
  await makeChat([a.userId, v.userId]);   // Анна знает Веру
  const frame = (from: U, contact: Record<string, unknown>) => handleFrame(from.userId, { op: 'send', reqId: 'r', clientId: crypto.randomUUID(), chatId: ab, body: '', entities: [], replyToId: null, attachment: null, groupId: null, forward: null, contact } as never);
  // без ключа и с чужим ключом — not_found, имя не раскрывается
  expect((await frame(a, { userId: v.userId }))[0]).toMatchObject({ op: 'err', code: 'not_found' });
  expect((await frame(a, { userId: v.userId, key: peerKey(b.userId, v.userId) }))[0]).toMatchObject({ op: 'err', code: 'not_found' });
  const [ack] = await frame(a, { userId: v.userId, key: peerKey(a.userId, v.userId) });
  expect(ack).toMatchObject({ op: 'ack' });
  const messageId = (ack as { result: { id: number } }).result.id;
  // Борис Веру не видит (общего чата нет) — ключа у него нет, но карточка в его чате называет её
  expect(((await (await call(b, 'GET', `/users?ids=${v.userId}`)).json()) as { users: unknown[] }).users).toEqual([]);
  const r = await call(b, 'POST', '/chats/direct', { userId: v.userId, via: { chatId: ab, messageId } });
  expect(r.status).toBe(200);
  // а сообщение, где этот человек не назван, ничего не даёт
  const other = await call(b, 'POST', '/chats/direct', { userId: 999999, via: { chatId: ab, messageId } });
  expect(other.status).toBe(404);
});

test('group creation and adding members take refs (test helpers mint keys as a client that sees the people would)', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  await makeChat([a.userId, b.userId]); await makeChat([a.userId, c.userId]);
  const g = (await (await call(a, 'POST', '/chats', { title: 'Дача', members: refs(a.userId, [b.userId]) })).json()).id as number;
  expect((await call(a, 'POST', `/groups/${g}/members`, { users: refs(a.userId, [c.userId]) })).status).toBe(200);
  const members = (await sql`select user_id from chat_members where chat_id = ${g} order by user_id`).map((r) => Number(r.user_id));
  expect(members).toEqual([a.userId, b.userId, c.userId].sort((x, y) => x - y));
  expect((await call(a, 'POST', '/chats/direct', ref(a.userId, c.userId))).status).toBe(200);
});
