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

const chatOf = (l: Record<string, any>[], id: number) => l.find((i) => i.id === id);
test('mute on one device arrives through the journal on another', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a)), ea2 = await open(srv.config(a));
  ea.connect(); ea2.connect();
  await Promise.all([ea.whenIdle(), ea2.whenIdle()]);
  const l1 = watchInto(ea, { kind: 'chatList', limit: 50 }), l2 = watchInto(ea2, { kind: 'chatList', limit: 50 });
  await l2.until((l) => chatOf(l, chatId)?.muteUntil === null);

  const until = Date.now() + 3_600_000;
  await ea.call({ type: 'setMute', chatId, muteUntil: until });
  await l1.until((l) => chatOf(l, chatId)?.muteUntil === until);          // сразу, до ответа сервера
  await l2.until((l) => chatOf(l, chatId)?.muteUntil === until);          // по журналу
  await ea.call({ type: 'setMute', chatId, muteUntil: null });
  await l2.until((l) => chatOf(l, chatId)?.muteUntil === null);
  await ea.call({ type: 'setMute', chatId, muteUntil: 0 });
  await l2.until((l) => chatOf(l, chatId)?.muteUntil === 0);
  await ea.whenIdle();
  await l1.until((l) => chatOf(l, chatId)?.muteUntil === 0);
});

test('offline mute shows at once, replaces the unsent one and goes out after connect', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const list = watchInto(ea, { kind: 'chatList', limit: 50 });
  await list.until((l) => chatOf(l, chatId)?.muteUntil === null);
  ea.disconnect();

  const first = Date.now() + 60_000, until = Date.now() + 7_200_000;
  await ea.call({ type: 'setMute', chatId, muteUntil: first });
  await ea.call({ type: 'setMute', chatId, muteUntil: until });
  await list.until((l) => chatOf(l, chatId)?.muteUntil === until);
  const ops = watchInto(ea, { kind: 'ops' });
  await ops.until((l) => l[0]?.pending === 1);               // новая заменила неотправленную
  const [{ n }] = await sql`select count(*)::int as n from chat_members where chat_id = ${chatId} and user_id = ${a.userId} and mute_until is not null`;
  expect(n).toBe(0);

  ea.connect();
  await ea.whenIdle();
  await ops.until((l) => l[0]?.pending === 0);
  await list.until((l) => chatOf(l, chatId)?.muteUntil === until);          // после подтверждения — значение сервера, без отката
  expect(list.patches.filter((p) => p.op !== 'snapshot' && p.upsert.some((i) => i.id === chatId && i.muteUntil !== until && i.muteUntil !== null)).length).toBe(0);
  const [row] = await sql`select (extract(epoch from mute_until) * 1000)::bigint as ms from chat_members where chat_id = ${chatId} and user_id = ${a.userId}`;
  expect(Number(row.ms)).toBe(until);
});
