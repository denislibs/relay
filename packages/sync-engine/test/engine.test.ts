import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sql } from '../../../apps/server/src/db';
import { sendMessage } from '../../../apps/server/src/domain/messages';
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
