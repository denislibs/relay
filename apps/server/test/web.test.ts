import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

test('GET /me needs a session and returns the user', async () => {
  expect((await fetch(`${base}/me`)).status).toBe(401);
  const login = await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name: 'Анна' }) })).json() as { userId: number; token: string };
  const me = await fetch(`${base}/me`, { headers: { cookie: `relay_session=${login.token}` } });
  expect(await me.json()).toMatchObject({ userId: login.userId, name: 'Анна' });
});

test('the server is API only: pages and client files are nginx\'s, here they are 404, API routes still answer', async () => {
  for (const p of ['/', '/main.js', '/index.html', '/+invite', '/@name', '/patterns/cuteMix.svg', '/../package.json']) {
    const res = await fetch(base + p);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<!doctype');
  }
  expect((await fetch(`${base}/chats`)).status).toBe(401);
  expect((await fetch(`${base}/health`)).status).toBe(200);
});
