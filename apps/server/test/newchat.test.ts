import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const as = (t: string) => ({ cookie: `relay_session=${t}`, 'content-type': 'application/json' });
const post = (path: string, t: string, body: unknown) => fetch(base + path, { method: 'POST', headers: as(t), body: JSON.stringify(body) });

test('group: creator and members, a "created the group" service message reaches every member', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const res = await post('/chats', a.token, { title: '  Дача  2026 ', memberIds: [b.userId, c.userId, b.userId, a.userId] });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: number };
  const [chat] = await sql`select kind, title from chats where id = ${id}`;
  expect(chat).toMatchObject({ kind: 'group', title: 'Дача 2026' });
  const members = (await sql`select user_id from chat_members where chat_id = ${id} order by user_id`).map((r) => Number(r.user_id));
  expect(members).toEqual([a.userId, b.userId, c.userId].sort((x, y) => x - y));
  const [msg] = await sql`select sender_id, body, service_type from messages where chat_id = ${id}`;
  expect(msg).toMatchObject({ body: 'Дача 2026', service_type: 'group_created' });
  expect(Number(msg.sender_id)).toBe(a.userId);
  // newMessage в журнале у каждого участника
  for (const u of [a, b, c]) {
    const [j] = await sql`select count(*)::int n from updates where user_id = ${u.userId} and payload->>'type' = 'newMessage' and (payload->'message'->>'chatId')::bigint = ${id}`;
    expect(j.n).toBe(1);
  }
});

test('group: validation — empty title, no members, unknown user, blocked either way, no session', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  expect((await post('/chats', a.token, { title: '   ', memberIds: [b.userId] })).status).toBe(400);
  expect((await post('/chats', a.token, { title: 'X', memberIds: [a.userId] })).status).toBe(400);
  expect((await post('/chats', a.token, { title: 'X'.repeat(129), memberIds: [b.userId] })).status).toBe(400);
  expect((await post('/chats', a.token, { title: 'X', memberIds: [999999] })).status).toBe(404);
  await sql`insert into blocks (owner_id, user_id) values (${c.userId}, ${a.userId})`;   // Вера заблокировала Анну
  expect((await post('/chats', a.token, { title: 'X', memberIds: [b.userId, c.userId] })).status).toBe(403);
  expect((await fetch(base + '/chats', { method: 'POST', body: JSON.stringify({ title: 'X', memberIds: [b.userId] }) })).status).toBe(401);
  expect((await sql`select count(*)::int n from chats where kind = 'group'`)[0].n).toBe(0);
});

test('direct: opening twice returns the same chat; self and unknown are rejected', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const [r1, r2] = await Promise.all([post('/chats/direct', a.token, { userId: b.userId }), post('/chats/direct', a.token, { userId: b.userId })]);
  const id1 = ((await r1.json()) as { id: number }).id, id2 = ((await r2.json()) as { id: number }).id;
  expect(id1).toBe(id2);
  const back = ((await (await post('/chats/direct', b.token, { userId: a.userId })).json()) as { id: number }).id;
  expect(back).toBe(id1);
  expect((await post('/chats/direct', a.token, { userId: a.userId })).status).toBe(400);
  expect((await post('/chats/direct', a.token, { userId: 999999 })).status).toBe(404);
});
