import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { sql } from '../src/db';
import { resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const as = (t: string) => ({ cookie: `relay_session=${t}` });

test('names of people I share a chat with, mine too; strangers stay hidden', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера'), x = await login('Чужой');
  await fetch(`${base}/dev/chats`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ kind: 'group', title: 'Дача', memberIds: [a.userId, b.userId, c.userId] }) });
  const res = await (await fetch(`${base}/users?ids=${[a.userId, b.userId, c.userId, x.userId, 0, 'zz'].join(',')}`, { headers: as(a.token) })).json() as { users: { id: number; name: string }[] };
  expect(res.users.sort((p, q) => p.id - q.id).map((u) => [u.id, u.name])).toEqual([[a.userId, 'Анна'], [b.userId, 'Борис'], [c.userId, 'Вера']]);
  expect((await fetch(`${base}/users?ids=${a.userId}`)).status).toBe(401);
});

test('a contact name I set wins over the public name', async () => {
  const a = await login('Анна'), b = await login('Борис');
  await fetch(`${base}/dev/chats`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) });
  const put = await fetch(`${base}/contacts`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ userId: b.userId, firstName: 'Боря', lastName: 'Дача' }) });
  expect(put.ok).toBe(true);
  const res = await (await fetch(`${base}/users?ids=${b.userId}`, { headers: as(a.token) })).json() as { users: { id: number; name: string }[] };
  expect(res.users).toMatchObject([{ id: b.userId, name: 'Боря Дача', firstName: 'Боря', lastName: 'Дача', publicName: 'Борис' }]);
  const theirs = await (await fetch(`${base}/users?ids=${b.userId}`, { headers: as(b.token) })).json() as { users: { id: number; name: string }[] };
  expect(theirs.users).toMatchObject([{ id: b.userId, name: 'Борис' }]);
});

const ids = (...u: { userId: number }[]) => u.map((x) => x.userId).join(',');
type Full = { users: Record<string, unknown>[]; seq: number };
const get = async (t: { token: string }, path: string) => (await (await fetch(`${base}${path}`, { headers: as(t.token) })).json()) as Full;
const direct = (t: { token: string }, a: number, b: number) =>
  fetch(`${base}/dev/chats`, { method: 'POST', headers: as(t.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a, b] }) });

test('full PublicUser per id, same as GET /users/:id; seq is the viewer own seq', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  await fetch(`${base}/dev/chats`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ kind: 'group', title: 'Дача', memberIds: [a.userId, b.userId, c.userId] }) });
  await sql`update users set bio = 'о себе', username = 'boris_x' where id = ${b.userId}`;
  const patched = await (await fetch(`${base}/me`, { method: 'PATCH', headers: as(a.token), body: JSON.stringify({ bio: 'я' }) })).json() as { seq: number };
  const res = await get(a, `/users?ids=${ids(a, b, c)}`);
  const one = await (await fetch(`${base}/users/${b.userId}`, { headers: as(a.token) })).json();
  expect(res.users.find((u) => u.id === b.userId)).toEqual(one);
  expect(one).toMatchObject({ bio: 'о себе', username: 'boris_x', publicName: 'Борис' });
  expect(res.seq).toBe(patched.seq);
  expect(res.seq).toBeGreaterThan(0);
  expect(res.users.find((u) => u.id === a.userId)).toMatchObject({ bio: 'я' });
  expect((await get(a, '/users?ids=')).users).toEqual([]);
});

test('fields hidden by privacy rules are null', async () => {
  const a = await login('Анна'), b = await login('Борис');
  await direct(a, a.userId, b.userId);
  await sql`update users set bio = 'тайна' where id = ${b.userId}`;
  expect((await get(a, `/users?ids=${b.userId}`)).users[0]!.bio).toBe('тайна');
  const r = await fetch(`${base}/privacy/bio`, { method: 'PUT', headers: as(b.token), body: JSON.stringify({ mode: 'nobody', allow: [], deny: [] }) });
  expect(r.ok).toBe(true);
  expect((await get(a, `/users?ids=${b.userId}`)).users[0]!.bio).toBeNull();
  expect((await get(b, `/users?ids=${b.userId}`)).users[0]!.bio).toBe('тайна');   // себе — всё
});

test('a stranger without chat or contact is omitted; a contact without a shared chat is returned (as GET /users/:id)', async () => {
  const a = await login('Анна'), x = await login('Чужой'), k = await login('Контакт');
  expect((await get(a, `/users?ids=${ids(x, k)}`)).users).toEqual([]);
  await sql`insert into contacts (owner_id, user_id, first_name, last_name) values (${a.userId}, ${k.userId}, 'Ко', 'Нтакт')`;
  const res = await get(a, `/users?ids=${ids(x, k)}`);
  expect(res.users.map((u) => [u.id, u.name])).toEqual([[k.userId, 'Ко Нтакт']]);
  expect((await fetch(`${base}/users/${x.userId}`, { headers: as(a.token) })).status).toBe(404);
});

test('a user who blocked me: no photo, no music, blocksMe', async () => {
  const a = await login('Анна'), b = await login('Борис');
  await direct(a, a.userId, b.userId);
  const photo = { id: 1 }, music = { count: 1, top: { id: 1, title: 'T', duration: 1 } };
  await sql`update users set photo = ${sql.json(photo)}, music = ${sql.json(music)} where id = ${b.userId}`;
  const before = (await get(a, `/users?ids=${b.userId}`)).users[0]!;
  expect([before.photo, before.music, before.blocksMe]).toEqual([photo, music, false]);
  expect((await fetch(`${base}/blocks/${a.userId}`, { method: 'PUT', headers: as(b.token) })).ok).toBe(true);
  const after = (await get(a, `/users?ids=${b.userId}`)).users[0]!;
  expect([after.photo, after.music, after.blocksMe]).toEqual([null, null, true]);
});
