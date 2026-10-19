import { sql } from '../../../apps/server/src/db';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

// Несколько файлов грузятся сразу (до трёх), а уходят в чат в том порядке, в каком их поставили: альбом не перемешается.
const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
const realFetch = globalThis.fetch;
beforeEach(resetDb);
afterEach(async () => { globalThis.fetch = realFetch; for (const e of engines.splice(0)) await e.close(); });

/** PUT в хранилище висит, пока тест не отпустит его; файлы различаем по размеру. */
function holdPuts() {
  const held = new Map<number, () => void>();
  let waiters: (() => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT' && String(input).includes('X-Amz-Signature')) {
      const size = (init.body as Blob).size;
      await new Promise<void>((r, reject) => {
        held.set(size, r); for (const w of waiters) w(); waiters = [];
        init.signal?.addEventListener('abort', () => { held.delete(size); reject(new DOMException('aborted', 'AbortError')); });
      });
      return realFetch(input, init);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const until = async (f: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!f()) {
      if (Date.now() > end) throw new Error('timeout; in flight: ' + [...held.keys()].join(','));
      await Promise.race([new Promise<void>((r) => waiters.push(r)), Bun.sleep(20)]);
    }
  };
  const release = (size: number) => { const r = held.get(size)!; held.delete(size); r(); };
  return { held, until, release };
}

async function setup() {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await Engine.open(srv.config(a));
  engines.push(ea);
  ea.connect();
  await ea.whenIdle();
  return { chatId, ea };
}
const file = (n: number) => new Blob([new Uint8Array(n).fill(7)], { type: 'image/png' });
const send = (ea: Engine, chatId: number, n: number, groupId?: string) =>
  ea.call({ type: 'sendFile', chatId, body: 'f' + n, file: file(n), name: `p${n}.png`, mime: 'image/png', w: 4, h: 2, thumb: null, ...(groupId ? { groupId } : {}) });
const bodies = async (chatId: number) => (await sql`select body from messages where chat_id = ${chatId} order by id`).map((r: { body: string }) => r.body);

test('three files upload at once; the fourth waits for a free slot', async () => {
  const { chatId, ea } = await setup();
  const puts = holdPuts();
  for (const n of [11, 12, 13, 14]) await send(ea, chatId, n);
  await puts.until(() => puts.held.size === 3);
  await Bun.sleep(150);
  expect([...puts.held.keys()].sort()).toEqual([11, 12, 13]);   // четвёртый не начат
  puts.release(12);
  await puts.until(() => puts.held.has(14));
  for (const n of [11, 13, 14]) puts.release(n);
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l.length === 4 && l.every((m) => m.status === 'sent'), 5000);
  expect(await bodies(chatId)).toEqual(['f11', 'f12', 'f13', 'f14']);
});

test('an album whose last photo finishes first still arrives in the order it was picked', async () => {
  const { chatId, ea } = await setup();
  const puts = holdPuts();
  const groupId = crypto.randomUUID();
  for (const n of [21, 22, 23]) await send(ea, chatId, n, groupId);
  await puts.until(() => puts.held.size === 3);
  puts.release(23);
  puts.release(22);
  await Bun.sleep(300);
  expect(await bodies(chatId)).toEqual([]);   // загруженные ждут первого
  puts.release(21);
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l.length === 3 && l.every((m) => m.status === 'sent'), 5000);
  expect(await bodies(chatId)).toEqual(['f21', 'f22', 'f23']);
  const groups = await sql`select distinct group_id from messages where chat_id = ${chatId}`;
  expect(groups.length).toBe(1);
});

test('text never waits for files; a loaded file waits only for files queued before it', async () => {
  const { chatId, ea } = await setup();
  const puts = holdPuts();
  await send(ea, chatId, 31);
  await send(ea, chatId, 32);
  await ea.call({ type: 'sendMessage', chatId, body: 'текст' });
  await puts.until(() => puts.held.size === 2);
  puts.release(32);
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l.some((m) => m.body === 'текст' && m.status === 'sent'), 5000);
  await Bun.sleep(200);
  expect(await bodies(chatId)).toEqual(['текст']);   // f32 загружен, но ждёт f31
  puts.release(31);
  await feed.until((l) => l.length === 3 && l.every((m) => m.status === 'sent'), 5000);
  expect(await bodies(chatId)).toEqual(['текст', 'f31', 'f32']);
});

test('discarding the first of the files lets the ones after it go', async () => {
  const { chatId, ea } = await setup();
  const puts = holdPuts();
  const { clientId } = await send(ea, chatId, 41) as { clientId: string };
  await send(ea, chatId, 42);
  await puts.until(() => puts.held.size === 2);
  puts.release(42);
  await Bun.sleep(200);
  expect(await bodies(chatId)).toEqual([]);
  await ea.call({ type: 'discard', clientId });
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l.length === 1 && l[0].status === 'sent', 5000);
  expect(await bodies(chatId)).toEqual(['f42']);
  expect(puts.held.has(41)).toBe(false);   // прерван отменой
});
