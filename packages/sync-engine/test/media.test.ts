import { sql } from '../../../apps/server/src/db';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import type { Message } from '@relay/protocol';
import { Engine } from '../src/engine';
import { getAll, openDb } from '../src/idb';
import { Store } from '../src/store';
import { msg } from './fixtures';
import { resetDb, startTestServer, watchInto } from './helpers';

// «Общие медиа» из воркера: вкладки — из памяти и IndexedDB, страницы старше — с сервера (вне ленты), счётчики —
// с сервера один раз, дальше их ведёт сам воркер по сообщениям.

const ME = 1, PEER = 2, CH = 7;
const att = (kind: string, mime: string) => ({ id: crypto.randomUUID(), kind, mime, name: 'x', size: 1, w: 1, h: 1 }) as unknown as Message['attachment'];
const photo = (id: number, body = '') => msg({ id, chatId: CH, senderId: PEER, kind: 'photo', body, attachment: att('photo', 'image/png') });
const fresh = async () => Store.open(await openDb('m-' + crypto.randomUUID()), ME);
const counted = (s: Store) => { const c = s.chats.get(CH)!; c.mediaCounts = { media: 0, file: 0, audio: 0, voice: 0, link: 0 }; c.mediaCountsAt = c.knownMaxId; return c; };

test('counts: a photo with a link in its caption counts in media and link; deletion takes it out of both', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: CH, senderId: PEER }) });
  const c = counted(s);
  s.applyUpdate({ type: 'newMessage', message: photo(2, 'см. https://a.b') });
  expect(c.mediaCounts).toEqual({ media: 1, file: 0, audio: 0, voice: 0, link: 1 });
  s.applyUpdate({ type: 'messageDeleted', chatId: CH, id: 2 });
  expect(c.mediaCounts).toEqual({ media: 0, file: 0, audio: 0, voice: 0, link: 0 });
});

test('counts: an edit adding a link increments link, removing it decrements; old messages are not counted twice', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 5, chatId: CH, senderId: PEER, body: 'привет' }) });
  const c = counted(s);
  s.applyUpdate({ type: 'messageEdited', chatId: CH, id: 5, body: 'вот https://x.y', editedAt: new Date().toISOString() });
  expect(c.mediaCounts!.link).toBe(1);
  s.applyUpdate({ type: 'messageEdited', chatId: CH, id: 5, body: 'без ссылки', editedAt: new Date().toISOString() });
  expect(c.mediaCounts!.link).toBe(0);
  // страница старше снимка счётчиков и повторный приход уже учтённого — не считаются
  s.addLoose(CH, [photo(3), photo(4)]);
  s.applyUpdate({ type: 'newMessage', message: photo(6) });
  s.applyUpdate({ type: 'newMessage', message: photo(6) });
  expect(c.mediaCounts!.media).toBe(1);
});

test('counts: unknown deleted message invalidates the counts (they are fetched again)', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 9, chatId: CH, senderId: PEER }) });
  const c = counted(s);
  s.applyUpdate({ type: 'messageDeleted', chatId: CH, id: 3 });
  expect(c.mediaCounts).toBeUndefined();
});

// ---------- движок и сервер ----------

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const closeOne = async (e: Engine) => { await e.close(); engines.splice(engines.indexOf(e), 1); };

/** Считает запросы движка к /chats/:id/media и /media/counts. */
function countMediaRequests() {
  const orig = globalThis.fetch;
  const box = { pages: 0, counts: 0, restore: () => { globalThis.fetch = orig; } };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    if (/\/chats\/\d+\/media\/counts$/.test(u)) box.counts++;
    else if (/\/chats\/\d+\/media\?/.test(u)) box.pages++;
    return orig(input, init);
  }) as typeof fetch;
  return box;
}

const insertPhoto = async (chatId: number, sender: number, body = '') =>
  Number((await sql`insert into messages (chat_id, sender_id, client_id, kind, body, attachment) values (${chatId}, ${sender}, ${crypto.randomUUID()}, 'photo', ${body}, ${sql.json({ id: crypto.randomUUID(), kind: 'photo', name: 'p.png', mime: 'image/png', size: 1, w: 1, h: 1 } as never)}) returning id`)[0].id);
const insertText = async (chatId: number, sender: number, body: string) =>
  Number((await sql`insert into messages (chat_id, sender_id, client_id, kind, body) values (${chatId}, ${sender}, ${crypto.randomUUID()}, 'text', ${body}) returning id`)[0].id);
const meta = (w: ReturnType<typeof watchInto>) => {
  const p = w.patches; let m: Record<string, unknown> | undefined;
  for (const x of p) for (const it of x.op === 'snapshot' ? x.items : x.upsert) if (it.key === '~media') m = it;
  return m as { done: boolean; loading: boolean; counts: Record<string, number> | null } | undefined;
};

test('media: old photos come from the server page, a new one is first in the tab and counted without a request; delete — minus', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const p1 = await insertPhoto(chatId, b.userId), p2 = await insertPhoto(chatId, b.userId, 'тут https://relay.app');
  for (let i = 0; i < 3; i++) await insertText(chatId, b.userId, 'текст ' + i);
  const reqs = countMediaRequests();
  try {
    const ea = await open(srv.config(a));
    ea.connect();
    await ea.whenIdle();
    const w = watchInto(ea, { kind: 'media', chatId, tab: 'media', limit: 40 });
    const l = await w.until((x) => x.length === 2);
    expect(l.map((m) => m.id)).toEqual([p2, p1]);   // новые сверху
    await ea.whenIdle();
    expect(meta(w)).toMatchObject({ done: true, loading: false, counts: { media: 2, link: 1, file: 0 } });
    expect(reqs).toMatchObject({ pages: 1, counts: 1 });
    // старые медиа — не в ленте (за дырой)
    const feed = watchInto(ea, { kind: 'messages', chatId, limit: 2 });
    expect((await feed.until((x) => x.length === 2)).map((m) => m.kind)).toEqual(['text', 'text']);

    // новое фото от собеседника — первым во вкладке и +1 к счётчику, без запросов
    const eb = await open(srv.config(b));
    eb.connect();
    await eb.whenIdle();
    await eb.call({ type: 'sendFile', chatId, body: '', file: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), name: 'n.png', mime: 'image/png', w: 1, h: 1, thumb: null });
    const l2 = await w.until((x) => x.length === 3, 5000);
    expect(l2[0].senderId).toBe(b.userId);
    expect(l2.slice(1).map((m) => m.id)).toEqual([p2, p1]);
    await ea.whenIdle();
    expect(meta(w)!.counts!.media).toBe(3);

    // ссылка в правке — +1 к ссылкам
    const t = (await sql`select id from messages where chat_id = ${chatId} and kind = 'text' order by id desc limit 1`)[0].id as number;
    await eb.call({ type: 'editMessage', chatId, id: Number(t), body: 'смотри www.example.com' });
    await w.until(() => meta(w)?.counts?.link === 2);

    // удалили — минус и пропало из вкладки
    const newest = l2[0].id as number;
    await eb.call({ type: 'deleteMessage', chatId, id: newest });
    await w.until((x) => x.length === 2 && meta(w)?.counts?.media === 2);

    // вторая подписка (вкладку открыли снова) — без запросов
    const w2 = watchInto(ea, { kind: 'media', chatId, tab: 'media', limit: 40 });
    await w2.until((x) => x.length === 2);
    await ea.whenIdle();
    expect(reqs).toMatchObject({ pages: 1, counts: 1 });
  } finally { reqs.restore(); }
});

test('media: offline after a restart the tab shows what was saved, with counts, without requests', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) ids.push(await insertPhoto(chatId, b.userId));
  for (let i = 0; i < 3; i++) await insertText(chatId, b.userId, 'текст ' + i);
  const cfg = srv.config(a);
  const ea = await open(cfg);
  ea.connect();
  await ea.whenIdle();
  const w = watchInto(ea, { kind: 'media', chatId, tab: 'media', limit: 40 });
  await w.until((x) => x.length === 3);
  await ea.whenIdle();
  await closeOne(ea);

  // в строках сообщений — основная вкладка (индекс byTab)
  const db = await openDb(cfg.dbName);
  const rows = await getAll<Record<string, unknown>>(db, 'messages');
  db.close();
  expect(rows.filter((r) => r.tab === 'media').map((r) => r.id).sort()).toEqual([...ids].sort());
  expect(rows.filter((r) => r.kind === 'text').every((r) => !('tab' in r))).toBe(true);

  const reqs = countMediaRequests();
  try {
    const cold = await open(cfg);   // без connect — сети нет
    const w2 = watchInto(cold, { kind: 'media', chatId, tab: 'media', limit: 40 });
    const l = await w2.until((x) => x.length === 3, 1000);
    expect(l.map((m) => m.id)).toEqual([...ids].reverse());
    expect(w2.patches[0].op).toBe('snapshot');
    expect(meta(w2)).toMatchObject({ done: true, counts: { media: 3 } });
    expect(reqs).toMatchObject({ pages: 0, counts: 0 });
  } finally { reqs.restore(); }
});

test('media: a tab longer than the limit loads the next page only when asked for more', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ids: number[] = [];
  for (let i = 0; i < 45; i++) ids.push(await insertPhoto(chatId, b.userId));
  await insertText(chatId, b.userId, 'конец');
  const reqs = countMediaRequests();
  try {
    const ea = await open(srv.config(a));
    ea.connect();
    await ea.whenIdle();
    const w = watchInto(ea, { kind: 'media', chatId, tab: 'media', limit: 20 });
    await w.until((x) => x.length === 20);
    await ea.whenIdle();
    expect(reqs.pages).toBe(1);   // страница 40 — хватило
    expect(meta(w)).toMatchObject({ done: false, loading: false });
    w.handle.update({ kind: 'media', chatId, tab: 'media', limit: 60 });
    const l = await w.until((x) => x.length === 45);
    expect(l.map((m) => m.id)).toEqual([...ids].reverse());
    await ea.whenIdle();
    expect(reqs.pages).toBe(2);
    expect(meta(w)).toMatchObject({ done: true, counts: { media: 45 } });
  } finally { reqs.restore(); }
});
