import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/http';
import { resetDb } from './helpers';

const dist = mkdtempSync(join(tmpdir(), 'relay-dist-'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Relay</title>');
writeFileSync(join(dist, 'main.js'), 'console.log(1)');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>';
mkdirSync(join(dist, 'patterns'));
writeFileSync(join(dist, 'patterns', 'cuteMix.svg'), SVG);
writeFileSync(join(dist, 'patterns', 'cuteMix.svg.gz'), Bun.gzipSync(SVG));
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

test('a pattern is sent precompressed to browsers that accept gzip, plain to the rest', async () => {
  const zipped = await fetch(`${base}/patterns/cuteMix.svg`, { headers: { 'accept-encoding': 'gzip, br' }, decompress: false } as RequestInit);
  expect(zipped.headers.get('content-encoding')).toBe('gzip');
  expect(zipped.headers.get('content-type')).toContain('image/svg+xml');
  expect(zipped.headers.get('cache-control')).toContain('max-age');
  expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await zipped.arrayBuffer())))).toBe(SVG);
  const plain = await fetch(`${base}/patterns/cuteMix.svg`, { headers: { 'accept-encoding': 'identity' } });
  expect(plain.headers.get('content-encoding')).toBeNull();
  expect(await plain.text()).toBe(SVG);
  expect((await fetch(`${base}/main.js`, { headers: { 'accept-encoding': 'gzip' } })).headers.get('cache-control')).toBe('no-cache');
});

test('static files carry an ETag: an unchanged file revalidates as 304 without a body, a changed one is sent again', async () => {
  const first = await fetch(`${base}/main.js`);
  const etag = first.headers.get('etag')!;
  expect(etag).toMatch(/^W\/"/);
  expect(await first.text()).toBe('console.log(1)');
  const again = await fetch(`${base}/main.js`, { headers: { 'if-none-match': etag } });
  expect(again.status).toBe(304);
  expect(again.headers.get('etag')).toBe(etag);
  expect(await again.text()).toBe('');
  // SPA-фолбэк — тот же механизм
  const spa = await fetch(`${base}/some/route`);
  expect((await fetch(`${base}/some/route`, { headers: { 'if-none-match': spa.headers.get('etag')! } })).status).toBe(304);
  // сжатая копия — свой тег
  const gz = await fetch(`${base}/patterns/cuteMix.svg`, { headers: { 'accept-encoding': 'gzip' }, decompress: false } as RequestInit);
  const raw = await fetch(`${base}/patterns/cuteMix.svg`, { headers: { 'accept-encoding': 'identity' } });
  expect(gz.headers.get('etag')).not.toBe(raw.headers.get('etag'));
  writeFileSync(join(dist, 'main.js'), 'console.log(22)');
  const changed = await fetch(`${base}/main.js`, { headers: { 'if-none-match': etag } });
  expect(changed.status).toBe(200);
  expect(await changed.text()).toBe('console.log(22)');
  writeFileSync(join(dist, 'main.js'), 'console.log(1)');
});
