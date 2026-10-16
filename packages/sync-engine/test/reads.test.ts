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

test('20 seen calls collapse into one read; unread drops locally at once; sender sees read', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a)), eb = await open(srv.config(b));
  ea.connect(); eb.connect();
  await Promise.all([ea.whenIdle(), eb.whenIdle()]);

  const ids: number[] = [];
  for (let i = 0; i < 20; i++) ids.push((await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'm' + i })).message.id);
  const listB = watchInto(eb, { kind: 'chatList', limit: 50 });
  await listB.until((l) => l[0]?.unread === 20);

  const before = await sql`select count(*)::int as n from updates where user_id = ${a.userId} and type = 'readBy'`;
  for (const id of ids) await eb.call({ type: 'seen', chatId, upToId: id });
  await listB.until((l) => l[0].unread === 0);                  // локально, ещё до сервера
  await eb.whenIdle();
  const after = await sql`select count(*)::int as n from updates where user_id = ${a.userId} and type = 'readBy'`;
  expect(after[0].n - before[0].n).toBe(1);
  const [{ last_read_id }] = await sql`select last_read_id from chat_members where chat_id = ${chatId} and user_id = ${b.userId}`;
  expect(last_read_id).toBe(ids[19]);

  const listA = watchInto(ea, { kind: 'chatList', limit: 50 });
  await ea.whenIdle();
  expect((await listA.until((l) => l.length === 1))[0]).toBeTruthy();
});

test('own message turns read when the peer reads it', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a)), eb = await open(srv.config(b));
  ea.connect(); eb.connect();
  await Promise.all([ea.whenIdle(), eb.whenIdle()]);
  const feedA = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await ea.call({ type: 'sendMessage', chatId, body: 'прочитай' });
  const [mine] = await feedA.until((l) => l.length === 1 && l[0].status === 'sent');
  await eb.whenIdle();
  await eb.call({ type: 'seen', chatId, upToId: mine.id as number });
  await feedA.until((l) => l[0].status === 'read');
});

test('seen while offline survives a restart and is sent after reconnecting', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const cfg = srv.config(b);
  const eb = await open(cfg);
  eb.connect();
  const { message } = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'x' });
  await eb.whenIdle();
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  await list.until((l) => l[0]?.unread === 1);
  eb.disconnect();
  await eb.call({ type: 'seen', chatId, upToId: message.id });
  await eb.close(); engines.length = 0;

  const again = await open(cfg);
  again.connect();
  await again.whenIdle();
  const [{ last_read_id }] = await sql`select last_read_id from chat_members where chat_id = ${chatId} and user_id = ${b.userId}`;
  expect(last_read_id).toBe(message.id);
});
