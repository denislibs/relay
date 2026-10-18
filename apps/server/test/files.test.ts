import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { sql } from '../src/db';
import { s3, setDownloadTtl, sweepPendingUploads } from '../src/domain/files';
import { resetDb, uploadFile, uploadIntent } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);
afterEach(() => setDownloadTtl(600));
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const as = (t: string) => ({ cookie: `relay_session=${t}` });
const chatOf = async (a: { userId: number; token: string }, b: { userId: number }) =>
  ((await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number }).id;
const confirm = (token: string, id: string) => fetch(`${base}/uploads/${id}/confirm`, { method: 'POST', headers: as(token) });
/** /files/:id без перехода по редиректу: проверяем, куда сервер отправляет. */
const fileRedirect = (token: string, id: string, qs = '') => fetch(`${base}/files/${id}${qs}`, { headers: as(token), redirect: 'manual' });

test('upload a photo, send it, members can download it, strangers cannot; media list', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Чужой');
  const chatId = await chatOf(a, b);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const up = await uploadFile(base, a.token, { name: 'cat.png', mime: 'image/png', w: 800, h: 600 }, png) as { id: string };
  expect(up).toMatchObject({ kind: 'photo', w: 800, h: 600, size: png.length, name: 'cat.png' });

  // чужое вложение отправить нельзя
  const { sendMessage } = await import('../src/domain/messages');
  await expect(sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body: '', attachment: { id: up.id } })).rejects.toMatchObject({ code: 'not_found' });
  const { message } = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'котик', attachment: { id: up.id, thumb: 'data:image/jpeg;base64,AAAA' } });
  expect(message).toMatchObject({ kind: 'photo', attachment: { id: up.id, w: 800, h: 600, thumb: 'data:image/jpeg;base64,AAAA' } });
  // в сообщении только id и метаданные, никаких ссылок на хранилище
  expect(JSON.stringify(message)).not.toContain('X-Amz');

  const asB = await fetch(`${base}/files/${up.id}`, { headers: as(b.token) });
  expect(asB.status).toBe(200);
  expect(asB.headers.get('content-type')).toBe('image/png');
  expect(new Uint8Array(await asB.arrayBuffer())).toEqual(png);
  expect((await fetch(`${base}/files/${up.id}`, { headers: as(c.token) })).status).toBe(404);
  const dl = await fetch(`${base}/files/${up.id}?download=1`, { headers: as(a.token) });
  expect(dl.headers.get('content-disposition')).toContain('attachment');
  expect(dl.headers.get('content-disposition')).toContain("filename*=UTF-8''cat.png");

  const media = await (await fetch(`${base}/chats/${chatId}/media?kind=photo`, { headers: as(b.token) })).json() as { messages: { id: number }[] };
  expect(media.messages.map((m) => m.id)).toEqual([message.id]);
  const doc = await uploadFile(base, a.token, { name: 'report.pdf', mime: 'application/pdf' }, 'pdf');
  expect(doc.kind).toBe('file');
});

test('intent: a pending row and a short signed PUT keyed by the attachment id; size and mime limits', async () => {
  const a = await login('Анна');
  const res = await uploadIntent(base, a.token, { name: 'cat.png', mime: 'image/png', size: 10, w: 2, h: 2 });
  expect(res.status).toBe(200);
  const { id, url, mime, expiresIn } = await res.json() as { id: string; url: string; mime: string; expiresIn: number };
  expect(mime).toBe('image/png');
  expect(expiresIn).toBeLessThanOrEqual(15 * 60);
  const u = new URL(url);
  expect(u.pathname.endsWith('/' + id)).toBe(true);
  expect(u.searchParams.get('X-Amz-Expires')).toBe(String(expiresIn));
  const [row] = await sql`select status, size from attachments where id = ${id}`;
  expect([row.status, Number(row.size)]).toEqual(['pending', 10]);

  expect((await uploadIntent(base, a.token, { name: 'big.bin', mime: 'application/octet-stream', size: 50 * 1024 * 1024 + 1 })).status).toBe(400);
  expect((await uploadIntent(base, a.token, { name: 'zero.bin', mime: 'application/octet-stream', size: 0 })).status).toBe(400);
  expect((await uploadIntent(base, a.token, { name: 'x', mime: 'text/plain' })).status).toBe(400);
  // непонятный тип — octet-stream, и класть объект надо именно с ним
  expect((await (await uploadIntent(base, a.token, { name: 'x', mime: 'not a mime', size: 1 })).json() as { mime: string }).mime).toBe('application/octet-stream');
  expect((await fetch(`${base}/uploads`, { method: 'POST', body: '{}' })).status).toBe(401);
});

test('a pending attachment cannot be sent or downloaded; confirm without the object says missing', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await chatOf(a, b);
  const { id } = await (await uploadIntent(base, a.token, { name: 'a.txt', mime: 'text/plain', size: 3 })).json() as { id: string };
  const { sendMessage } = await import('../src/domain/messages');
  await expect(sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: '', attachment: { id } })).rejects.toMatchObject({ code: 'upload_pending' });
  const r = await confirm(a.token, id);
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ code: 'upload_missing' });
  expect((await fileRedirect(a.token, id)).status).toBe(404);
});

test('a stranger cannot confirm someone else\'s upload, nor download it', async () => {
  const a = await login('Анна'), c = await login('Чужой');
  const res = await (await uploadIntent(base, a.token, { name: 'a.txt', mime: 'text/plain', size: 3 })).json() as { id: string; url: string };
  await fetch(res.url, { method: 'PUT', body: 'abc', headers: { 'content-type': 'text/plain' } });
  expect((await confirm(c.token, res.id)).status).toBe(404);
  expect((await sql`select status from attachments where id = ${res.id}`)[0].status).toBe('pending');
  expect((await confirm(a.token, res.id)).status).toBe(200);
  expect((await confirm(a.token, res.id)).status).toBe(200);   // повтор — то же вложение
  expect((await fileRedirect(c.token, res.id)).status).toBe(404);
  expect((await fileRedirect(a.token, res.id)).status).toBe(302);
});

test('a size or type that differs from the promised one is rejected and the object removed', async () => {
  const a = await login('Анна');
  // обещал 3 байта, положил 20
  const big = await (await uploadIntent(base, a.token, { name: 'a.txt', mime: 'text/plain', size: 3 })).json() as { id: string; url: string };
  expect((await fetch(big.url, { method: 'PUT', body: 'x'.repeat(20), headers: { 'content-type': 'text/plain' } })).ok).toBe(true);
  const r = await confirm(a.token, big.id);
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ code: 'upload_mismatch' });
  expect(await s3().file(big.id).exists()).toBe(false);
  expect((await sql`select status from attachments where id = ${big.id}`)[0].status).toBe('pending');

  // обещал картинку, положил HTML
  const html = await (await uploadIntent(base, a.token, { name: 'p.png', mime: 'image/png', size: 25, w: 1, h: 1 })).json() as { id: string; url: string };
  await fetch(html.url, { method: 'PUT', body: '<script>alert(1)</script>', headers: { 'content-type': 'text/html' } });
  expect((await confirm(a.token, html.id)).status).toBe(400);
});

test('download: 302 to a short signed GET; type and disposition are forced by the signature', async () => {
  const a = await login('Анна');
  const img = await uploadFile(base, a.token, { name: 'p.png', mime: 'image/png', w: 2, h: 2 }, new Uint8Array([137, 80])) as { id: string };
  const r = await fileRedirect(a.token, img.id);
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get('location')!);
  expect(Number(loc.searchParams.get('X-Amz-Expires'))).toBeGreaterThanOrEqual(5 * 60);
  expect(Number(loc.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(15 * 60);
  expect(loc.searchParams.get('response-content-type')).toBe('image/png');
  expect(r.headers.get('cache-control')).toContain('private');
  const head = await fetch(`${base}/files/${img.id}`, { method: 'HEAD', headers: as(a.token), redirect: 'manual' });
  expect(head.status).toBe(302);

  // HTML, SVG и прочее активное — никогда не inline
  for (const [mime, name] of [['text/html', 'x.html'], ['image/svg+xml', 'x.svg'], ['application/xhtml+xml', 'x.xhtml'], ['application/pdf', 'x.pdf']]) {
    const up = await uploadFile(base, a.token, { name, mime }, '<script>alert(1)</script>') as { id: string };
    const res = await fetch(`${base}/files/${up.id}`, { headers: as(a.token) });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toStartWith('attachment');
  }
  const res = await fetch(`${base}/files/${img.id}`, { headers: as(a.token) });
  expect(res.headers.get('content-type')).toBe('image/png');
  expect(res.headers.get('content-disposition')).toStartWith('inline');
});

test('an expired signed link is refused by the storage; /files/:id hands out a fresh one', async () => {
  const a = await login('Анна');
  const up = await uploadFile(base, a.token, { name: 'a.txt', mime: 'text/plain' }, 'abc') as { id: string };
  setDownloadTtl(1);
  const loc = (await fileRedirect(a.token, up.id)).headers.get('location')!;
  expect((await fetch(loc)).status).toBe(200);
  await Bun.sleep(2100);
  expect((await fetch(loc)).status).toBe(403);
  setDownloadTtl(600);
  const fresh = await fetch(`${base}/files/${up.id}`, { headers: as(a.token) });
  expect(fresh.status).toBe(200);
  expect(await fresh.text()).toBe('abc');
});

test('abandoned pending uploads are swept with their objects', async () => {
  const a = await login('Анна');
  const p = await (await uploadIntent(base, a.token, { name: 'a.txt', mime: 'text/plain', size: 3 })).json() as { id: string; url: string };
  await fetch(p.url, { method: 'PUT', body: 'abc', headers: { 'content-type': 'text/plain' } });
  const ready = await uploadFile(base, a.token, { name: 'b.txt', mime: 'text/plain' }, 'def') as { id: string };
  await sql`update attachments set created_at = now() - interval '2 days'`;
  expect(await sweepPendingUploads()).toBe(1);
  expect(await s3().file(p.id).exists()).toBe(false);
  expect((await sql`select id from attachments`).map((r) => r.id)).toEqual([ready.id]);
  expect(await s3().file(ready.id).exists()).toBe(true);
});

test('migrateFiles copies files from the old volume into the bucket, once; missing files are reported', async () => {
  const { migrateFiles } = await import('../src/migrateFiles');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync('/tmp/relay-files-');
  const a = await login('Анна');
  const ids = (await sql`insert into attachments (owner_id, mime, name, size) values (${a.userId}, 'image/png', 'old.png', 4), (${a.userId}, 'text/plain', 'gone.txt', 2) returning id`).map((r) => r.id as string);
  writeFileSync(`${dir}/${ids[0]}`, new Uint8Array([1, 2, 3, 4]));
  expect(await migrateFiles({ dir, dryRun: true })).toMatchObject({ copied: 1, skipped: 0, missing: [ids[1]] });
  expect(await s3().file(ids[0]).exists()).toBe(false);
  expect(await migrateFiles({ dir })).toMatchObject({ copied: 1, skipped: 0, missing: [ids[1]] });
  expect(await migrateFiles({ dir })).toMatchObject({ copied: 0, skipped: 1 });
  const st = await s3().file(ids[0]).stat();
  expect([st.size, st.type]).toEqual([4, 'image/png']);
  // старое вложение (status ready по умолчанию) скачивается через подписанную ссылку
  const res = await fetch(`${base}/files/${ids[0]}`, { headers: as(a.token) });
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
});
