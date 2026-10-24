import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { Engine, HISTORY_AHEAD } from '../src/engine';
import { feedSpan, messageWindow } from '../src/queries';
import type { Query } from '../src/types';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
const realFetch = globalThis.fetch;
beforeEach(resetDb);
afterEach(async () => { globalThis.fetch = realFetch; for (const e of engines.splice(0)) await e.close(); });

const PAGE = 5;
async function setup(n: number) {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push((await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'm' + i })).message.id);
  const eb = await Engine.open({ ...srv.config(b), historyPage: PAGE });
  engines.push(eb);
  eb.connect();
  await eb.whenIdle();
  /** Сколько сообщений загружено старше начала окна запроса — запас прокрутки вверх. */
  const lead = (q: Extract<Query, { kind: 'messages' }>) => {
    const all = eb.store.chatMessages(chatId), span = feedSpan(eb.store.chats.get(chatId), all, q.anchor?.sort);
    return messageWindow(all, q, span.lo, span.hi).from - span.lo;
  };
  return { eb, chatId, ids, lead };
}

test('history prefetch: HISTORY_AHEAD pages stay loaded above the window — at the live end and after each shift older', async () => {
  const { eb, chatId, ids, lead } = await setup(60);
  const live: Extract<Query, { kind: 'messages' }> = { kind: 'messages', chatId, limit: 10 };
  const feed = watchInto(eb, live);
  await feed.until((l) => l.length === 10);
  await eb.whenIdle();
  expect(lead(live)).toBeGreaterThanOrEqual(PAGE * HISTORY_AHEAD);
  // окно сдвигают к старым на страницу (как лента): запас каждый раз дотягивается в фоне
  let end = ids.length - 1;
  for (let k = 0; k < 5; k++) {
    end -= PAGE;
    const q: Extract<Query, { kind: 'messages' }> = { kind: 'messages', chatId, limit: 10, anchor: { sort: ids[end], side: 'end' } };
    feed.handle.update(q);
    await feed.until((l) => l.length === 10 && l[l.length - 1].id === ids[end]);
    await eb.whenIdle();
    expect(lead(q)).toBeGreaterThanOrEqual(PAGE * HISTORY_AHEAD);
  }
});

test('history prefetch: a shift older is served from the cache at once — the page from the server only tops up the lead', async () => {
  const { eb, chatId, ids, lead } = await setup(40);
  const feed = watchInto(eb, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l.length === 10);
  await eb.whenIdle();
  // сервер «завис»: сдвиг окна не должен его ждать
  let release!: () => void, asked = 0;
  const gate = new Promise<void>((r) => { release = r; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (/\/messages\?.*before=/.test(String(input))) { asked++; await gate; }
    return realFetch(input, init);
  }) as typeof fetch;
  const end = ids.length - 1 - PAGE;
  const q: Extract<Query, { kind: 'messages' }> = { kind: 'messages', chatId, limit: 10, anchor: { sort: ids[end], side: 'end' } };
  feed.handle.update(q);
  const l = await feed.until((x) => x.length === 10 && x[x.length - 1].id === ids[end], 1000);
  expect(l[0].id).toBe(ids[end - 9]);
  for (let i = 0; i < 200 && !asked; i++) await Bun.sleep(5);
  expect(asked).toBe(1);   // запас дотягивается в фоне
  release();
  await eb.whenIdle();
  expect(lead(q)).toBeGreaterThanOrEqual(PAGE * HISTORY_AHEAD);
});

test('history prefetch stops at the start of the chat', async () => {
  const { eb, chatId, lead } = await setup(12);
  let asked = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (/\/messages\?/.test(String(input))) asked++;
    return realFetch(input, init);
  }) as typeof fetch;
  const live: Extract<Query, { kind: 'messages' }> = { kind: 'messages', chatId, limit: 10 };
  const feed = watchInto(eb, live);
  await feed.until((l) => l.length === 10);
  await eb.whenIdle();
  expect(lead(live)).toBe(2);
  expect(eb.store.chats.get(chatId)!.historyStart).toBe(true);
  const before = asked;
  feed.handle.update({ ...live, anchor: { sort: (feed.list()[5].sort as number), side: 'end' } });
  await eb.whenIdle();
  expect(asked).toBe(before);   // история уже с начала — больше не спрашиваем
});
