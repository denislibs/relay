import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };

test('status query follows the connection and counts unsent messages', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  const st = watchInto(ea, { kind: 'status' });
  await st.until((l) => l[0]?.online === false);
  await ea.call({ type: 'sendMessage', chatId, body: 'офлайн' });
  await st.until((l) => l[0].outbox === 1);
  ea.connect();
  await st.until((l) => l[0].online === true && l[0].synced === true && l[0].outbox === 0);
  ea.disconnect();
  await st.until((l) => l[0].online === false && l[0].synced === false);
});

test('a chat first seen through a message gets its name from the server', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const eb = await open(srv.config(b));
  eb.connect();
  await eb.whenIdle();
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);   // чат создан после снимка
  await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'привет' });
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  const l = await list.until((x) => x.length === 1 && x[0].title === 'Анна');
  expect(l[0]).toMatchObject({ unread: 1, peerId: a.userId });
});

test('snapshot brings the peer read pointer, so my old messages show as read', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const { message } = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'давно' });
  const { markRead } = await import('../../../apps/server/src/domain/reads');
  await markRead(b.userId, chatId, message.id);
  const ea = await open(srv.config(a));          // первый вход A — через снимок
  ea.connect();
  const list = watchInto(ea, { kind: 'chatList', limit: 50 });
  await list.until((l) => (l[0]?.last as { status: string } | null)?.status === 'read');
});

test('status phase: connecting right after connect, ready when synced; the cache stays hydrated across restarts', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  await srv.chat(a.token, [a.userId, b.userId]);
  const cfg = srv.config(a);
  const ea = await open(cfg);
  expect(ea.status()).toMatchObject({ phase: 'offline', hydrated: false }); // подключаться ещё не просили
  ea.connect();
  expect(ea.status().phase).toBe('connecting');
  const st = watchInto(ea, { kind: 'status' });
  await st.until((l) => l[0]?.phase === 'ready' && l[0].hydrated === true);
  await ea.close();
  const again = await open(cfg);                  // перезагрузка страницы: тот же IndexedDB
  expect(again.status()).toMatchObject({ phase: 'offline', hydrated: true });
  again.connect();
  await watchInto(again, { kind: 'status' }).until((l) => l[0]?.phase === 'ready');
});

test('status phase turns offline once connection attempts keep failing', async () => {
  const a = await srv.login('a');
  const ea = await open({ ...srv.config(a), wsUrl: 'ws://127.0.0.1:1/ws', backoffMs: [10, 20] });
  const st = watchInto(ea, { kind: 'status' });
  ea.connect();
  await st.until((l) => l[0]?.phase === 'offline' && l[0].online === false);
});

test('catch-up after reconnect reaches the UI as one batch, not page by page', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chats = [];
  for (let i = 0; i < 3; i++) chats.push(await srv.chat(a.token, [a.userId, b.userId]));
  const ea = await open({ ...srv.config(a), frameMs: 1 });   // кадр 1 мс: без удержания каждая страница ушла бы отдельно
  ea.connect();
  const list = watchInto(ea, { kind: 'chatList', limit: 50 });
  await list.until((l) => l.length === 3);
  await ea.whenIdle();
  ea.disconnect();
  for (let i = 0; i < 300; i++) await sendMessage(b.userId, { chatId: chats[i % 3], clientId: crypto.randomUUID(), body: 'm' + i });
  process.env.RELAY_SYNC_BATCH = '20';               // 15 страниц журнала
  const before = list.patches.length;
  const st = watchInto(ea, { kind: 'status' });
  await st.until((l) => l[0]?.phase === 'offline');
  ea.connect();
  await list.until((l) => l.reduce((s, c) => s + (c.unread as number), 0) === 300, 8000).finally(() => { delete process.env.RELAY_SYNC_BATCH; });
  await Bun.sleep(50);
  expect(list.patches.length - before).toBe(1);
  const phases = st.patches.flatMap((p) => (p.op === 'snapshot' ? p.items : p.upsert)).map((i) => i.phase);
  expect(phases).toEqual(expect.arrayContaining(['offline', 'updating', 'ready']));   // стадия догонки видна, даже если она короче кадра
}, 30000);

test('opening a chat: the first feed patch is already complete (no empty or partial frames)', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  for (let i = 0; i < 80; i++) await sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body: 'h' + i });
  const ea = await open({ ...srv.config(a), frameMs: 1, historyPage: 30 });
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 60 });
  await feed.until((l) => l.length === 60);
  expect(feed.patches[0].op).toBe('snapshot');
  expect((feed.patches[0] as { items: unknown[] }).items.length).toBe(60);
});

test('presence: the peer goes online and offline; unknown while disconnected', async () => {
  process.env.RELAY_PRESENCE_GRACE_MS = '40';
  const a = await srv.login('a'), b = await srv.login('b');
  await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  const p = watchInto(ea, { kind: 'presence', userId: b.userId });
  await p.until((l) => l[0]?.known === false);
  ea.connect();
  await p.until((l) => l[0].known === true && l[0].online === false);       // снимок: b ещё не заходил
  const eb = await open(srv.config(b));
  eb.connect();
  await p.until((l) => l[0].online === true);                                 // живой кадр
  await eb.close();
  await p.until((l) => l[0].online === false && typeof l[0].lastSeen === 'string');
  ea.disconnect();
  await p.until((l) => l[0].known === false);
  delete process.env.RELAY_PRESENCE_GRACE_MS;
});

test('dialogs load in pages: first page + every unread chat, then more on demand until complete', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const ids: number[] = [];
  for (let i = 0; i < 7; i++) {
    const id = await srv.chat(a.token, [a.userId, b.userId]);
    ids.push(id);
    // самый старый чат — непрочитанный (пишет b), остальные — мои сообщения
    await sendMessage(i === 0 ? b.userId : a.userId, { chatId: id, clientId: crypto.randomUUID(), body: 'm' + i });
  }
  const ea = await open({ ...srv.config(a), dialogsPage: 3 });
  const list = watchInto(ea, { kind: 'chatList', limit: 100 });
  const st = watchInto(ea, { kind: 'status' });
  ea.connect();
  await list.until((l) => l.length === 4);                      // страница (6,5,4) + непрочитанный 0
  expect(list.list().map((c) => c.id)).toEqual([ids[6], ids[5], ids[4], ids[0]]);
  expect(st.list()[0].chatsComplete).toBe(false);
  await ea.call({ type: 'loadMoreChats' });
  await list.until((l) => l.length === 7);
  await ea.call({ type: 'loadMoreChats' });                      // последняя страница: только 0, он уже есть
  await st.until((l) => l[0].chatsComplete === true);
  expect(list.list().map((c) => c.id)).toEqual([...ids].reverse());
});

test('drafts: saved per chat, lift the chat in the list, survive a restart, cleared on send', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const older = await srv.chat(a.token, [a.userId, b.userId]);
  await sendMessage(b.userId, { chatId: older, clientId: crypto.randomUUID(), body: 'старое' });
  const newer = await srv.chat(a.token, [a.userId, b.userId]);
  await sendMessage(b.userId, { chatId: newer, clientId: crypto.randomUUID(), body: 'новое' });
  const cfg = srv.config(a);
  const ea = await open(cfg);
  ea.connect();
  const list = watchInto(ea, { kind: 'chatList', limit: 10 });
  await list.until((l) => l.length === 2 && l[0].id === newer);

  await ea.call({ type: 'setDraft', chatId: older, text: 'недописанное' });
  await list.until((l) => l[0].id === older && l[0].draft === 'недописанное');   // черновик поднял чат

  await ea.close();
  const again = await open(cfg);                                            // перезагрузка: тот же IndexedDB
  const list2 = watchInto(again, { kind: 'chatList', limit: 10 });
  await list2.until((l) => l.find((c) => c.id === older)?.draft === 'недописанное');

  await again.call({ type: 'sendMessage', chatId: older, body: 'недописанное' });
  await list2.until((l) => l.find((c) => c.id === older)?.draft === null);
  await again.call({ type: 'setDraft', chatId: newer, text: '   ' });         // пробелы — не черновик
  expect(list2.list().find((c) => c.id === newer)?.draft).toBeNull();
});
