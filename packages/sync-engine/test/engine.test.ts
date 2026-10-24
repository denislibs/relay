import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sql } from '../../../apps/server/src/db';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { deleteMessage, editMessage } from '../../../apps/server/src/domain/messageOps';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };

test('message from A reaches B: chat list, unread and the feed update live', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const eb = await open(srv.config(b));
  eb.connect();
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  const feed = watchInto(eb, { kind: 'messages', chatId, limit: 50 });
  await eb.whenIdle();

  await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'привет' });
  const chats = await list.until((l) => l.length === 1 && (l[0].unread as number) === 1);
  expect(chats[0]).toMatchObject({ id: chatId, last: { body: 'привет' } });
  await feed.until((l) => l.length === 1 && l[0].body === 'привет');
  expect(list.patches[0].op).toBe('snapshot');
});

test('first start with existing history takes a snapshot and does not double count', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  for (let i = 0; i < 3; i++) await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'm' + i });
  const eb = await open(srv.config(b));
  eb.connect();
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  await eb.whenIdle();
  const l = await list.until((x) => x.length === 1);
  expect(l[0]).toMatchObject({ unread: 3, last: { body: 'm2' } });
});

test('tooLong: a trimmed journal falls back to a snapshot and keeps going', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const cfg = srv.config(b);
  const eb = await open(cfg);
  eb.connect();
  await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'старое' });
  await eb.whenIdle();
  await eb.close(); engines.length = 0;

  // пока B офлайн: новые сообщения, затем сервер чистит журнал B
  for (let i = 0; i < 2; i++) await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'новое' + i });
  await sql`delete from updates where user_id = ${b.userId}`;

  const again = await open(cfg);
  again.connect();
  const list = watchInto(again, { kind: 'chatList', limit: 50 });
  await again.whenIdle();
  const l = await list.until((x) => x.length === 1 && (x[0].last as { body: string }).body === 'новое1');
  expect(l[0].unread).toBe(3);
  await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'после' });
  await list.until((x) => (x[0].last as { body: string }).body === 'после' && x[0].unread === 4);
});

test('watching a chat loads history from the server; growing the limit pages older', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  for (let i = 1; i <= 7; i++) await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: String(i) });
  const eb = await open({ ...srv.config(b), historyPage: 3 });
  eb.connect();
  await eb.whenIdle();
  const feed = watchInto(eb, { kind: 'messages', chatId, limit: 3 });
  await feed.until((l) => l.map((m) => m.body).join() === '5,6,7');
  feed.handle.update({ kind: 'messages', chatId, limit: 7 });
  await feed.until((l) => l.map((m) => m.body).join() === '1,2,3,4,5,6,7');
});

test('edits and deletions of a chat not opened since start reach the cached copy', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ids: number[] = [];
  for (let i = 1; i <= 3; i++) ids.push((await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'm' + i })).message.id);
  const cfg = srv.config(b);
  const eb = await open(cfg);
  eb.connect();
  await eb.whenIdle();
  const feed = watchInto(eb, { kind: 'messages', chatId, limit: 50 });
  await feed.until((l) => l.length === 3);   // сообщения легли в кэш устройства
  await eb.whenIdle();
  await eb.close(); engines.length = 0;

  // B снова в сети, но чат не открывает: правка и удаление приходят журналом
  await deleteMessage(a.userId, chatId, ids[0]);
  await editMessage(a.userId, chatId, ids[1], 'm2 правка');
  const again = await open(cfg);
  again.connect();
  await again.whenIdle();
  await again.close(); engines.length = 0;

  // без сети лента читается из кэша: там уже правка, а удалённого нет
  const offline = await open(cfg);
  const cached = watchInto(offline, { kind: 'messages', chatId, limit: 50 });
  const l = await cached.until((x) => x.length > 0);
  expect(l.map((m) => m.id)).toEqual([ids[1], ids[2]]);
  expect(l[0]).toMatchObject({ body: 'm2 правка' });
});

test('a quote fetched online survives an offline restart: its source is stored as a loose message', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const src = (await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'исходник' })).message.id;
  for (let i = 1; i <= 30; i++) await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'f' + i });
  await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'ответ', replyToId: src });
  const cfg = { ...srv.config(b), historyPage: 3 };
  const eb = await open(cfg);
  eb.connect();
  await eb.whenIdle();
  const feed = watchInto(eb, { kind: 'messages', chatId, limit: 3 });
  // исходника нет в загруженной странице — цитата приходит отдельным запросом
  const quoteOf = (l: { body?: unknown; reply?: unknown }[]) => (l.find((m) => m.body === 'ответ')?.reply as { body?: string } | null | undefined)?.body;
  await feed.until((l) => quoteOf(l) === 'исходник');
  expect(feed.list().map((m) => m.body)).toEqual(['f29', 'f30', 'ответ']);   // в ленту исходник не попал: отрезки не тронуты
  await eb.whenIdle();
  await eb.close(); engines.length = 0;

  // перезапуск без сети на той же базе: цитата — из сохранённой строки
  const cold = await open(cfg);
  const feed2 = watchInto(cold, { kind: 'messages', chatId, limit: 3 });
  const l = await feed2.until((x) => x.some((m) => m.body === 'ответ'));
  await Bun.sleep(30);
  expect(quoteOf(feed2.list())).toBe('исходник');
  expect(l.map((m) => m.body)).toEqual(['f29', 'f30', 'ответ']);
});
