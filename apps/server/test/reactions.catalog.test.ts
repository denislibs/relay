import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { reactionCatalog } from '../src/reactions/catalog';
import { reactionsRoute } from '../src/reactions/routes';
import { serveReactionFile } from '../src/stickers/files';

// Без базы: каталог и раздача файлов читают только ASSETS_DIR. Запускать из корня, чтобы не подхватить
// preload setup.ts (миграции): `bun test apps/server/test/reactions.catalog.test.ts`.
const dir = `/tmp/relay-test-reactions-${process.pid}`;
const tgs = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]);
const webp = new TextEncoder().encode('RIFF....WEBPVP8 ');
const hash8 = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex').slice(0, 8);
const files = (extra: Record<string, string> = {}) => ({ static: 'static.webp', appear: 'appear.tgs', select: 'select.tgs', activate: 'activate.tgs', effect: 'effect.tgs', ...extra });
const full = files({ around: 'around.tgs', center: 'center.tgs' });

function writeJson(entries: unknown[], mtime?: number) {
  const p = `${dir}/reactions/reactions.json`;
  writeFileSync(p, JSON.stringify(entries));
  if (mtime) utimesSync(p, mtime / 1000, mtime / 1000);
}
function pack(slug: string, names: string[]) {
  mkdirSync(`${dir}/reactions/${slug}`, { recursive: true });
  for (const n of names) writeFileSync(`${dir}/reactions/${slug}/${n}`, n.endsWith('.webp') ? webp : new Uint8Array([...tgs, n.length]));
}

beforeAll(() => {
  rmSync(dir, { recursive: true, force: true });
  pack('2764', Object.values(full));
  pack('1f44d', Object.values(files()));             // без around/center
  pack('1f602', Object.values(full));
  writeJson([
    { reaction: '❤', title: 'Red Heart', slug: '2764', premium: false, inactive: false, files: full },
    { reaction: '👍', title: 'Thumbs Up', slug: '1f44d', premium: false, inactive: false, files: files() },
    { reaction: '😂', title: 'Face with Tears of Joy', slug: '1f602', premium: false, inactive: true, files: full },
    { reaction: '💩', title: 'Missing files', slug: 'nope', premium: false, inactive: false, files: full },
  ], 1_700_000_000_000);
  writeFileSync(`${dir}/secret.txt`, 'nope');
  process.env.ASSETS_DIR = dir;
});
const prevAssets = process.env.ASSETS_DIR;
afterAll(() => { rmSync(dir, { recursive: true, force: true }); if (prevAssets === undefined) delete process.env.ASSETS_DIR; else process.env.ASSETS_DIR = prevAssets; });

test('catalog: json order, emojiKey, hashed urls, optional effects, broken entries skipped', async () => {
  const cat = await reactionCatalog();
  expect(cat.items.map((i) => i.key)).toEqual(['❤', '👍', '😂']);   // 💩 без файлов не отдаётся
  const [heart, thumb, joy] = cat.items;
  expect(heart).toMatchObject({ title: 'Red Heart', inactive: false, static: `/rx/2764/${hash8(webp)}/static.webp` });
  expect(heart.appear).toMatch(/^\/rx\/2764\/[0-9a-f]{8}\/appear\.tgs$/);
  expect(heart.center).toMatch(/^\/rx\/2764\/[0-9a-f]{8}\/center\.tgs$/);
  expect(heart.around).toMatch(/^\/rx\/2764\/[0-9a-f]{8}\/around\.tgs$/);
  expect(thumb).toMatchObject({ center: null, around: null });
  expect(joy.inactive).toBe(true);
  expect(Object.keys(heart).sort()).toEqual(['appear', 'around', 'center', 'inactive', 'key', 'select', 'static', 'title']);
  expect(cat.hash).toMatch(/^[0-9a-f]{16}$/);
  expect(await reactionCatalog()).toBe(cat);   // мемоизация: тот же объект
});

test('catalog is rebuilt when reactions.json changes, hash follows content', async () => {
  const before = await reactionCatalog();
  writeJson([{ reaction: '❤️', title: 'Red Heart', slug: '2764', files: full }], 1_700_000_001_000);   // с FE0F — ключ тот же
  const after = await reactionCatalog();
  expect(after).not.toBe(before);
  expect(after.items.map((i) => i.key)).toEqual(['❤']);
  expect(after.hash).not.toBe(before.hash);
  // файл подменили, mtime json сдвинули — адрес и хэш каталога новые
  writeFileSync(`${dir}/reactions/2764/static.webp`, new Uint8Array([...webp, 1]));
  writeJson([{ reaction: '❤️', title: 'Red Heart', slug: '2764', files: full }], 1_700_000_002_000);
  const moved = await reactionCatalog();
  expect(moved.items[0].static).not.toBe(after.items[0].static);
  expect(moved.hash).not.toBe(after.hash);
});

test('GET /reactions: etag from hash, private hour cache, 304 on match', async () => {
  const cat = await reactionCatalog();
  const url = new URL('http://x/reactions');
  const res = (await reactionsRoute(new Request(url), url))!;
  expect(res.status).toBe(200);
  expect(res.headers.get('etag')).toBe(`"${cat.hash}"`);
  expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
  expect(await res.json()).toEqual(cat);
  const again = (await reactionsRoute(new Request(url, { headers: { 'if-none-match': `"${cat.hash}"` } }), url))!;
  expect(again.status).toBe(304);
  expect(await reactionsRoute(new Request(url, { method: 'POST' }), url)).toBeNull();
  expect(await reactionsRoute(new Request('http://x/reactions/1'), new URL('http://x/reactions/1'))).toBeNull();
});

test('reaction files: immutable by content hash, 404 on a stale hash, escapes refused', async () => {
  const cat = await reactionCatalog();
  const ok = await serveReactionFile(cat.items[0].static, 'GET');
  expect(ok.status).toBe(200);
  expect(ok.headers.get('content-type')).toBe('image/webp');
  expect(ok.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect((await serveReactionFile(cat.items[0].appear, 'HEAD')).status).toBe(200);
  const stale = await serveReactionFile('/rx/2764/00000000/static.webp', 'GET');
  expect(stale.status).toBe(404);
  expect(stale.headers.get('cache-control')).toBe('no-store');
  expect((await serveReactionFile(`/rx/..%2F/${hash8(webp)}/secret.txt`, 'GET')).status).toBe(400);
  expect((await serveReactionFile('/rx/2764/00000000/static.exe', 'GET')).status).toBe(404);
  expect((await serveReactionFile(cat.items[0].static, 'POST')).status).toBe(405);
});

test('no assets folder → empty catalog with hash "0"', async () => {
  process.env.ASSETS_DIR = `${dir}/none`;
  expect(await reactionCatalog()).toEqual({ hash: '0', items: [] });
  const url = new URL('http://x/reactions');
  const res = (await reactionsRoute(new Request(url), url))!;
  expect(res.headers.get('etag')).toBe('"0"');
  expect(await res.json()).toEqual({ hash: '0', items: [] });
  process.env.ASSETS_DIR = dir;
});
