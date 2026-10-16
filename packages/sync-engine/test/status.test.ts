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
