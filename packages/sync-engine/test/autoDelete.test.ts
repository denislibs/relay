import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sql } from '../../../apps/server/src/db';
import { expireStep, setAutoDelete } from '../../../apps/server/src/domain/autoDelete';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { Engine } from '../src/engine';
import { openDb, getAll } from '../src/idb';
import { resetDb, startTestServer, watchInto } from './helpers';

process.env.DEV_LOGIN = '1';   // сроки в секундах — только под DEV_LOGIN (сервер)
const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close().catch(() => {}); });
const open = async (cfg: Parameters<typeof Engine.open>[0], connect = true) => { const e = await Engine.open(cfg); engines.push(e); if (connect) e.connect(); return e; };
const send = (u: number, chatId: number, body: string, extra: Record<string, unknown> = {}) => sendMessage(u, { chatId, clientId: crypto.randomUUID(), body, ...extra }).then((r) => r.message);
const row = (l: Record<string, unknown>[], id: number) => l.find((c) => c.id === id) as Record<string, unknown> & { last?: { body?: string; id?: number } | null; unread?: number; autoDeleteSec?: number | null; pinned?: number[] };
const bodies = (l: Record<string, unknown>[]) => l.map((m) => m.body);
const stored = async (dbName: string) => { const db = await openDb(dbName); const rows = await getAll<{ id: number; body: string; expiresAt?: number }>(db, 'messages'); const terms = await getAll<{ term: string }>(db, 'terms'); const meta = await getAll<{ k: string; v: unknown }>(db, 'meta'); db.close(); return { rows, terms, meta }; };

test('the feed drops a message at its expiresAt by one shared timer, without the network; preview and unread are recomputed', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const keep = await send(a.userId, chatId, 'остаётся');
  const cfg = srv.config(b);
  const e = await open(cfg);
  const feed = watchInto(e, { kind: 'messages', chatId, limit: 50 }), list = watchInto(e, { kind: 'chatList', limit: 50 });
  await feed.until((l) => bodies(l).includes('остаётся'));
  await setAutoDelete(a.userId, chatId, 2);
  await list.until((l) => row(l, chatId)?.autoDeleteSec === 2);
  const m1 = await send(a.userId, chatId, 'исчезнет раз');
  const m2 = await send(a.userId, chatId, 'исчезнет два');
  const shown = await feed.until((l) => bodies(l).includes('исчезнет два'));
  expect((shown.find((x) => x.id === m2.id) as { expiresAt?: number }).expiresAt).toBe(m2.expiresAt);
  expect(row(await list.until((l) => row(l, chatId)?.last?.id === m2.id), chatId).unread).toBeGreaterThanOrEqual(4);
  const unreadBefore = row(await list.until((l) => row(l, chatId)?.last?.id === m2.id), chatId).unread!;

  // один таймер на ближайший срок, а не по таймеру на сообщение
  const timers = (e as unknown as { expiryTimer: unknown }).expiryTimer;
  expect(timers).not.toBeNull();

  // сеть рвётся: всё равно исчезает само
  (e as unknown as { disconnect(): void }).disconnect();
  await feed.until((l) => !bodies(l).includes('исчезнет раз') && !bodies(l).includes('исчезнет два'), 5000);
  const after = await list.until((l) => row(l, chatId)?.unread === unreadBefore - 2, 3000);
  // служебное «включил автоудаление» срока не имеет — теперь оно последнее
  expect(row(after, chatId).last?.id).not.toBe(m2.id);
  expect(row(after, chatId).last?.id).toBeGreaterThan(keep.id);
  expect(m1.id).toBeLessThan(m2.id);
  await e.whenIdle();
  const { rows } = await stored(cfg.dbName);
  expect(rows.map((r) => r.id)).not.toContain(m1.id);
  expect(rows.map((r) => r.id)).not.toContain(m2.id);
});

test('an offline start after a long time: expired rows are gone from IndexedDB and search words, preview and counter are right before anything is shown', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  await send(a.userId, chatId, 'старое');
  await setAutoDelete(a.userId, chatId, 1);
  const cfg = srv.config(b);
  const e1 = await open(cfg);
  const feed1 = watchInto(e1, { kind: 'messages', chatId, limit: 50 }), list1 = watchInto(e1, { kind: 'chatList', limit: 50 });
  await feed1.until((l) => bodies(l).includes('старое'));
  const m = await send(a.userId, chatId, 'мимолётноеслово');
  await feed1.until((l) => bodies(l).includes('мимолётноеслово'));
  const before = row(await list1.until((l) => row(l, chatId)?.last?.id === m.id), chatId).unread!;
  await e1.whenIdle();
  await e1.close(); engines.length = 0;
  const inDb = await stored(cfg.dbName);
  expect(inDb.rows.some((r) => r.id === m.id && r.expiresAt === m.expiresAt)).toBe(true);
  expect(inDb.terms.some((t) => t.term.startsWith('мимол'))).toBe(true);
  await Bun.sleep(1300);

  // запуск без сети: сервер ни при чём
  const e2 = await open({ ...cfg, wsUrl: 'ws://127.0.0.1:9/none' }, false);
  const list2 = watchInto(e2, { kind: 'chatList', limit: 50 }), feed2 = watchInto(e2, { kind: 'messages', chatId, limit: 50 });
  const shownList = await list2.until((l) => !!row(l, chatId));
  expect(row(shownList, chatId).last?.id).not.toBe(m.id);
  expect(row(shownList, chatId).unread).toBe(before - 1);
  const shownFeed = await feed2.until((l) => bodies(l).includes('старое'));
  expect(bodies(shownFeed)).not.toContain('мимолётноеслово');
  await e2.whenIdle();
  const left = await stored(cfg.dbName);
  expect(left.rows.map((r) => r.id)).not.toContain(m.id);
  expect(left.terms.some((t) => t.term.startsWith('мимол'))).toBe(false);
});

test('files of expired messages are handed to the page for cleanup and survive a restart until acknowledged', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  await setAutoDelete(a.userId, chatId, 1);
  const [att] = await sql`insert into attachments (owner_id, mime, name, size, status, kind, width, height) values (${a.userId}, 'image/jpeg', 'cat.jpg', 10, 'ready', 'photo', 800, 600) returning id`;
  const cfg = srv.config(b);
  const e = await open(cfg);
  const feed = watchInto(e, { kind: 'messages', chatId, limit: 50 });
  const m = await send(a.userId, chatId, 'фото', { attachment: { id: att.id } });
  await feed.until((l) => l.some((x) => x.id === m.id));
  await feed.until((l) => !l.some((x) => x.id === m.id), 4000);
  await e.whenIdle();
  expect(e.status().expiredFiles).toEqual([att.id]);
  await e.close(); engines.length = 0;
  const e2 = await open({ ...cfg, wsUrl: 'ws://127.0.0.1:9/none' }, false);
  expect(e2.status().expiredFiles).toEqual([att.id]);
  await e2.call({ type: 'ackExpiredFiles', ids: [att.id as string] });
  expect(e2.status().expiredFiles).toEqual([]);
});

test('a pinned message unpins locally at expiry; the journal then confirms; the server job and the local timer do not double-count', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  await setAutoDelete(a.userId, chatId, 1);
  const e = await open(srv.config(b));
  const list = watchInto(e, { kind: 'chatList', limit: 50 }), feed = watchInto(e, { kind: 'messages', chatId, limit: 50 });
  const { pinMessage } = await import('../../../apps/server/src/domain/pins');
  const m = await send(a.userId, chatId, 'закреп');
  await pinMessage(a.userId, chatId, m.id);
  await list.until((l) => row(l, chatId)?.pinned?.includes(m.id) === true);
  const unreadBefore = row(list.list(), chatId).unread!;
  await feed.until((l) => !l.some((x) => x.id === m.id), 4000);
  const gone = await list.until((l) => !row(l, chatId)?.pinned?.includes(m.id));
  expect(row(gone, chatId).unread).toBe(unreadBefore - 1);
  // задача сервера: то же удаление журналом, счётчик второй раз не падает
  await Bun.sleep(100);
  expect((await expireStep()).erased).toBeGreaterThanOrEqual(1);
  await e.whenIdle();
  await Bun.sleep(150);
  await e.whenIdle();
  expect(row(list.list(), chatId).unread).toBe(unreadBefore - 1);
});

test('the setting reaches all devices through the journal; the operation shows at once and survives offline', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const d1 = await open(srv.config(a)), d2 = await open(srv.config(a)), eb = await open(srv.config(b));
  const l1 = watchInto(d1, { kind: 'chatList', limit: 50 }), l2 = watchInto(d2, { kind: 'chatList', limit: 50 }), lb = watchInto(eb, { kind: 'chatList', limit: 50 });
  await l1.until((l) => !!row(l, chatId));
  await d1.call({ type: 'setAutoDelete', chatId, sec: 86400 });
  await l1.until((l) => row(l, chatId)?.autoDeleteSec === 86400, 500);   // сразу: значение операции, не ответ сервера
  await l2.until((l) => row(l, chatId)?.autoDeleteSec === 86400);
  await lb.until((l) => row(l, chatId)?.autoDeleteSec === 86400);
  const [c] = await sql`select auto_delete_sec from chats where id = ${chatId}`;
  expect(c.auto_delete_sec).toBe(86400);
  await d2.call({ type: 'setAutoDelete', chatId, sec: null });
  await lb.until((l) => row(l, chatId)?.autoDeleteSec === null);
  await l1.until((l) => row(l, chatId)?.autoDeleteSec === null);
});

test('a refused operation (not an admin) rolls back to the server value', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис'), c = await srv.login('Вера');
  const chatId = await srv.chat(a.token, [a.userId, b.userId, c.userId]);   // группа, c — обычный участник
  await sql`update chat_members set role = 'owner' where chat_id = ${chatId} and user_id = ${a.userId}`;
  const e = await open(srv.config(c));
  const list = watchInto(e, { kind: 'chatList', limit: 50 });
  await list.until((l) => !!row(l, chatId));
  await e.call({ type: 'setAutoDelete', chatId, sec: 86400 });
  await e.whenIdle();
  await list.until((l) => row(l, chatId)?.autoDeleteSec === null, 1000);
  const [r] = await sql`select auto_delete_sec from chats where id = ${chatId}`;
  expect(r.auto_delete_sec).toBeNull();
});
