import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
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
  expect(res.users.sort((p, q) => p.id - q.id)).toEqual([{ id: a.userId, name: 'Анна' }, { id: b.userId, name: 'Борис' }, { id: c.userId, name: 'Вера' }]);
  expect((await fetch(`${base}/users?ids=${a.userId}`)).status).toBe(401);
});
