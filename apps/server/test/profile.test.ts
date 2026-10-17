import { afterAll, beforeEach, expect, test } from 'bun:test';
import type { Update } from '@relay/protocol';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { getUpdates } from '../src/domain/journal';
import { makeChat, resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

async function login(name: string, phone?: string) {
  const res = await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name, phone }) });
  return (await res.json()) as { userId: number; token: string };
}
type U = { userId: number; token: string };
const call = (u: U, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { cookie: `relay_session=${u.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const updates = async (userId: number) => (await getUpdates(userId, 0)).items.map((i) => i.update).filter((u): u is Extract<Update, { type: 'userUpdated' }> => u.type === 'userUpdated');

test('GET /me: extended shape, userId and name kept', async () => {
  const a = await login('Анна Смирнова', '+79001234567');
  const me = await (await call(a, 'GET', '/me')).json();
  expect(me).toEqual({ userId: a.userId, name: 'Анна Смирнова', firstName: 'Анна', lastName: 'Смирнова', username: null, bio: null, birthday: null, phone: '+79001234567' });
});

test('PATCH /me: name, bio, birthday; display name recomputed', async () => {
  const a = await login('Анна');
  const res = await call(a, 'PATCH', '/me', { firstName: ' Анна ', lastName: 'Смирнова', bio: ' Привет 👋 https://x.dev ', birthday: { day: 29, month: 2 } });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ name: 'Анна Смирнова', firstName: 'Анна', lastName: 'Смирнова', bio: 'Привет 👋 https://x.dev', birthday: { day: 29, month: 2 } });
  const [row] = await sql`select name from users where id = ${a.userId}`;
  expect(row.name).toBe('Анна Смирнова');
  // отсутствующие ключи не трогаем; null стирает
  const r2 = await (await call(a, 'PATCH', '/me', { birthday: null, bio: '' })).json();
  expect(r2).toMatchObject({ name: 'Анна Смирнова', bio: null, birthday: null });
});

test('name validation', async () => {
  const a = await login('Анна');
  for (const body of [{ firstName: '' }, { firstName: '   ' }, { firstName: 'x'.repeat(65) }, { lastName: 'y'.repeat(65) }, { firstName: 5 }, { firstName: 'a\u0000b' }]) {
    const res = await call(a, 'PATCH', '/me', body);
    expect([res.status, (await res.json()).code]).toEqual([400, 'name_invalid']);
  }
  expect((await call(a, 'PATCH', '/me', { firstName: 'x'.repeat(64), lastName: '' })).status).toBe(200);
});

test('bio over 140 code points → 400 bio_too_long; exactly 140 (emoji) ok', async () => {
  const a = await login('Анна');
  const res = await call(a, 'PATCH', '/me', { bio: 'я'.repeat(141) });
  expect([res.status, (await res.json()).code]).toEqual([400, 'bio_too_long']);
  expect((await call(a, 'PATCH', '/me', { bio: '😀'.repeat(140) })).status).toBe(200);
  expect((await call(a, 'PATCH', '/me', { bio: '😀'.repeat(141) })).status).toBe(400);
});

test('birthday validation', async () => {
  const a = await login('Анна');
  const year = new Date().getUTCFullYear();
  const bad = [{ day: 31, month: 2 }, { day: 30, month: 2, year: 2000 }, { day: 29, month: 2, year: 2001 }, { day: 0, month: 1 }, { day: 1, month: 13 },
    { day: 1, month: 1, year: 1899 }, { day: 1, month: 1, year: year + 1 }, { day: 31, month: 4 }, { day: 1.5, month: 1 }, 'x', {}];
  for (const birthday of bad) {
    const res = await call(a, 'PATCH', '/me', { birthday });
    expect([JSON.stringify(birthday), res.status, (await res.json()).code]).toEqual([JSON.stringify(birthday), 400, 'birthday_invalid']);
  }
  for (const birthday of [{ day: 29, month: 2, year: 2000 }, { day: 31, month: 12, year: 1900 }, { day: 1, month: 1 }]) {
    expect((await call(a, 'PATCH', '/me', { birthday })).status).toBe(200);
  }
});

test('username rules table', async () => {
  const a = await login('Анна');
  const cases: [string, 'ok' | 'invalid' | 'reserved'][] = [
    ['anna_s', 'ok'], ['Annas', 'ok'], ['@anna1', 'ok'], ['a'.repeat(32), 'ok'], ['a'.repeat(33), 'invalid'], ['abcd', 'invalid'],
    ['1anna', 'invalid'], ['_anna', 'invalid'], ['anna_', 'invalid'], ['an__na', 'invalid'], ['an-na1', 'invalid'], ['аннаа', 'invalid'], ['an na', 'invalid'], ['',  'invalid'],
    ['admin', 'reserved'], ['Relay', 'reserved'], ['support', 'reserved'], ['settings', 'reserved'], ['undefined', 'reserved'], ['system', 'reserved'],
  ];
  for (const [u, want] of cases) {
    const chk = await (await call(a, 'GET', `/users/check-username?u=${encodeURIComponent(u)}`)).json();
    expect([u, want === 'ok' ? chk.ok : chk.reason]).toEqual([u, want === 'ok' ? true : want]);
    const put = await call(a, 'PUT', '/me/username', { username: u });
    const code = want === 'ok' ? 200 : 400;
    expect([u, put.status]).toEqual([u, code]);
    if (want !== 'ok') expect((await put.json()).code).toBe(want === 'reserved' ? 'username_reserved' : 'username_invalid');
  }
  expect((await call(a, 'GET', '/users/check-username')).status).toBe(200);
});

test('username stored lowercased, case-insensitively unique, removable, own name is ok', async () => {
  const a = await login('Анна'), b = await login('Борис');
  expect(await (await call(a, 'PUT', '/me/username', { username: 'Anna_Smirnova' })).json()).toMatchObject({ username: 'anna_smirnova' });
  expect(await (await call(b, 'GET', '/users/check-username?u=ANNA_smirnova')).json()).toEqual({ ok: false, reason: 'taken' });
  expect(await (await call(a, 'GET', '/users/check-username?u=anna_smirnova')).json()).toEqual({ ok: true });
  const dup = await call(b, 'PUT', '/me/username', { username: 'anna_smirnova' });
  expect([dup.status, (await dup.json()).code]).toEqual([409, 'username_taken']);
  expect(await (await call(a, 'PUT', '/me/username', { username: null })).json()).toMatchObject({ username: null });
  expect((await call(b, 'PUT', '/me/username', { username: 'anna_smirnova' })).status).toBe(200);
  expect((await call(b, 'PUT', '/me/username', {})).status).toBe(400);
});

test('race: two concurrent PUTs of the same username → exactly one 409', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const rs = await Promise.all([call(a, 'PUT', '/me/username', { username: 'racer_one' }), call(b, 'PUT', '/me/username', { username: 'racer_one' })]);
  expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
  const [n] = await sql`select count(*)::int as n from users where username = 'racer_one'`;
  expect(n.n).toBe(1);
});

test('userUpdated reaches self and chat peers (direct + group), not strangers', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера'), d = await login('Глеб'), s = await login('Посторонний');
  await makeChat([a.userId, b.userId]);
  await makeChat([a.userId, c.userId, d.userId]);
  await call(a, 'PATCH', '/me', { firstName: 'Анастасия', bio: 'hi' });
  await call(a, 'PUT', '/me/username', { username: 'nastya_a' });
  for (const id of [a.userId, b.userId, c.userId, d.userId]) {
    const us = await updates(id);
    expect(us.length).toBe(2);
    expect(us[1].user).toMatchObject({ id: a.userId, name: 'Анастасия', firstName: 'Анастасия', bio: 'hi', username: 'nastya_a' });
  }
  expect(await updates(s.userId)).toEqual([]);
});

test('GET /users/:id: self and chat peer ok, stranger 404', async () => {
  const a = await login('Анна', '+79005550001'), b = await login('Борис'), s = await login('Посторонний');
  await makeChat([a.userId, b.userId]);
  await call(a, 'PUT', '/me/username', { username: 'anna_x' });
  expect(await (await call(b, 'GET', `/users/${a.userId}`)).json()).toEqual({ id: a.userId, name: 'Анна', firstName: 'Анна', lastName: '', username: 'anna_x', bio: null, birthday: null, phone: '+79005550001' });
  expect((await call(a, 'GET', `/users/${a.userId}`)).status).toBe(200);
  const r = await call(s, 'GET', `/users/${a.userId}`);
  expect([r.status, (await r.json()).code]).toEqual([404, 'not_found']);
  expect((await call(s, 'GET', '/users/99999')).status).toBe(404);
});

test('dev login: phone set once, duplicate phone does not break login', async () => {
  const a = await login('Анна', '+79001112233');
  const b = await login('Борис', '+79001112233');
  expect((await (await call(a, 'GET', '/me')).json()).phone).toBe('+79001112233');
  expect((await (await call(b, 'GET', '/me')).json()).phone).toBeNull();
});
