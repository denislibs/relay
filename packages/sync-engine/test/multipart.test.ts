import { fromBase64, importFileKey, openFile } from '@relay/protocol';
import { sql } from '../../../apps/server/src/db';
import { setMultipart } from '../../../apps/server/src/domain/files';
import { listMultipart } from '../../../apps/server/src/domain/s3multipart';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Engine } from '../src/engine';
import { opened, resetDb, startTestServer, watchInto } from './helpers';

// Большой файл частями: 4 части параллельно, принятые — в outbox; обрыв и перезагрузка докачивают, отмена выбрасывает части.
const MB = 1024 * 1024;
const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
const realFetch = globalThis.fetch;
beforeEach(async () => { await resetDb(); setMultipart(5 * MB, 5 * MB); });
afterEach(async () => { globalThis.fetch = realFetch; setMultipart(32 * MB, null); for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const s3conf = () => ({ endpoint: process.env.S3_ENDPOINT!, bucket: process.env.S3_BUCKET!, region: 'us-east-1', accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! });

/** PUT частей в хранилище: f решает, что ответить (номер части — из ссылки). */
function interceptParts(f: (n: number, input: string, init: RequestInit) => Promise<Response>): { parts: number[] } {
  const parts: number[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PUT' && url.includes('partNumber=')) {
      const n = Number(new URL(url).searchParams.get('partNumber'));
      parts.push(n);
      return f(n, url, init);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return { parts };
}

async function setup() {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const cfg = srv.config(a);
  const ea = await open(cfg);
  ea.connect();
  await ea.whenIdle();
  return { a, chatId, ea, cfg };
}
/** 13 МБ: части 5 + 5 + 3; у каждого мегабайта свой байт — перепутанные части были бы видны. */
const film = () => { const b = new Uint8Array(13 * MB); for (let i = 0; i < b.length; i += 1024) b[i] = (i / MB) | 0; return new Blob([b], { type: 'video/mp4' }); };
const sendFilm = (ea: Engine, chatId: number, file = film()) =>
  ea.call({ type: 'sendFile', chatId, body: 'фильм', file, name: 'film.mp4', mime: 'video/mp4', thumb: null }) as Promise<{ clientId: string }>;
const download = async (id: string, token: string) => new Uint8Array(await (await realFetch(`${srv.base}/files/${id}`, { headers: { cookie: `relay_session=${token}` } })).arrayBuffer());

test('a big file goes in parts straight to the storage and arrives whole', async () => {
  const { a, chatId, ea } = await setup();
  const seen = interceptParts((_n, url, init) => realFetch(url, init));
  const file = film();
  await sendFilm(ea, chatId, file);
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  const [m] = await feed.until((l) => l[0]?.status === 'sent', 10_000);
  expect(seen.parts.sort()).toEqual([1, 2, 3]);
  const id = (m.attachment as { id: string }).id;
  // в хранилище — шифр; открыть его можно ключом из сообщения (как это делает клиент получателя)
  const sealed = await download(id, a.token);
  expect(new TextDecoder().decode(sealed.subarray(0, 4))).toBe('RLF1');
  const key = (m.attachment as { key: string }).key;
  const got = new Uint8Array(await (await openFile(new Blob([sealed]), await importFileKey(fromBase64(key)))).arrayBuffer());
  expect(got.length).toBe(file.size);
  expect(Bun.hash(got)).toBe(Bun.hash(new Uint8Array(await file.arrayBuffer())));
  expect((await sql`select upload_id from attachments where id = ${id}`)[0].upload_id).toBeNull();
});

test('the connection drops mid-way: finished parts stay in the outbox; after a reload only the rest is uploaded', async () => {
  const { chatId, ea, cfg } = await setup();
  // части 1 и 2 доходят, связь рвётся, пока идёт 3-я
  let ok = 0, cut!: () => void;
  const twoDone = new Promise<void>((r) => { cut = r; });
  const first = interceptParts(async (n, url, init) => {
    if (n === 3) { await twoDone; await Bun.sleep(50); throw new TypeError('Failed to fetch'); }
    const r = await realFetch(url, init);
    if (++ok === 2) cut();
    return r;
  });
  const { clientId } = await sendFilm(ea, chatId);
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  const outbox = () => (ea as unknown as { store: { outbox: Map<string, { upload?: { done: number[] } }> } }).store.outbox.get(clientId);
  for (let i = 0; i < 200 && (outbox()?.upload?.done.length ?? 0) < 2; i++) await Bun.sleep(20);
  expect(outbox()?.upload?.done).toEqual([1, 2]);
  expect((await feed.until((l) => l.length === 1))[0].status).toBe('pending');
  expect(first.parts).toContain(3);
  // кольцо уже показывает принятое: 10 МБ из 13
  expect((await feed.until((l) => (l[0]?.progress as number) > 0.7))[0].progress).toBeLessThan(0.98);

  await ea.close();
  engines.splice(engines.indexOf(ea), 1);
  const again = interceptParts((_n, url, init) => realFetch(url, init));
  const eb = await open(cfg);   // та же база: outbox и файл из IndexedDB
  eb.connect();
  const feed2 = watchInto(eb, { kind: 'messages', chatId, limit: 10 });
  await feed2.until((l) => l[0]?.status === 'sent', 10_000);
  expect(again.parts).toEqual([3]);
  expect((await opened(await sql`select * from messages where chat_id = ${chatId}`)).map((r: { body: string }) => r.body)).toEqual(['фильм']);
});

test('the storage blips while the socket stays up: the upload resumes by itself, finished parts are not sent again', async () => {
  const { chatId, ea } = await setup();
  let down = false, blipped = false;
  const accepted: number[] = [];
  interceptParts(async (n, url, init) => {
    if (n === 3 && !blipped) { blipped = down = true; setTimeout(() => { down = false; }, 300); }
    if (down) throw new TypeError('Failed to fetch');
    const r = await realFetch(url, init);
    accepted.push(n);
    return r;
  });
  await sendFilm(ea, chatId);
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l[0]?.status === 'sent', 10_000);
  // каждая часть принята ровно один раз: принятые до обрыва не грузятся заново
  expect(accepted.sort()).toEqual([1, 2, 3]);
});

test('a part the storage lost (confirm says incomplete) is uploaded again after checking with the server', async () => {
  const { chatId, ea } = await setup();
  let lied = false;
  const seen = interceptParts((n, url, init) => {
    if (n === 2 && !lied) { lied = true; return Promise.resolve(new Response(null, { status: 200 })); }   // «принято», а части нет
    return realFetch(url, init);
  });
  await sendFilm(ea, chatId);
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l[0]?.status === 'sent', 10_000);
  expect(seen.parts.filter((n) => n === 2)).toHaveLength(2);
  expect(seen.parts.filter((n) => n !== 2).sort()).toEqual([1, 3]);
});

test('an expired part link is replaced with a fresh one', async () => {
  const { chatId, ea } = await setup();
  let expired = false;
  const seen = interceptParts((n, url, init) => {
    if (n === 1 && !expired) { expired = true; return Promise.resolve(new Response('expired', { status: 403 })); }
    return realFetch(url, init);
  });
  await sendFilm(ea, chatId);
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l[0]?.status === 'sent', 10_000);
  expect(seen.parts.filter((n) => n === 1)).toHaveLength(2);
});

test('discarding the unsent file aborts the parts in flight and the upload on the server', async () => {
  const { chatId, ea } = await setup();
  interceptParts((n, url, init) => (n === 1 ? realFetch(url, init) : new Promise((_r, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })));
  const { clientId } = await sendFilm(ea, chatId);
  const [row] = await (async () => { for (;;) { const r = await sql`select id, upload_id from attachments where upload_id is not null`; if (r.length) return r; await Bun.sleep(10); } })();
  const outbox = () => (ea as unknown as { store: { outbox: Map<string, { upload?: { done: number[] } }> } }).store.outbox.get(clientId);
  for (let i = 0; i < 200 && !outbox()?.upload?.done.length; i++) await Bun.sleep(20);
  await ea.call({ type: 'discard', clientId });
  for (let i = 0; i < 100 && (await sql`select 1 from attachments where id = ${row.id}`).length; i++) await Bun.sleep(20);
  expect((await sql`select 1 from attachments where id = ${row.id}`).length).toBe(0);
  expect((await listMultipart(s3conf())).some((u) => u.uploadId === row.upload_id)).toBe(false);
  await Bun.sleep(100);
  expect((await sql`select count(*)::int as n from messages where chat_id = ${chatId}`)[0].n).toBe(0);
});

test('a small file keeps the single PUT', async () => {
  const { chatId, ea } = await setup();
  const seen = interceptParts((_n, url, init) => realFetch(url, init));
  await ea.call({ type: 'sendFile', chatId, body: '', file: new Blob([new Uint8Array(1000)], { type: 'application/pdf' }), name: 'a.pdf', mime: 'application/pdf', thumb: null });
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l[0]?.status === 'sent');
  expect(seen.parts).toEqual([]);
});
