import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { animatedEmojiCatalog, animatedEmojiRoute } from '../src/reactions/emoji';

// Без базы: каталог читает только ASSETS_DIR/stickers/<pack>/meta.json и файлы. Запускать из корня.
let dir = '';
const tgs = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
function pack(name: string, stickers: { file: string; emoji: string; path?: string }[], mtime: number) {
  mkdirSync(`${dir}/stickers/${name}`, { recursive: true });
  for (const s of stickers) if (!s.file.includes('/')) writeFileSync(`${dir}/stickers/${name}/${s.file}`, tgs);   // плохой путь — не пишем, каталог должен его отбросить
  const meta = `${dir}/stickers/${name}/meta.json`;
  writeFileSync(meta, JSON.stringify({ title: name, kind: 'emoji', stickers }));
  utimesSync(meta, new Date(mtime), new Date(mtime));
}
const prevAssets = process.env.ASSETS_DIR;
beforeAll(() => {
  dir = mkdtempSync(`${tmpdir()}/relay-ae-`);
  process.env.ASSETS_DIR = dir;
  pack('animated_emoji', [{ file: '1.tgs', emoji: '❤' }, { file: '2.tgs', emoji: '😀' }, { file: '3.tgs', emoji: '❤️' }, { file: 'bad/x.tgs', emoji: '💩' }], 1_700_000_000_000);
  pack('emoji_animations', [{ file: '1.tgs', emoji: '❤️' }, { file: '2.tgs', emoji: '❤' }, { file: '3.tgs', emoji: '🎉' }], 1_700_000_000_000);
  pack('emoji_generic_animations', [{ file: '1.tgs', emoji: '💥' }, { file: '2.tgs', emoji: '💥' }], 1_700_000_000_000);
  const faces = (n: number) => Array.from({ length: n }, (_, i) => ({ file: `${i + 1}.tgs`, emoji: i ? `${i}⃣` : '#⃣', path: 'zMQB' }));
  pack('animated_dice', faces(7), 1_700_000_000_000);                   // «летит» + 6 исходов
  pack('animated_dice_26bd', faces(4), 1_700_000_000_000);              // мяч: нужно 1 + 5 — неполный набор не берём
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); if (prevAssets === undefined) delete process.env.ASSETS_DIR; else process.env.ASSETS_DIR = prevAssets; });

test('каталог: ключи без FE0F, первый вариант эмодзи, все варианты эффектов, сердца наследуют ❤, хэш', async () => {
  const cat = await animatedEmojiCatalog();
  expect(Object.keys(cat.emoji).sort()).toEqual(['❤', '😀']);               // 💩 с плохим путём пропущен, ❤️ — повтор
  expect(cat.emoji['❤']).toMatch(/^\/stk\/animated_emoji\/[0-9a-f]{8}\/1\.tgs$/);
  expect(cat.effects['❤'].length).toBe(2);
  expect(cat.effects['🧡']).toBe(cat.effects['❤']);
  expect(cat.effects['🎉'].length).toBe(1);
  expect(cat.generic.length).toBe(2);
  expect(cat.dice!['🎲'].map((f) => f.url)).toEqual(Array.from({ length: 7 }, (_, i) => expect.stringMatching(new RegExp(`^/stk/animated_dice/[0-9a-f]{8}/${i + 1}\\.tgs$`))));
  expect(cat.dice!['🎲'][0].outline).toBe('zMQB');
  expect(cat.dice!['⚽']).toBeUndefined();
  expect(cat.hash).toMatch(/^[0-9a-f]{16}$/);
  expect(await animatedEmojiCatalog()).toBe(cat);
});

test('пересборка по mtime meta.json', async () => {
  const before = await animatedEmojiCatalog();
  pack('animated_emoji', [{ file: '1.tgs', emoji: '🔥' }], 1_700_000_001_000);
  const after = await animatedEmojiCatalog();
  expect(after).not.toBe(before);
  expect(Object.keys(after.emoji)).toEqual(['🔥']);
  expect(after.hash).not.toBe(before.hash);
});

test('маршрут: etag и 304, чужие пути — null', async () => {
  const req = new Request('http://x/animated-emoji');
  const r = (await animatedEmojiRoute(req, new URL(req.url)))!;
  expect(r.status).toBe(200);
  const etag = r.headers.get('etag')!;
  expect(r.headers.get('cache-control')).toBe('private, max-age=3600');
  const r2 = (await animatedEmojiRoute(new Request('http://x/animated-emoji', { headers: { 'if-none-match': etag } }), new URL(req.url)))!;
  expect(r2.status).toBe(304);
  expect(await animatedEmojiRoute(new Request('http://x/reactions'), new URL('http://x/reactions'))).toBeNull();
});

test('без ассетов — пустой каталог', async () => {
  process.env.ASSETS_DIR = `${dir}/none`;
  expect(await animatedEmojiCatalog()).toEqual({ hash: '0', emoji: {}, effects: {}, generic: [] });
});
