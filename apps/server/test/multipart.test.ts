import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { sql } from '../src/db';
import { setMultipart, sweepPendingUploads } from '../src/domain/files';
import { createMultipart, listMultipart } from '../src/domain/s3multipart';
import { resetDb, uploadIntent } from './helpers';

// Большой файл частями (S3 multipart): ссылки на части, докачка после обрыва, сборка при confirm, отмена и уборка.
const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
const MB = 1024 * 1024;
afterAll(() => server.stop(true));
beforeEach(async () => { await resetDb(); setMultipart(5 * MB, 5 * MB); });   // части по 5 МБ — минимум S3
afterEach(() => setMultipart(32 * MB, null));
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const as = (t: string) => ({ cookie: `relay_session=${t}` });
const conf = () => ({ endpoint: process.env.S3_ENDPOINT!, bucket: process.env.S3_BUCKET!, region: 'us-east-1', accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! });

/** 11 МБ с разными байтами в каждой части: сборка в неправильном порядке была бы видна. */
const file = () => { const b = new Uint8Array(11 * MB); for (let i = 0; i < b.length; i += 4096) b[i] = (i / MB) | 0; return b; };
const slice = (b: Uint8Array, n: number) => b.subarray((n - 1) * 5 * MB, Math.min(n * 5 * MB, b.length));
const partUrls = (token: string, id: string, parts: unknown) =>
  fetch(`${base}/uploads/${id}/parts`, { method: 'POST', headers: { ...as(token), 'content-type': 'application/json' }, body: JSON.stringify({ parts }) });
const putPart = async (token: string, id: string, body: Uint8Array, n: number) => {
  const { urls } = await (await partUrls(token, id, [n])).json() as { urls: Record<number, string> };
  const r = await fetch(urls[n], { method: 'PUT', body: slice(body, n) });
  expect(r.status).toBe(200);
};
const confirm = (token: string, id: string) => fetch(`${base}/uploads/${id}/confirm`, { method: 'POST', headers: as(token) });
const status = async (token: string, id: string) => (await (await fetch(`${base}/uploads/${id}/parts`, { headers: as(token) })).json()) as { partSize: number; parts: number; done: number[] };

test('start: a big file gets a multipart upload instead of a single PUT; a small one keeps the PUT', async () => {
  const a = await login('Анна');
  const res = await (await uploadIntent(base, a.token, { name: 'film.mp4', mime: 'video/mp4', size: 11 * MB })).json() as Record<string, unknown>;
  expect(res.url).toBeUndefined();
  expect(res.multipart).toEqual({ partSize: 5 * MB, parts: 3 });
  const [row] = await sql`select status, upload_id from attachments where id = ${res.id as string}`;
  expect(row.status).toBe('pending');
  expect(row.upload_id).toBeTruthy();
  expect((await listMultipart(conf())).some((u) => u.key === res.id && u.uploadId === row.upload_id)).toBe(true);
  const small = await (await uploadIntent(base, a.token, { name: 'a.txt', mime: 'text/plain', size: 5 * MB - 1 })).json() as Record<string, unknown>;
  expect(typeof small.url).toBe('string');
  expect(small.multipart).toBeUndefined();
});

test('parts: signed PUT per part number; bad numbers and strangers are refused', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const { id } = await (await uploadIntent(base, a.token, { name: 'film.mp4', mime: 'video/mp4', size: 11 * MB })).json() as { id: string };
  const r = await (await partUrls(a.token, id, [1, 3])).json() as { urls: Record<string, string>; expiresIn: number };
  expect(Object.keys(r.urls).sort()).toEqual(['1', '3']);
  const u = new URL(r.urls[3]);
  expect(u.pathname.endsWith('/' + id)).toBe(true);
  expect([u.searchParams.get('partNumber'), u.searchParams.get('X-Amz-Expires')]).toEqual(['3', String(r.expiresIn)]);
  for (const bad of [[0], [4], [1.5], [], 'x', Array.from({ length: 65 }, () => 1)]) expect((await partUrls(a.token, id, bad)).status).toBe(400);
  expect((await partUrls(b.token, id, [1])).status).toBe(404);
  // у маленькой загрузки частей нет
  const { id: small } = await (await uploadIntent(base, a.token, { name: 'a.txt', mime: 'text/plain', size: 10 })).json() as { id: string };
  expect((await partUrls(a.token, small, [1])).status).toBe(404);
});

test('resume: confirm with missing parts says incomplete; status lists what arrived; the rest completes the object', async () => {
  const a = await login('Анна');
  const body = file();
  const { id } = await (await uploadIntent(base, a.token, { name: 'film.mp4', mime: 'video/mp4', size: body.length })).json() as { id: string };
  await putPart(a.token, id, body, 3);
  await putPart(a.token, id, body, 1);
  const early = await confirm(a.token, id);
  expect([early.status, (await early.json() as { code: string }).code]).toEqual([409, 'upload_incomplete']);
  expect(await status(a.token, id)).toEqual({ partSize: 5 * MB, parts: 3, done: [1, 3] });
  // обрыв посреди части: её перегружают по новой ссылке — перезапись, не дубль
  await putPart(a.token, id, body, 1);
  await putPart(a.token, id, body, 2);
  expect((await status(a.token, id)).done).toEqual([1, 2, 3]);
  const ok = await confirm(a.token, id);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ id, size: body.length, mime: 'video/mp4' });
  const [row] = await sql`select status, upload_id from attachments where id = ${id}`;
  expect([row.status, row.upload_id]).toEqual(['ready', null]);
  const got = new Uint8Array(await (await fetch(`${base}/files/${id}`, { headers: as(a.token) })).arrayBuffer());
  expect(got.length).toBe(body.length);
  expect(Bun.hash(got)).toBe(Bun.hash(body));
  // повторный confirm (ответ потерялся) — то же вложение
  expect((await confirm(a.token, id)).status).toBe(200);
});

test('a part of the wrong size does not count as uploaded', async () => {
  const a = await login('Анна');
  const body = file();
  const { id } = await (await uploadIntent(base, a.token, { name: 'film.mp4', mime: 'video/mp4', size: body.length })).json() as { id: string };
  const { urls } = await (await partUrls(a.token, id, [1, 2, 3])).json() as { urls: Record<number, string> };
  await fetch(urls[1], { method: 'PUT', body: slice(body, 1) });
  await fetch(urls[2], { method: 'PUT', body: slice(body, 2).subarray(1) });   // на байт короче
  await fetch(urls[3], { method: 'PUT', body: slice(body, 3) });
  expect((await status(a.token, id)).done).toEqual([1, 3]);
  expect((await confirm(a.token, id)).status).toBe(409);
});

test('abort: the owner deletes the pending upload — parts and row go at once; a ready file is not touched', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const body = file();
  const { id } = await (await uploadIntent(base, a.token, { name: 'film.mp4', mime: 'video/mp4', size: body.length })).json() as { id: string };
  await putPart(a.token, id, body, 1);
  expect((await fetch(`${base}/uploads/${id}`, { method: 'DELETE', headers: as(b.token) })).status).toBe(204);   // чужое — молча ничего
  expect((await sql`select 1 from attachments where id = ${id}`).length).toBe(1);
  expect((await fetch(`${base}/uploads/${id}`, { method: 'DELETE', headers: as(a.token) })).status).toBe(204);
  expect((await sql`select 1 from attachments where id = ${id}`).length).toBe(0);
  expect((await listMultipart(conf())).some((u) => u.key === id)).toBe(false);
  expect((await partUrls(a.token, id, [2])).status).toBe(404);
});

test('sweep: stale multipart uploads are aborted with their rows, and orphans without a row too', async () => {
  const a = await login('Анна');
  const { id } = await (await uploadIntent(base, a.token, { name: 'film.mp4', mime: 'video/mp4', size: 11 * MB })).json() as { id: string };
  const orphan = crypto.randomUUID();
  await createMultipart(conf(), orphan, 'video/mp4');
  await sql`update attachments set created_at = now() - interval '2 days' where id = ${id}`;
  // свежие (сутки не прошли) не трогаем
  expect(await sweepPendingUploads()).toBe(1);
  let left = await listMultipart(conf());
  expect(left.some((u) => u.key === id)).toBe(false);
  expect(left.some((u) => u.key === orphan)).toBe(true);
  await Bun.sleep(1100);
  await sweepPendingUploads(1000);
  left = await listMultipart(conf());
  expect(left.some((u) => u.key === orphan)).toBe(false);
});
