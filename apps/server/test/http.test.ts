import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

async function login(name: string) {
  const res = await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) });
  expect(res.status).toBe(200);
  expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  return (await res.json()) as { userId: number; token: string };
}
const authed = (token: string) => ({ headers: { cookie: `relay_session=${token}` } });

test('requests without a session are rejected', async () => {
  const res = await fetch(`${base}/chats`);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ code: 'unauthorized' });
});

test('login → create chat → list → history', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const created = await fetch(`${base}/dev/chats`, { method: 'POST', ...authed(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) });
  const { id } = (await created.json()) as { id: number };
  const list = await (await fetch(`${base}/chats`, authed(b.token))).json();
  expect(list).toEqual([expect.objectContaining({ id, unread: 0, last: null })]);
  const hist = await (await fetch(`${base}/chats/${id}/messages?limit=20`, authed(a.token))).json();
  expect(hist).toEqual({ messages: [], hasMore: false });
});

test('history of someone else`s chat is forbidden', async () => {
  const a = await login('a'), b = await login('b'), c = await login('c');
  const created = await fetch(`${base}/dev/chats`, { method: 'POST', ...authed(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) });
  const { id } = (await created.json()) as { id: number };
  const res = await fetch(`${base}/chats/${id}/messages`, authed(c.token));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ code: 'not_member' });
});

test('logout deletes the session and clears the cookie', async () => {
  const a = await login('Анна');
  expect((await fetch(`${base}/me`, authed(a.token))).status).toBe(200);
  const out = await fetch(`${base}/logout`, { method: 'POST', ...authed(a.token) });
  expect(out.status).toBe(200);
  expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await fetch(`${base}/me`, authed(a.token))).status).toBe(401);
});
