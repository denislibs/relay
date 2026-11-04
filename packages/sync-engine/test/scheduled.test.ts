import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sql } from '../../../apps/server/src/db';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { publishScheduled, scheduleMessage } from '../../../apps/server/src/domain/scheduled';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0], connect = true) => { const e = await Engine.open(cfg); engines.push(e); if (connect) { e.connect(); await e.whenIdle(); } return e; };
const soon = (ms = 3600_000) => Date.now() + ms;
const due = async (clientId: string) => sql`update scheduled_messages set send_at = now() - interval '1 second' where client_id = ${clientId}`;
const rowsOf = async (chatId: number) => sql`select client_id, user_id, send_at from scheduled_messages where chat_id = ${chatId}`;
const lastBody = (l: Record<string, unknown>[], id: number) => (l.find((c) => c.id === id)?.last as { body?: string } | null)?.body;

test('optimistic: in the list at once, not in the feed, the chat row counts it; the second device gets it, the other person does not', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const d1 = await open(srv.config(a)), d2 = await open(srv.config(a)), eb = await open(srv.config(b));
  const list1 = watchInto(d1, { kind: 'scheduled', chatId }), feed1 = watchInto(d1, { kind: 'messages', chatId, limit: 50 });
  const list2 = watchInto(d2, { kind: 'scheduled', chatId }), chats2 = watchInto(d2, { kind: 'chatList', limit: 50 });
  const listB = watchInto(eb, { kind: 'scheduled', chatId }), feedB = watchInto(eb, { kind: 'messages', chatId, limit: 50 });
  const at = soon();
  await d1.call({ type: 'sendMessage', chatId, body: 'потом', scheduleAt: at });
  const shown = await list1.until((l) => l.length === 1);
  expect(shown[0]).toMatchObject({ body: 'потом', scheduled: true, id: null, createdAt: new Date(at).toISOString() });
  await d1.whenIdle();
  await list2.until((l) => l.length === 1 && l[0].body === 'потом');
  await chats2.until((l) => l.find((c) => c.id === chatId)?.scheduled === 1);
  await eb.whenIdle();
  expect(listB.list()).toEqual([]);
  expect(feedB.list()).toEqual([]);
  expect(feed1.list()).toEqual([]);
});

test('edit, send now and delete: applied at once and synced to the other device', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const d1 = await open(srv.config(a)), d2 = await open(srv.config(a)), eb = await open(srv.config(b));
  const list1 = watchInto(d1, { kind: 'scheduled', chatId }), list2 = watchInto(d2, { kind: 'scheduled', chatId }), feedB = watchInto(eb, { kind: 'messages', chatId, limit: 50 });
  const feed2 = watchInto(d2, { kind: 'messages', chatId, limit: 50 });
  await d1.call({ type: 'sendMessage', chatId, body: 'один', scheduleAt: soon() });
  await d1.call({ type: 'sendMessage', chatId, body: 'два', scheduleAt: soon(7200_000) });
  await d1.whenIdle();
  const [one, two] = await list2.until((l) => l.length === 2);
  const later = soon(10_800_000);
  await d1.call({ type: 'scheduledEdit', chatId, clientId: one.key as string, sendAt: later, body: 'один правленый', entities: [] });
  // сразу: порядок и текст поменялись без ответа сервера
  await list1.until((l) => l.map((x) => x.body).join() === 'два,один правленый');
  await d1.whenIdle();
  await list2.until((l) => l[1]?.body === 'один правленый');
  await d1.call({ type: 'scheduledSendNow', chatId, clientId: two.key as string });
  await list1.until((l) => l.map((x) => x.body).join() === 'один правленый');
  await d1.whenIdle();
  await feedB.until((l) => l.some((m) => m.body === 'два'));
  await feed2.until((l) => l.some((m) => m.body === 'два' && typeof m.id === 'number'));
  await list2.until((l) => l.length === 1);
  await d1.call({ type: 'scheduledDelete', chatId, clientId: one.key as string });
  await list1.until((l) => l.length === 0);
  await d1.whenIdle();
  await list2.until((l) => l.length === 0);
  expect((await rowsOf(chatId)).length).toBe(0);
});

test('publication reaches the author: gone from the list and in the feed, normal id', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const e = await open(srv.config(a)), eb = await open(srv.config(b));
  const list = watchInto(e, { kind: 'scheduled', chatId }), feed = watchInto(e, { kind: 'messages', chatId, limit: 50 }), feedB = watchInto(eb, { kind: 'messages', chatId, limit: 50 });
  await e.call({ type: 'sendMessage', chatId, body: 'пора', scheduleAt: soon() });
  await e.whenIdle();
  const [item] = await list.until((l) => l.length === 1);
  await due(item.key as string);
  await publishScheduled(a.userId, item.key as string);
  const f = await feed.until((l) => l.some((m) => m.body === 'пора'));
  expect(typeof f[0].id).toBe('number');
  expect(f[0].key).toBe(item.key);
  await list.until((l) => l.length === 0);
  await feedB.until((l) => l.some((m) => m.body === 'пора'));
});

test('offline: waits in the queue and in the list, survives a restart, then gets planned on the server', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const cfg = srv.config(a);
  const e = await open(cfg);
  const feed0 = watchInto(e, { kind: 'chatList', limit: 50 });
  await feed0.until((l) => l.some((c) => c.id === chatId));
  e.disconnect();
  await e.call({ type: 'sendMessage', chatId, body: 'из самолёта', scheduleAt: soon() });
  const list = watchInto(e, { kind: 'scheduled', chatId });
  const pending = await list.until((l) => l.length === 1);
  expect(pending[0].status).toBe('pending');
  // пока не на сервере — правки и удаление в очереди
  await e.call({ type: 'scheduledEdit', chatId, clientId: pending[0].key as string, body: 'из самолёта!', entities: [] });
  await list.until((l) => l[0]?.body === 'из самолёта!');
  expect((await rowsOf(chatId)).length).toBe(0);
  await e.close(); engines.length = 0;
  const again = await open(cfg, false);
  const list2 = watchInto(again, { kind: 'scheduled', chatId }), feed = watchInto(again, { kind: 'messages', chatId, limit: 50 });
  await list2.until((l) => l.length === 1 && l[0].body === 'из самолёта!');
  expect(feed.list()).toEqual([]);
  again.connect();
  await again.whenIdle();
  const sent = await list2.until((l) => l.length === 1 && l[0].status === 'sent');
  expect(sent[0].body).toBe('из самолёта!');
  expect((await rowsOf(chatId)).length).toBe(1);
  expect(feed.list()).toEqual([]);
});

test('offline, and the time passed before the network came back: goes at once, as a plain message', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const e = await open(srv.config(a));
  e.disconnect();
  await e.call({ type: 'sendMessage', chatId, body: 'опоздавшее', scheduleAt: Date.now() + 30 });
  const list = watchInto(e, { kind: 'scheduled', chatId }), feed = watchInto(e, { kind: 'messages', chatId, limit: 50 });
  await list.until((l) => l.length === 1);
  await Bun.sleep(60);
  e.connect();
  await e.whenIdle();
  await feed.until((l) => l.some((m) => m.body === 'опоздавшее' && typeof m.id === 'number'));
  await list.until((l) => l.length === 0);
  expect((await rowsOf(chatId)).length).toBe(0);
});

test('offline deletes and edits of what is already on the server go through the op queue', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const e = await open(srv.config(a));
  const list = watchInto(e, { kind: 'scheduled', chatId });
  await e.call({ type: 'sendMessage', chatId, body: 'x', scheduleAt: soon() });
  await e.call({ type: 'sendMessage', chatId, body: 'y', scheduleAt: soon(7200_000) });
  await e.whenIdle();
  const [x, y] = await list.until((l) => l.length === 2 && l.every((m) => m.status === 'sent'));
  e.disconnect();
  await e.call({ type: 'scheduledDelete', chatId, clientId: x.key as string });
  await e.call({ type: 'scheduledEdit', chatId, clientId: y.key as string, body: 'y2', entities: [] });
  await list.until((l) => l.map((m) => m.body).join() === 'y2');
  expect((await rowsOf(chatId)).length).toBe(2);
  e.connect();
  await e.whenIdle();
  const rows = await rowsOf(chatId);
  expect(rows.map((r) => r.client_id)).toEqual([y.key]);
  await list.until((l) => l.length === 1 && l[0].body === 'y2');
});

test('another device of a user that was offline gets the list from the snapshot', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  await scheduleMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'до входа', scheduleAt: soon() });
  const e = await open(srv.config(a));
  const list = watchInto(e, { kind: 'scheduled', chatId });
  await list.until((l) => l.length === 1 && l[0].body === 'до входа');
});

test('server refusal: the failed mark stays in the list with its code', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис'), c = await srv.login('Вера');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const e = await open(srv.config(c));
  const list = watchInto(e, { kind: 'scheduled', chatId });
  await e.call({ type: 'sendMessage', chatId, body: 'чужой чат', scheduleAt: soon() });
  await e.whenIdle();
  const [m] = await list.until((l) => l.length === 1 && l[0].status === 'failed');
  expect(m.error).toBe('not_member');
  await e.call({ type: 'scheduledDelete', chatId, clientId: m.key as string });
  await list.until((l) => l.length === 0);
});

test('silent: the message arrives and counts as unread, without a notification', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a)), eb = await open(srv.config(b));
  const alerts = watchInto(eb, { kind: 'notifications' }), chats = watchInto(eb, { kind: 'chatList', limit: 50 });
  await ea.call({ type: 'sendMessage', chatId, body: 'тише', silent: true });
  await ea.whenIdle();
  const rows = await chats.until((l) => lastBody(l, chatId) === 'тише');
  expect(rows.find((c) => c.id === chatId)!.unread).toBe(1);
  await eb.whenIdle();
  expect(alerts.list()).toEqual([]);
  await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'громко' });
  const got = await alerts.until((l) => l.length === 1);
  expect(got[0].body).toBe('громко');
});

test('reminder: notifies its author, an ordinary note in Saved does not', async () => {
  const a = await srv.login('Анна');
  const e = await open(srv.config(a));
  const chatId = await e.call({ type: 'savedChat' }) as number;
  const alerts = watchInto(e, { kind: 'notifications' }), list = watchInto(e, { kind: 'scheduled', chatId });
  await e.call({ type: 'sendMessage', chatId, body: 'заметка' });
  await e.call({ type: 'sendMessage', chatId, body: 'напомни', scheduleAt: soon() });
  await e.whenIdle();
  const [item] = await list.until((l) => l.length === 1);
  await due(item.key as string);
  await publishScheduled(a.userId, item.key as string);
  const got = await alerts.until((l) => l.length === 1);
  expect(got[0]).toMatchObject({ body: 'напомни', reminder: true, senderId: a.userId });
});
