import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/http';
import { resetDb } from './helpers';

const dist = mkdtempSync(join(tmpdir(), 'relay-dist-'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Relay</title>');
writeFileSync(join(dist, 'main.js'), 'console.log(1)');
process.env.WEB_DIST = dist;

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

test('static files and SPA fallback are served without a session', async () => {
  const root = await fetch(`${base}/`);
  expect(root.headers.get('content-type')).toContain('text/html');
  expect(await root.text()).toContain('<title>Relay</title>');
  expect(await (await fetch(`${base}/chat/5`)).text()).toContain('<title>Relay</title>');
  const js = await fetch(`${base}/main.js`);
  expect(js.headers.get('content-type')).toContain('javascript');
  expect(await js.text()).toBe('console.log(1)');
});

test('static serving never leaves the dist folder and never shadows the API', async () => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json']) {
    const res = await fetch(base + p);
    const body = await res.text();
    expect(body).not.toContain('"workspaces"');
  }
  expect((await fetch(`${base}/missing.js`)).status).toBe(404);
  expect((await fetch(`${base}/chats`)).status).toBe(401);
});
