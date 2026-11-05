import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { MyStickers, StickerRef, StickerSet } from '@relay/protocol';
import { sql } from '../../../apps/server/src/db';
import { importStickers } from '../../../apps/server/src/stickers/import';
import { Engine } from '../src/engine';
import { openDb } from '../src/idb';
import { Stickers, type StickersHost } from '../src/stickers';
import { resetDb, startTestServer, watchInto } from './helpers';

// маленький пак-фикстура: настоящих ассетов в тестах нет
const dir = '/tmp/relay-engine-stickers';
beforeAll(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/stickers/duck`, { recursive: true });
  for (let i = 1; i <= 3; i++) writeFileSync(`${dir}/stickers/duck/${i}.tgs`, new Uint8Array([31, 139, 8, 0, i]));
  writeFileSync(`${dir}/stickers/duck/meta.json`, JSON.stringify({ title: 'Duck', kind: 'sticker', stickers: [1, 2, 3].map((i) => ({ file: `${i}.tgs`, emoji: ['😂', '👍', '❤️'][i - 1], path: 'zMQB' })) }));
  writeFileSync(`${dir}/stickers/_index.json`, JSON.stringify({ order: ['duck'] }));
  process.env.ASSETS_DIR = dir;
});
const srv = await startTestServer();
afterAll(() => { srv.stop(); rmSync(dir, { recursive: true, force: true }); });
const engines: Engine[] = [];
beforeEach(async () => { await resetDb(); await sql`truncate sticker_sets restart identity cascade`; await importStickers(); });
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };

test('a sticker sent offline shows at once with its snapshot and goes out as {sticker:{id}}', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  ea.connect(); await ea.whenIdle();
  const set = await ea.call({ type: 'stickerSet', id: 'duck' }) as StickerSet;
  expect(set.stickers).toHaveLength(3);
  ea.disconnect();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await ea.call({ type: 'sendSticker', chatId, sticker: set.stickers[1] });
  const [pending] = await feed.until((l) => l.length === 1);
  expect(pending).toMatchObject({ kind: 'sticker', status: 'pending', body: '', sticker: { id: set.stickers[1].id, emoji: '👍' } });
  // недавние — сразу, ещё без сети
  expect(((await ea.call({ type: 'myStickers' })) as MyStickers & { offline?: boolean }).recent.map((s) => s.id)).toEqual([set.stickers[1].id]);
  ea.connect(); await ea.whenIdle();
  const [sent] = await feed.until((l) => l[0]?.status === 'sent');
  expect(sent.kind).toBe('sticker');
  const [row] = await sql`select kind, sticker from messages where chat_id = ${chatId}`;
  expect(row.kind).toBe('sticker');
  expect(row.sticker.id).toBe(set.stickers[1].id);
});

test('a read racing the first cache load does not undo a sticker just sent', async () => {
  const ref = (id: number) => ({ id, emoji: '👍' }) as StickerRef;
  const db = await openDb('stickers-' + crypto.randomUUID());
  const offline = () => new Stickers({ db, online: () => false, http: async () => { throw new Error('offline'); }, enqueue: async () => {}, bump: () => {}, unsentStickers: () => [] });
  const recent = async (s: Stickers) => ((await s.act({ type: 'myStickers' })) as MyStickers).recent.map((x) => x.id);

  // кэша ещё нет: чтение стартует, пока поднятие недавних ждёт свою загрузку
  const first = offline();
  const bump = first.bumpRecent(ref(1));
  expect(await recent(first)).toEqual([1]);
  await bump;
  expect(await recent(first)).toEqual([1]);

  // кэш есть: опоздавшая загрузка не возвращает старый список поверх нового — и следующий стикер его не теряет
  const second = offline();
  const bump2 = second.bumpRecent(ref(2));
  expect(await recent(second)).toEqual([2, 1]);
  await bump2;
  await second.bumpRecent(ref(3));
  expect(await recent(second)).toEqual([3, 2, 1]);
});

test('a sticker just sent stays in recents while the server answer does not know it yet', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  const recent = async () => ((await ea.call({ type: 'myStickers' })) as MyStickers).recent.map((s) => s.id);
  ea.connect(); await ea.whenIdle();
  const { stickers: [one, two] } = await ea.call({ type: 'stickerSet', id: 'duck' }) as StickerSet;

  // онлайн: читаем сразу после отправки, сообщение ещё в очереди
  await ea.call({ type: 'sendSticker', chatId, sticker: one });
  expect(await recent()).toEqual([one.id]);
  await ea.whenIdle();
  expect(await recent()).toEqual([one.id]);

  // из офлайна: сеть уже есть, а очередь ждёт догонку журнала — первый запрос сервера о стикере не знает
  ea.disconnect();
  await ea.call({ type: 'sendSticker', chatId, sticker: two });
  ea.connect();
  expect(await recent()).toEqual([two.id, one.id]);
  await ea.whenIdle();
  expect(await recent()).toEqual([two.id, one.id]);
});

test('a sticker the server refused does not stay in recents', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  ea.connect(); await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await ea.call({ type: 'sendSticker', chatId, sticker: { id: 999_999, emoji: '👍' } as StickerRef });
  await feed.until((l) => l[0]?.status === 'failed');
  expect(((await ea.call({ type: 'myStickers' })) as MyStickers).recent).toEqual([]);
});

test('the answer of /my-stickers is merged with what is still unsent', async () => {
  const ref = (id: number) => ({ id, emoji: '👍' }) as StickerRef;
  const db = await openDb('stickers-' + crypto.randomUUID());
  let unsent: { sticker: StickerRef; at: number }[] = [];
  let server: StickerRef[] = [];
  let during = () => {};
  const s = new Stickers({
    db, online: () => true, enqueue: async () => {}, bump: () => {}, unsentStickers: () => unsent,
    http: (async () => { during(); return { sets: [], recent: server, faved: [] }; }) as StickersHost['http'],
  });
  const recent = async () => ((await s.act({ type: 'myStickers' })) as MyStickers).recent.map((x) => x.id);

  // в очереди давно (долгий офлайн) — на верху списка и со сроком не пропадает; порядок — от нового к старому
  server = [ref(5), ref(1)];
  unsent = [{ sticker: ref(1), at: Date.now() - 3_600_000 }, { sticker: ref(2), at: Date.now() - 1_800_000 }];
  expect(await recent()).toEqual([2, 1, 5]);

  // ушёл, пока шёл запрос: в очереди его больше нет, а ответ мог быть собран раньше
  server = [ref(5)];
  unsent = [{ sticker: ref(3), at: Date.now() }];
  during = () => { unsent = []; };
  expect(await recent()).toEqual([3, 5]);

  // отправили, пока шёл запрос: ответ старше отправки
  during = () => { unsent = [{ sticker: ref(4), at: Date.now() }]; };
  expect(await recent()).toEqual([4, 5]);
  during = () => {};

  // убрали из недавних уже после отправки: не возвращается; отправленный после очистки — на месте
  await Bun.sleep(2);
  await s.act({ type: 'clearRecentStickers', id: 4 });
  expect(await recent()).toEqual([5]);
  await Bun.sleep(2);
  unsent = [{ sticker: ref(4), at: Date.now() }];
  expect(await recent()).toEqual([4, 5]);
});

test('my stickers and packs come from the cache without network; installing on one device bumps the other', async () => {
  const a = await srv.login('a');
  const e1 = await open(srv.config(a));
  const e2 = await open({ ...srv.config(a), dbName: srv.config(a).dbName + '-2' });
  e1.connect(); e2.connect();
  await e1.whenIdle(); await e2.whenIdle();
  const mine = await e1.call({ type: 'myStickers' }) as MyStickers;
  expect(mine.sets.map((s) => s.shortName)).toEqual(['duck']);
  await e1.call({ type: 'stickerSet', id: mine.sets[0].id });
  e1.disconnect();
  const off = await e1.call({ type: 'myStickers' }) as MyStickers & { offline?: boolean };
  expect(off.offline).toBe(true);
  expect(off.sets.map((s) => s.shortName)).toEqual(['duck']);
  expect(((await e1.call({ type: 'stickerSet', id: mine.sets[0].id })) as StickerSet).stickers).toHaveLength(3);
  expect(((await e1.call({ type: 'stickersByEmoji', emoji: '❤' })) as unknown[]).length).toBe(1);   // без сети — из открытых паков
  expect(((await e1.call({ type: 'stickersByEmoji', emoji: '❤️😂🦄' })) as unknown[]).length).toBe(2);   // группа (чип) — любой из эмодзи
  expect(await e1.call({ type: 'greetingSticker' })).toBeNull();      // приветствие без сети — нет (карточка без стикера)

  expect(await e2.call({ type: 'greetingSticker' })).toMatchObject({ emoji: '👍' });   // из приветственных эмодзи
  const st = watchInto(e2, { kind: 'status' });
  const before = (st.list[0]?.stickersRev as number) ?? 0;
  e1.connect(); await e1.whenIdle();
  await e1.call({ type: 'installStickerSet', setId: mine.sets[0].id, on: false });
  await st.until((l) => (l[0]?.stickersRev as number) > before);
  expect(((await e2.call({ type: 'myStickers' })) as MyStickers).sets).toHaveLength(0);
});
