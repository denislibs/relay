import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from '../src/http';

// фикстура вместо настоящих ассетов: их нет в git и в CI
const dir = '/tmp/relay-test-assets';
const tgs = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]);
const webp = new TextEncoder().encode('RIFF....WEBPVP8 ');
beforeAll(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/stickers/duck`, { recursive: true });
  writeFileSync(`${dir}/stickers/duck/1.tgs`, tgs);
  writeFileSync(`${dir}/stickers/duck/2.webp`, webp);
  writeFileSync(`${dir}/secret.txt`, 'nope');
  process.env.ASSETS_DIR = dir;
});

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }); });

const hash8 = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex').slice(0, 8);

test('sticker files are public, immutable and addressed by content hash', async () => {
  const res = await fetch(`${base}/stk/duck/${hash8(tgs)}/1.tgs`);   // без сессии: стикеры публичные
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/x-tgsticker');
  expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(tgs);

  const img = await fetch(`${base}/stk/duck/${hash8(webp)}/2.webp`);
  expect(img.status).toBe(200);
  expect(img.headers.get('content-type')).toBe('image/webp');
});

test('a stale hash, a missing file and escapes from the stickers dir are refused', async () => {
  // хэш от другого содержимого — 404 и не кэшируется навсегда
  const stale = await fetch(`${base}/stk/duck/00000000/1.tgs`);
  expect(stale.status).toBe(404);
  expect(stale.headers.get('cache-control')).not.toContain('immutable');
  expect((await fetch(`${base}/stk/duck/${hash8(tgs)}/9.tgs`)).status).toBe(404);
  expect((await fetch(`${base}/stk/..%2F/${hash8(tgs)}/secret.txt`)).status).toBe(400);
  expect((await fetch(`${base}/stk/duck/${hash8(tgs)}/..%2F..%2Fsecret.txt`)).status).toBe(400);
  expect((await fetch(`${base}/stk/duck/${hash8(tgs)}/1.exe`)).status).toBe(404);
});
