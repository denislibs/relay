import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { getHistory } from '../../../apps/server/src/domain/chats';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { Engine } from '../src/engine';
import type { Query } from '../src/types';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
const realFetch = globalThis.fetch;
beforeEach(resetDb);
afterEach(async () => { globalThis.fetch = realFetch; for (const e of engines.splice(0)) await e.close(); });

/** Чат из 30 сообщений; у B — живой отрезок (снимок) и отдельный старый отрезок ids[3..6] (как после вытеснения). */
async function setup() {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ids: number[] = [];
  for (let i = 0; i < 30; i++) ids.push((await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'm' + i })).message.id);
  const eb = await Engine.open({ ...srv.config(b), historyPage: 5 });
  engines.push(eb);
  eb.connect();
  await eb.whenIdle();
  await eb.store.loadChatMessages(chatId);
  const old = await getHistory(b.userId, chatId, ids[7], 4);
  eb.store.applyHistory(chatId, old.messages, true, ids[7]);
  expect(eb.store.chats.get(chatId)!.ranges).toEqual([[ids[3], ids[6]], [ids[29], ids[29]]]);
  const ranges = () => eb.store.chats.get(chatId)!.ranges;
  const at = (sort: number, limit = 10): Query => ({ kind: 'messages', chatId, limit, anchor: { sort, side: 'start' } });
  return { eb, chatId, ids, ranges, at };
}

test('paging newer from an old range loads pages upward and merges into the live range', async () => {
  const { eb, ids, ranges, at } = await setup();
  const feed = watchInto(eb, at(ids[5]));
  await eb.whenIdle();
  for (let k = 0; k < 20 && ranges().length > 1; k++) {
    feed.handle.update(at(ranges()[0][1], 10 + k));   // окно у нового края старого отрезка
    await eb.whenIdle();
  }
  expect(ranges()).toHaveLength(1);
  expect(ranges()[0][1]).toBe(ids[29]);
  expect(ranges()[0][0]).toBeLessThanOrEqual(ids[3]);
  await feed.until((l) => l.length > 0 && l[l.length - 1].id === ids[29]);
});

test('newer paging: one request per chat at a time, and it does not hold up older paging', async () => {
  const { eb, chatId, ids, ranges, at } = await setup();
  let inflight = 0, most = 0, afterReqs = 0, beforeReqs = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('&after=')) {
      afterReqs++; inflight++; most = Math.max(most, inflight);
      try { await gate; return await realFetch(input, init); } finally { inflight--; }
    }
    if (/\/messages\?.*before=/.test(url)) beforeReqs++;
    return realFetch(input, init);
  }) as typeof fetch;

  const feed = watchInto(eb, at(ids[6]));
  for (let k = 0; k < 3; k++) { await Bun.sleep(10); feed.handle.update(at(ids[6], 11 + k)); }
  await Bun.sleep(50);
  expect(afterReqs).toBe(1);

  // пока страница новее висит — старые страницы живого отрезка грузятся
  const before = beforeReqs;
  await Promise.race([eb.call({ type: 'loadOlder', chatId }), Bun.sleep(2000).then(() => { throw new Error('older paging blocked'); })]);
  expect(beforeReqs).toBeGreaterThan(before);
  expect(ranges()[ranges().length - 1][0]).toBeLessThan(ids[29]);

  release();
  await eb.whenIdle();
  expect(most).toBe(1);
  expect(ranges()[0][1]).toBeGreaterThan(ids[6]);   // страница новее легла в старый отрезок
});
