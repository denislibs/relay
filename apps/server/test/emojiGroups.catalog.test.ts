import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { emojiGroupsCatalog, emojiGroupsRoute } from '../src/stickers/groups';
import { serveEmojiFile } from '../src/stickers/files';

// Без базы: каталог читает только ASSETS_DIR/emoji/emoji.json и иконки из emoji/documents.
let dir = '';
const tgs = new Uint8Array([0x1f, 0x8b, 7, 7]);
const BIG = '5355088357070218139';   // больше 2^53
const hash8 = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex').slice(0, 8);
function write(groups: object, mtime: number) {
  const f = `${dir}/emoji/emoji.json`;
  // id как в выгрузке: 64-битные числа без кавычек (JSON.stringify их бы округлил — подставляем текстом)
  const json = JSON.stringify({ groups, documents: { [BIG]: { id: 0, file: `${BIG}.tgs` }, 2: { id: 2, file: '2.tgs' }, 9: { id: 9, file: '../x.tgs' } } })
    .replace(/"icon_emoji_id":"(\d+)"/g, '"icon_emoji_id":$1');
  writeFileSync(f, json);
  utimesSync(f, new Date(mtime), new Date(mtime));
}
const prev = process.env.ASSETS_DIR;
beforeAll(() => {
  dir = mkdtempSync(`${tmpdir()}/relay-eg-`);
  process.env.ASSETS_DIR = dir;
  mkdirSync(`${dir}/emoji/documents`, { recursive: true });
  writeFileSync(`${dir}/emoji/documents/${BIG}.tgs`, tgs);
  writeFileSync(`${dir}/emoji/documents/2.tgs`, tgs);
  write({
    emoji: [
      { _: 'EmojiGroup', title: 'Love', icon_emoji_id: BIG, emoticons: ['❤', '😍'] },
      { _: 'EmojiGroup', title: 'Mystery', icon_emoji_id: 2, emoticons: ['🫥'] },     // перевода нет — как есть
      { _: 'EmojiGroup', title: 'Broken', icon_emoji_id: 9, emoticons: ['💔'] },       // плохое имя файла — нет
      { _: 'EmojiGroup', title: 'Lost', icon_emoji_id: 3, emoticons: ['🙈'] },         // иконки нет — нет
    ],
    sticker: [
      { _: 'EmojiGroupGreeting', title: 'Hi', icon_emoji_id: 2, emoticons: ['👋', '👀'] },
      { _: 'EmojiGroupPremium', title: 'Premium', icon_emoji_id: BIG },                  // пустая — нет
    ],
  }, 1_700_000_000_000);
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); if (prev === undefined) delete process.env.ASSETS_DIR; else process.env.ASSETS_DIR = prev; });

test('группы: перевод названий, иконка с хэшем, без иконки и без эмодзи — пропуск', async () => {
  const cat = await emojiGroupsCatalog();
  expect(cat.emoji).toEqual([
    { title: 'Любовь', icon: `/emj/documents/${hash8(tgs)}/${BIG}.tgs`, emoticons: ['❤', '😍'] },
    { title: 'Mystery', icon: `/emj/documents/${hash8(tgs)}/2.tgs`, emoticons: ['🫥'] },
  ]);
  expect(cat.sticker.map((g) => g.title)).toEqual(['Привет']);
  expect(cat.hash).toMatch(/^[0-9a-f]{16}$/);
  expect(await emojiGroupsCatalog()).toBe(cat);
});

test('иконка раздаётся по адресу из каталога, чужой хэш — 404', async () => {
  const cat = await emojiGroupsCatalog();
  const ok = await serveEmojiFile(cat.emoji[0].icon, 'GET');
  expect(ok.status).toBe(200);
  expect(ok.headers.get('content-type')).toBe('application/x-tgsticker');
  expect((await serveEmojiFile('/emj/documents/00000000/1.tgs', 'GET')).status).toBe(404);
  expect((await serveEmojiFile('/emj/..%2Fsecret/00000000/1.tgs', 'GET')).status).toBe(400);
});

test('маршрут: etag и 304; пересборка по mtime; без ассетов — пусто', async () => {
  const req = new Request('http://x/emoji-groups');
  const r = (await emojiGroupsRoute(req, new URL(req.url)))!;
  expect(r.status).toBe(200);
  const etag = r.headers.get('etag')!;
  expect((await emojiGroupsRoute(new Request(req.url, { headers: { 'if-none-match': etag } }), new URL(req.url)))!.status).toBe(304);
  expect(await emojiGroupsRoute(new Request('http://x/reactions'), new URL('http://x/reactions'))).toBeNull();
  const before = await emojiGroupsCatalog();
  write({ emoji: [{ title: 'Anger', icon_emoji_id: BIG, emoticons: ['😠'] }] }, 1_700_000_001_000);
  const after = await emojiGroupsCatalog();
  expect(after.emoji.map((g) => g.title)).toEqual(['Злость']);
  expect(after.hash).not.toBe(before.hash);
  process.env.ASSETS_DIR = `${dir}/none`;
  expect(await emojiGroupsCatalog()).toEqual({ hash: '0', emoji: [], sticker: [] });
  process.env.ASSETS_DIR = dir;
});
