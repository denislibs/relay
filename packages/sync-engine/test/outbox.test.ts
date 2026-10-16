import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sql } from '../../../apps/server/src/db';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };

test('offline send shows pending at once, survives a restart, then goes out exactly once in order', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const cfg = srv.config(a);
  const ea = await open(cfg);
  ea.connect();
  await ea.whenIdle();
  ea.disconnect();

  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  for (const body of ['раз', 'два', 'три']) await ea.call({ type: 'sendMessage', chatId, body });
  const pending = await feed.until((l) => l.length === 3);
  expect(pending.map((m) => [m.body, m.status])).toEqual([['раз', 'pending'], ['два', 'pending'], ['три', 'pending']]);

  await ea.close(); engines.length = 0;                   // «закрыли вкладку»
  const again = await open(cfg);                          // открыли снова, всё ещё офлайн
  const feed2 = watchInto(again, { kind: 'messages', chatId, limit: 50 });
  await feed2.until((l) => l.length === 3 && l.every((m) => m.status === 'pending'));

  again.connect();
  await again.whenIdle();
  const sent = await feed2.until((l) => l.length === 3 && l.every((m) => m.status === 'sent'));
  expect(sent.map((m) => m.body)).toEqual(['раз', 'два', 'три']);
  const rows = await sql`select body from messages where chat_id = ${chatId} order by id`;
  expect(rows.map((r) => r.body)).toEqual(['раз', 'два', 'три']);
});

test('a non-retryable error marks the message failed; retry sends it after a fix', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  const { clientId } = (await ea.call({ type: 'sendMessage', chatId, body: '   ' })) as { clientId: string };
  await feed.until((l) => l.length === 1 && l[0].status === 'failed');
  // тело пустое — повтор снова упадёт, но очередь не застревает: следующее сообщение уходит
  await ea.call({ type: 'sendMessage', chatId, body: 'нормальное' });
  await feed.until((l) => l.length === 2 && l.find((m) => m.body === 'нормальное')?.status === 'sent');
  await ea.call({ type: 'retry', clientId });
  await feed.until((l) => l.find((m) => m.key === clientId)?.status === 'failed');
});
