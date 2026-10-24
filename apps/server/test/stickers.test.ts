import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { sendMessage } from '../src/domain/messages';
import { clearRecent, greetingSticker, myStickers, searchSets, setFaved, setInstalled, stickersByEmoji, getStickerSet } from '../src/domain/stickers';
import { importStickers, webpSize } from '../src/stickers/import';
import { makeChat, makeUser, resetDb } from './helpers';

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
  // два пака для импорта: утка (анимированные) и кот (webp 100×80, VP8X)
  const vp8x = new Uint8Array(30); vp8x.set(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8X'), 0);
  vp8x[24] = 99; vp8x[27] = 79;
  mkdirSync(`${dir}/stickers/cat`, { recursive: true });
  for (let i = 3; i <= 25; i++) writeFileSync(`${dir}/stickers/duck/${i}.tgs`, new Uint8Array([...tgs, i]));
  writeFileSync(`${dir}/stickers/duck/cover.tgs`, tgs);
  writeFileSync(`${dir}/stickers/duck/meta.json`, JSON.stringify({ title: 'Duck', kind: 'sticker', cover: 'cover.tgs', stickers: [
    { file: '1.tgs', emoji: '😂', path: 'zMQB' }, ...Array.from({ length: 23 }, (_, k) => ({ file: `${k + 3}.tgs`, emoji: k % 2 ? '👍' : '❤️' })) ] }));
  writeFileSync(`${dir}/stickers/cat/1.webp`, vp8x);
  writeFileSync(`${dir}/stickers/cat/meta.json`, JSON.stringify({ title: 'Chilled Cat', kind: 'sticker', stickers: [{ file: '1.webp', emoji: '😺' }] }));
  writeFileSync(`${dir}/stickers/_index.json`, JSON.stringify({ order: ['duck', 'cat', 'missing'] }));
  process.env.ASSETS_DIR = dir;
});
beforeEach(async () => {
  await resetDb();
  await sql`truncate sticker_sets restart identity cascade`;
  await importStickers();
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

test('import: packs in index order, sizes from webp headers, idempotent by content', async () => {
  const [duck, cat] = await sql`select short_name, title, count, position, cover_file from sticker_sets order by position`;
  expect(duck).toMatchObject({ short_name: 'duck', title: 'Duck', count: 24, position: 0, cover_file: 'cover.tgs' });
  expect(cat).toMatchObject({ short_name: 'cat', count: 1 });
  const set = (await getStickerSet('cat'))!;
  expect(set.stickers[0]).toMatchObject({ w: 100, h: 80, format: 'webp', emoji: '😺', outline: null });
  expect(set.stickers[0].url).toMatch(/^\/stk\/cat\/[0-9a-f]{8}\/1\.webp$/);
  expect(webpSize(new Uint8Array(10))).toBeNull();
  expect((await importStickers()).changed).toBe(0);                    // ничего не изменилось
  const before = (await getStickerSet('duck'))!.stickers[0].id;
  writeFileSync(`${dir}/stickers/duck/1.tgs`, new Uint8Array([...tgs, 99]));
  expect((await importStickers()).changed).toBe(1);
  const after = (await getStickerSet('duck'))!.stickers[0];
  expect(after.id).toBe(before);                                       // id стикера сохраняется (недавние живут)
  expect((await fetch(`${base}${after.url}`)).status).toBe(200);       // новый адрес отдаётся
  writeFileSync(`${dir}/stickers/duck/1.tgs`, tgs);
});

test('my stickers: defaults once, install on top, uninstall, journal on every change', async () => {
  const u = await makeUser('Анна');
  const mine = await myStickers(u);
  expect(mine.sets.map((s) => s.shortName)).toEqual(['duck', 'cat']);  // по умолчанию — первые паки
  const [cat] = await sql`select id from sticker_sets where short_name = 'cat'`;
  await setInstalled(u, Number(cat.id), false);
  expect((await myStickers(u)).sets.map((s) => s.shortName)).toEqual(['duck']);   // удалённый не возвращается сам
  await setInstalled(u, Number(cat.id), true);
  expect((await myStickers(u)).sets.map((s) => s.shortName)).toEqual(['cat', 'duck']);   // новый — наверх
  const ev = await sql`select payload from updates where user_id = ${u} and payload->>'type' = 'myStickers'`;
  expect(ev.length).toBe(2);
  await setInstalled(u, Number(cat.id), true);                         // уже стоит — ничего не пишем
  expect((await sql`select 1 from updates where user_id = ${u} and payload->>'type' = 'myStickers'`).length).toBe(2);
  await expect(setInstalled(u, 999999, true)).rejects.toMatchObject({ code: 'not_found' });
});

test('recent (20) and faved (5) are capped, newest first; search by title and emoji', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const duck = (await getStickerSet('duck'))!.stickers;
  for (const s of duck.slice(0, 22)) await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: '', sticker: { id: s.id } });
  const mine = await myStickers(a);
  expect(mine.recent).toHaveLength(20);
  expect(mine.recent[0].id).toBe(duck[21].id);
  for (const s of duck.slice(0, 6)) await setFaved(a, s.id, true);
  const faved = (await myStickers(a)).faved;
  expect(faved.map((s) => s.id)).toEqual(duck.slice(1, 6).map((s) => s.id).reverse());
  await setFaved(a, duck[5].id, false);
  expect((await myStickers(a)).faved).toHaveLength(4);
  await clearRecent(a, duck[21].id);
  expect((await myStickers(a)).recent[0].id).toBe(duck[20].id);
  await clearRecent(a);
  expect((await myStickers(a)).recent).toHaveLength(0);
  expect((await searchSets('chill')).map((s) => s.shortName)).toEqual(['cat']);
  const hearts = await stickersByEmoji(b, '❤');                         // без вариационного селектора тоже
  expect(hearts.length).toBeGreaterThan(5);
  expect(hearts.every((s) => s.emoji.startsWith('❤'))).toBe(true);
});

test('sticker message: snapshot, reply to anything, forward, rights', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const s = (await getStickerSet('duck'))!.stickers[0];
  const { message: text } = await sendMessage(b, { chatId: chat, clientId: crypto.randomUUID(), body: 'привет' });
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'игнор', replyToId: text.id, sticker: { id: s.id } });
  expect(message).toMatchObject({ kind: 'sticker', body: '', replyToId: text.id, sticker: { id: s.id, emoji: '😂', url: s.url, outline: 'zMQB' } });
  const { message: reply } = await sendMessage(b, { chatId: chat, clientId: crypto.randomUUID(), body: '', replyToId: message.id, sticker: { id: s.id } });
  expect(reply.kind).toBe('sticker');
  await expect(sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: '', sticker: { id: 999999 } })).rejects.toMatchObject({ code: 'not_found' });
  const other = await makeChat([a, b]);
  const { message: fwd } = await sendMessage(b, { chatId: other, clientId: crypto.randomUUID(), body: '', forward: { chatId: chat, id: message.id } });
  expect(fwd).toMatchObject({ kind: 'sticker', sticker: { id: s.id } });
  // группа без права на стикеры
  const c = await makeUser('Вера');
  const group = await makeChat([a, b, c]);
  await sql`update chats set rights = ${sql.json({ stickers: false } as never)} where id = ${group}`;
  await expect(sendMessage(c, { chatId: group, clientId: crypto.randomUUID(), body: '', sticker: { id: s.id } })).rejects.toMatchObject({ code: 'forbidden' });
});

test('HTTP: sets, featured, search, mine, install, faved, recent; session required', async () => {
  const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { token: string };
  const { token } = await login('Анна');
  const as = (init: RequestInit = {}) => ({ ...init, headers: { cookie: `relay_session=${token}`, ...(init.headers ?? {}) } });
  expect((await fetch(`${base}/my-stickers`)).status).toBe(401);
  const set = await fetch(`${base}/sticker-sets/duck`, as());
  expect(set.status).toBe(200);
  const etag = set.headers.get('etag')!;
  expect((await fetch(`${base}/sticker-sets/duck`, as({ headers: { 'if-none-match': etag } }))).status).toBe(304);
  expect((await fetch(`${base}/sticker-sets/nope`, as())).status).toBe(404);
  const featured = await (await fetch(`${base}/sticker-sets/featured`, as())).json() as { shortName: string }[];
  expect(featured.map((x) => x.shortName)).toEqual(['duck', 'cat']);
  const catId = ((await (await fetch(`${base}/sticker-sets/search?q=cat`, as())).json()) as { id: number }[])[0].id;
  expect((await fetch(`${base}/my-stickers/sets`, as({ method: 'POST', body: JSON.stringify({ setId: catId, on: false }) }))).status).toBe(200);
  expect((await fetch(`${base}/my-stickers/sets`, as({ method: 'POST', body: JSON.stringify({ setId: 'x', on: 1 }) }))).status).toBe(400);
  const mine = await (await fetch(`${base}/my-stickers`, as())).json() as { sets: { shortName: string }[] };
  expect(mine.sets.map((x) => x.shortName)).toEqual(['duck']);
  const byEmoji = await (await fetch(`${base}/stickers-by-emoji?e=${encodeURIComponent('👍')}`, as())).json() as unknown[];
  expect(byEmoji.length).toBeGreaterThan(0);
  expect((await fetch(`${base}/my-stickers/recent`, as({ method: 'DELETE' }))).status).toBe(200);
});

test('greeting sticker: random among greeting emoji, any sticker without them, 404 without packs', async () => {
  const picks = await Promise.all(Array.from({ length: 30 }, () => greetingSticker()));
  expect(picks.every((s) => s?.emoji === '👍')).toBe(true);           // в фикстуре из приветственных — только 👍
  expect(new Set(picks.map((s) => s!.id)).size).toBeGreaterThan(1);    // случайный, а не всегда первый
  await sql`update stickers set emoji = '🦆' where emoji = '👍'`;
  expect(['😂', '❤️', '🦆', '😺']).toContain((await greetingSticker())!.emoji);   // приветственных нет — любой

  const { token } = (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name: 'Анна' }) })).json()) as { token: string };
  const as = { headers: { cookie: `relay_session=${token}` } };
  expect((await fetch(`${base}/stickers/greeting`)).status).toBe(401);
  const res = await fetch(`${base}/stickers/greeting`, as);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect((await res.json()) as object).toMatchObject({ url: expect.stringMatching(/^\/stk\//), format: expect.any(String) });
  await sql`truncate sticker_sets restart identity cascade`;
  expect(await greetingSticker()).toBeNull();
  expect((await fetch(`${base}/stickers/greeting`, as)).status).toBe(404);
});
