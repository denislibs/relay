import { sql } from '../../../apps/server/src/db';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

// Загрузка вложения: ссылка у нашего сервера → PUT прямо в хранилище → подтверждение. Подписанная ссылка нигде не остаётся.
const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
const realFetch = globalThis.fetch;
beforeEach(resetDb);
afterEach(async () => { globalThis.fetch = realFetch; for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const isPut = (input: unknown, init?: RequestInit) => init?.method === 'PUT' && String(input).includes('X-Amz-Signature');

/** Подменить PUT в хранилище: f получает исходный запрос и решает, что ответить. */
function interceptPut(f: (input: string, init: RequestInit) => Promise<Response>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isPut(input, init)) { calls.push(String(input)); return f(String(input), init!); }
    return realFetch(input, init);
  }) as typeof fetch;
  return { calls };
}

async function setup() {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  return { a, b, chatId, ea };
}
const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])], { type: 'image/png' });

test('the file goes straight to the storage; the message and the local store keep only the attachment id', async () => {
  const { chatId, ea } = await setup();
  const seen = interceptPut((url, init) => realFetch(url, init));
  await ea.call({ type: 'sendFile', chatId, body: '', file: png(), name: 'p.png', mime: 'image/png', w: 4, h: 2, thumb: null });
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  const [m] = await feed.until((l) => l[0]?.status === 'sent');
  const id = (m.attachment as { id: string }).id;
  expect(seen.calls).toHaveLength(1);
  expect(new URL(seen.calls[0]).pathname.endsWith('/' + id)).toBe(true);
  expect(JSON.stringify(m)).not.toContain('X-Amz');
  const [row] = await sql`select status, size from attachments where id = ${id}`;
  expect([row.status, Number(row.size)]).toEqual(['ready', 8]);
  const [msg] = await sql`select attachment from messages where chat_id = ${chatId}`;
  expect(JSON.stringify(msg.attachment)).not.toContain('X-Amz');
});

test('the storage refuses (expired link) → the engine retries with a fresh link and the message goes out', async () => {
  const { chatId, ea } = await setup();
  let n = 0;
  const seen = interceptPut((url, init) => (++n === 1 ? Promise.resolve(new Response('expired', { status: 403 })) : realFetch(url, init)));
  await ea.call({ type: 'sendFile', chatId, body: 'снова', file: png(), name: 'p.png', mime: 'image/png', w: 4, h: 2, thumb: null });
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l[0]?.status === 'sent', 5000);
  expect(seen.calls).toHaveLength(2);
  expect(seen.calls[0]).not.toBe(seen.calls[1]);   // новая запись — новая ссылка
  expect((await sql`select body from messages where chat_id = ${chatId}`).map((r: { body: string }) => r.body)).toEqual(['снова']);
});

test('the storage is unreachable → the message waits; it goes out once the storage answers again', async () => {
  const { chatId, ea } = await setup();
  let down = true;
  interceptPut((url, init) => (down ? Promise.reject(new TypeError('Failed to fetch')) : realFetch(url, init)));
  await ea.call({ type: 'sendFile', chatId, body: '', file: png(), name: 'p.png', mime: 'image/png', w: 4, h: 2, thumb: null });
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l[0]?.status === 'pending');
  await Bun.sleep(100);
  expect((await feed.until((l) => l.length === 1))[0].status).toBe('pending');
  down = false;
  ea.disconnect();
  ea.connect();   // переподключение запускает очередь
  await feed.until((l) => l[0]?.status === 'sent', 5000);
});

test('a size that does not match the promise is refused by the server → the message fails, nothing is sent', async () => {
  const { chatId, ea } = await setup();
  interceptPut((url, init) => realFetch(url, { ...init, body: new Uint8Array(100) }));   // кладём не те байты
  await ea.call({ type: 'sendFile', chatId, body: '', file: png(), name: 'p.png', mime: 'image/png', w: 4, h: 2, thumb: null });
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  const [m] = await feed.until((l) => l[0]?.status === 'failed');
  expect(m.error).toBe('upload_mismatch');
  expect((await sql`select count(*)::int as n from messages where chat_id = ${chatId}`)[0].n).toBe(0);
});

test('a slow upload does not hold back text; discarding the unsent file aborts it and nothing is sent', async () => {
  const { chatId, ea } = await setup();
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  // PUT висит, пока его не прервут: как видео на 500 МБ на медленной сети
  interceptPut((_url, init) => new Promise((resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    void held.then(() => resolve(new Response(null, { status: 500 })));
  }));
  const { clientId } = await ea.call({ type: 'sendFile', chatId, body: '', file: png(), name: 'p.png', mime: 'image/png', w: 4, h: 2, thumb: null }) as { clientId: string };
  await ea.call({ type: 'sendMessage', chatId, body: 'текст не ждёт' });
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l.some((m) => m.body === 'текст не ждёт' && m.status === 'sent'), 5000);
  expect((await feed.until((l) => l.length === 2)).find((m) => m.key === clientId)?.status).toBe('pending');
  await ea.call({ type: 'discard', clientId });
  await feed.until((l) => l.length === 1 && l[0].body === 'текст не ждёт');
  release();
  await Bun.sleep(200);
  expect((await sql`select body from messages where chat_id = ${chatId}`).map((r: { body: string }) => r.body)).toEqual(['текст не ждёт']);
});

test('a file over the 2 GB limit is refused before it is queued', async () => {
  const { chatId, ea } = await setup();
  const huge = { size: 2 * 1024 ** 3 + 1, type: 'video/mp4' } as Blob;   // размер — всё, что движок смотрит до очереди
  await expect(ea.call({ type: 'sendFile', chatId, body: '', file: huge, name: 'big.mp4', mime: 'video/mp4', thumb: null })).rejects.toThrow();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await Bun.sleep(100);
  expect((await feed.until(() => true)).length).toBe(0);
});
