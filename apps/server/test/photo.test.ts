import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attachment, ServerFrame, Update } from '@relay/protocol';
import { createServer } from '../src/http';
import { startRealtime } from '../src/realtime';
import { sql } from '../src/db';
import '../src/jobs/kinds';
import { inputOf, probe, videoFormat } from '../src/jobs/video';
import { backfillPhotos, PHOTO_MEDIUM_SIDE, PHOTO_PREVIEW_SIDE } from '../src/jobs/photo';
import { SLOW_KINDS } from '../src/jobs/kinds';
import { claim, enqueue } from '../src/jobs/queue';
import { drainJobs } from '../src/jobs/worker';
import { journalOf, nextFrame, opened, resetDb, uploadFile } from './helpers';

const server = createServer({ port: 0 });
const stopRealtime = await startRealtime(server);   // живые кадры push сокетам — через шину уведомлений
const base = `http://localhost:${server.port}`;
const dir = await mkdtemp(join(tmpdir(), 'relay-photo-test-'));
afterAll(async () => { await stopRealtime(); server.stop(true); await rm(dir, { recursive: true, force: true }); });
beforeEach(resetDb);
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const as = (t: string) => ({ cookie: `relay_session=${t}` });
const chatOf = async (a: { userId: number; token: string }, b: { userId: number }) =>
  ((await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number }).id;

/** Картинка из генератора ffmpeg; noise — чтобы файл был тяжёлым, как настоящее фото, а не сжатым в ноль. */
async function makeImage(name: string, w: number, h: number, src = `testsrc2=size=${w}x${h}:rate=1`): Promise<Uint8Array> {
  const out = join(dir, name);
  const p = Bun.spawn(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', src, ...(src.startsWith('testsrc2') ? ['-vf', 'noise=alls=30:allf=t'] : []), '-frames:v', '1', '-q:v', '2', out], { stderr: 'pipe' });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

test('a big photo gets a small preview (longer side 480) and a medium copy (800): messages, clients and /files/<id>/preview|medium learn about them', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await chatOf(a, b);
  const bytes = await makeImage('big.jpg', 1600, 1200);
  const up = await uploadFile(base, a.token, { name: 'big.jpg', mime: 'image/jpeg', kind: 'photo', w: 1600, h: 1200 }, bytes) as unknown as Attachment;
  expect(up.kind).toBe('photo');
  expect(up.preview).toBeUndefined();
  const { sendMessage } = await import('../src/domain/messages');
  const { message } = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: '', attachment: { id: up.id, thumb: 'data:image/jpeg;base64,AAAA' } });
  expect((await fetch(`${base}/files/${up.id}/preview`, { headers: as(b.token), redirect: 'manual' })).status).toBe(404);   // ещё нет — клиент берёт оригинал

  expect(await sql`select kind from jobs where kind = 'photo.process'`).toHaveLength(1);
  await drainJobs();

  const [row] = await sql`select processed, storage_key from attachments where id = ${up.id}`;
  expect(row).toEqual({ processed: 'done', storage_key: null });   // оригинал не трогаем
  const [v, md] = await sql`select name, mime, width, height, size from attachment_variants where attachment_id = ${up.id} order by name desc`;
  expect(v).toMatchObject({ name: 'preview', mime: 'image/webp', width: PHOTO_PREVIEW_SIDE, height: 360 });
  expect(Number(v.size)).toBeLessThan(bytes.length);
  expect(md).toMatchObject({ name: 'medium', mime: 'image/webp', width: PHOTO_MEDIUM_SIDE, height: 600 });
  expect(Number(md.size)).toBeLessThan(bytes.length);
  expect(Number(md.size)).toBeGreaterThan(Number(v.size));

  const [m] = await opened(await sql`select * from messages where id = ${message.id}`);
  const att = m.attachment as Attachment;
  expect(att.thumb).toBe('data:image/jpeg;base64,AAAA');
  expect(att.preview).toMatchObject({ name: 'preview', w: 480, h: 360 });
  expect(att.variants).toEqual([{ name: 'medium', w: 800, h: 600, size: Number(md.size) }]);
  const [u] = await journalOf(b.userId, 'attachmentUpdated');
  expect(u).toMatchObject({ chatId, id: message.id, attachment: { preview: { name: 'preview', w: 480, h: 360 }, variants: [{ name: 'medium', w: 800, h: 600 }] } });

  // копия — по тем же правам, что и оригинал, показывается inline как картинка
  const pv = await fetch(`${base}/files/${up.id}/preview`, { headers: as(b.token) });
  expect(pv.status).toBe(200);
  expect(pv.headers.get('content-type')).toBe('image/webp');
  await Bun.write(join(dir, 'preview.webp'), await pv.arrayBuffer());
  expect(await probe(join(dir, 'preview.webp'))).toMatchObject({ w: 480, h: 360 });
  const mv = await fetch(`${base}/files/${up.id}/medium`, { headers: as(b.token) });
  expect(mv.status).toBe(200);
  expect(mv.headers.get('content-type')).toBe('image/webp');
  await Bun.write(join(dir, 'medium.webp'), await mv.arrayBuffer());
  expect(await probe(join(dir, 'medium.webp'))).toMatchObject({ w: 800, h: 600 });
  const c = await login('Чужой');
  expect((await fetch(`${base}/files/${up.id}/preview`, { headers: as(c.token) })).status).toBe(404);
  expect((await fetch(`${base}/files/${up.id}/medium`, { headers: as(c.token) })).status).toBe(404);
  expect((await fetch(`${base}/files/${up.id}/original`, { headers: as(b.token) })).status).toBe(404);   // других имён нет

  // отправленное после обработки — сразу с копией
  const again = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: '', attachment: { id: up.id } });
  expect(again.message.attachment).toMatchObject({ preview: { name: 'preview', w: 480, h: 360 }, variants: [{ name: 'medium', w: 800, h: 600 }] });
}, 60_000);

test('a portrait photo keeps its aspect: the longer side (height) becomes 480 and 800', async () => {
  const a = await login('Анна');
  const bytes = await makeImage('tall.png', 900, 1600);
  const up = await uploadFile(base, a.token, { name: 'tall.png', mime: 'image/png', kind: 'photo', w: 900, h: 1600 }, bytes) as unknown as Attachment;
  await drainJobs();
  const [v] = await sql`select width, height from attachment_variants where attachment_id = ${up.id} and name = 'preview'`;
  expect(v).toEqual({ width: 270, height: 480 });
  const [m] = await sql`select width, height from attachment_variants where attachment_id = ${up.id} and name = 'medium'`;
  expect(m).toEqual({ width: 450, height: 800 });
}, 60_000);

test('an image sent as a file (no size, kind file) also gets a preview', async () => {
  const a = await login('Анна');
  const bytes = await makeImage('doc.jpg', 1200, 800);
  const up = await uploadFile(base, a.token, { name: 'doc.jpg', mime: 'image/jpeg' }, bytes) as unknown as Attachment;
  expect(up.kind).toBe('file');
  await drainJobs();
  const [v] = await sql`select width, height from attachment_variants where attachment_id = ${up.id} and name = 'preview'`;
  expect(v).toEqual({ width: 480, height: 320 });
  const [m] = await sql`select width, height from attachment_variants where attachment_id = ${up.id} and name = 'medium'`;
  expect(m).toEqual({ width: 800, height: 533 });
}, 60_000);

test('a mid-size light photo (up to 800 px, not heavy) gets only the preview: the original is already medium-sized', async () => {
  const a = await login('Анна');
  const bytes = await makeImage('mid.jpg', 640, 480, 'color=c=teal:s=640x480');
  expect(bytes.length).toBeLessThan(300 * 1024);
  const up = await uploadFile(base, a.token, { name: 'mid.jpg', mime: 'image/jpeg', kind: 'photo', w: 640, h: 480 }, bytes) as unknown as Attachment;
  await drainJobs();
  expect((await sql`select processed from attachments where id = ${up.id}`)[0].processed).toBe('done');
  expect((await sql`select name from attachment_variants where attachment_id = ${up.id} order by name`).map((r) => r.name)).toEqual(['preview']);
  expect((await fetch(`${base}/files/${up.id}/medium`, { headers: as(a.token), redirect: 'manual' })).status).toBe(404);   // клиент берёт оригинал
}, 60_000);

test('backfill: a photo processed before the medium copy gets it (redo), messages learn; done and queued ones are not redone', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await chatOf(a, b);
  const bytes = await makeImage('old.jpg', 1600, 1200);
  const up = await uploadFile(base, a.token, { name: 'old.jpg', mime: 'image/jpeg', kind: 'photo', w: 1600, h: 1200 }, bytes) as unknown as Attachment;
  const broken = await uploadFile(base, a.token, { name: 'broken.jpg', mime: 'image/jpeg', kind: 'photo', w: 1600, h: 1200 }, 'not a picture') as unknown as Attachment;
  const small = await uploadFile(base, a.token, { name: 'small.jpg', mime: 'image/jpeg', kind: 'photo', w: 320, h: 240 }, await makeImage('small2.jpg', 320, 240)) as unknown as Attachment;
  const { sendMessage } = await import('../src/domain/messages');
  const { message } = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: '', attachment: { id: up.id } });
  await drainJobs();
  // как до появления medium: копии нет, в сообщении только превью
  await sql`delete from attachment_variants where attachment_id = ${up.id} and name = 'medium'`;
  await sql`update messages set attachment = attachment - 'variants' where id = ${message.id}`;

  expect(await backfillPhotos()).toBe(1);   // битое (skipped) и маленькое (нечего делать) — не ставятся
  expect(await backfillPhotos()).toBe(1);   // повторный запуск: та же задача (dedupe), не вторая
  expect(await sql`select payload from jobs where kind = 'photo.process'`).toEqual([{ payload: { id: up.id, redo: true } }]);
  await drainJobs();

  expect((await sql`select processed from attachments where id = ${up.id}`)[0].processed).toBe('done');
  const vs = await sql`select name, width, height from attachment_variants where attachment_id = ${up.id} order by name`;
  expect(vs).toEqual([{ name: 'medium', width: 800, height: 600 }, { name: 'preview', width: 480, height: 360 }]);
  const [m] = await opened(await sql`select * from messages where id = ${message.id}`);
  expect(m.attachment).toMatchObject({ preview: { name: 'preview' }, variants: [{ name: 'medium', w: 800, h: 600 }] });
  const ups = await journalOf(b.userId, 'attachmentUpdated');
  expect(ups.at(-1)).toMatchObject({ id: message.id, attachment: { variants: [{ name: 'medium' }] } });
  expect(await backfillPhotos()).toBe(0);   // всё готово
  expect((await sql`select processed from attachments where id = ${broken.id}`)[0].processed).toBe('skipped');
  expect(await sql`select 1 from attachment_variants where attachment_id = ${small.id}`).toHaveLength(0);
}, 60_000);

test('a small photo needs nothing: no copy, the original is its own preview', async () => {
  const a = await login('Анна');
  const bytes = await makeImage('small.jpg', 320, 240);
  const up = await uploadFile(base, a.token, { name: 'small.jpg', mime: 'image/jpeg', kind: 'photo', w: 320, h: 240 }, bytes) as unknown as Attachment;
  await drainJobs();
  const [row] = await sql`select processed from attachments where id = ${up.id}`;
  expect(row.processed).toBe('done');
  expect(await sql`select 1 from attachment_variants where attachment_id = ${up.id}`).toHaveLength(0);
}, 60_000);

test('a picture ffmpeg cannot decode is skipped without retries, the original still downloads', async () => {
  const a = await login('Анна');
  const up = await uploadFile(base, a.token, { name: 'broken.jpg', mime: 'image/jpeg', kind: 'photo', w: 800, h: 600 }, 'definitely not a picture') as unknown as Attachment;
  await drainJobs();
  const [row] = await sql`select processed from attachments where id = ${up.id}`;
  expect(row.processed).toBe('skipped');
  expect(await sql`select 1 from jobs_dead`).toHaveLength(0);
  expect((await fetch(`${base}/files/${up.id}`, { headers: as(a.token), redirect: 'manual' })).status).toBe(302);
});

test('other files (pdf) are not queued for a preview', async () => {
  const a = await login('Анна');
  await uploadFile(base, a.token, { name: 'a.pdf', mime: 'application/pdf' }, '%PDF-1.4');
  expect(await sql`select 1 from jobs where kind = 'photo.process'`).toHaveLength(0);
});

/** JPEG с EXIF Orientation (как снимает телефон): сегмент APP1 сразу после SOI. 6 — повернуть на 90° по часовой. */
function withOrientation(jpeg: Uint8Array, o: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0];
  const data = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = data.length + 2;
  return new Uint8Array([...jpeg.slice(0, 2), 0xff, 0xe1, len >> 8, len & 255, ...data, ...jpeg.slice(2)]);
}

test('EXIF orientation 6 (phone held upright): the preview is upright, sides swapped', async () => {
  const a = await login('Анна');
  const bytes = withOrientation(await makeImage('rot.jpg', 1200, 600), 6);
  const up = await uploadFile(base, a.token, { name: 'rot.jpg', mime: 'image/jpeg', kind: 'photo', w: 600, h: 1200 }, bytes) as unknown as Attachment;
  await drainJobs();
  const [v] = await sql`select width, height from attachment_variants where attachment_id = ${up.id} and name = 'preview'`;
  expect(v).toEqual({ width: 240, height: 480 });
  // и сам файл копии — стоячий, без тега поворота
  const pv = await fetch(`${base}/files/${up.id}/preview`, { headers: as(a.token) });
  await Bun.write(join(dir, 'rot.webp'), await pv.arrayBuffer());
  expect(await probe(join(dir, 'rot.webp'))).toMatchObject({ w: 240, h: 480 });
}, 60_000);

test('a "picture" that is really a playlist (HLS / concat) is skipped and ffmpeg never goes to the network', async () => {
  let hits = 0;
  const bait = Bun.serve({ port: 0, fetch: () => { hits++; return new Response('x'); } });
  try {
    const a = await login('Анна');
    const url = `http://localhost:${bait.port}/x`;
    const hls = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\n${url}.ts\n#EXT-X-ENDLIST\n`;
    const concat = `ffconcat version 1.0\nfile '${url}.png'\n`;
    const ids: string[] = [];
    for (const [name, body] of [['a.png', hls], ['b.png', concat]] as const) {
      ids.push(((await uploadFile(base, a.token, { name, mime: 'image/png', kind: 'photo', w: 800, h: 600 }, body)) as unknown as Attachment).id);
    }
    const v = await uploadFile(base, a.token, { name: 'c.mp4', mime: 'video/mp4', kind: 'video', w: 640, h: 360, duration: 3 }, hls) as unknown as Attachment;
    await drainJobs();
    for (const id of [...ids, v.id]) expect((await sql`select processed from attachments where id = ${id}`)[0].processed).toBe('skipped');
    expect(hits).toBe(0);
  } finally { bait.stop(true); }
}, 60_000);

test('a decompression bomb (more than 50 Mpx) is skipped without decoding it', async () => {
  const a = await login('Анна');
  const bytes = await makeImage('huge.png', 10000, 6000, 'color=c=red:s=10000x6000');
  const up = await uploadFile(base, a.token, { name: 'huge.png', mime: 'image/png', kind: 'photo', w: 10000, h: 6000 }, bytes) as unknown as Attachment;
  await drainJobs();
  expect((await sql`select processed from attachments where id = ${up.id}`)[0].processed).toBe('skipped');
  expect(await sql`select 1 from attachment_variants where attachment_id = ${up.id}`).toHaveLength(0);
}, 60_000);

test('photo jobs run in their own small loop: the main loop does not take them', async () => {
  await enqueue(sql, 'photo.process', { id: crypto.randomUUID() });
  await enqueue(sql, 'test.other', {});
  expect((await claim(10, 300, { except: [...SLOW_KINDS.video, ...SLOW_KINDS.photo] })).map((j) => j.kind)).toEqual(['test.other']);
  expect((await claim(10, 300, { only: SLOW_KINDS.photo })).map((j) => j.kind)).toEqual(['photo.process']);
});

test('ffmpeg input is pinned: only the local file protocol and the declared format (no guessing by content)', () => {
  expect(inputOf('/tmp/x', 'png_pipe')).toEqual(['-protocol_whitelist', 'file', '-f', 'png_pipe', '-i', '/tmp/x']);
  expect(videoFormat('video/mp4')).toBe('mov');
  expect(videoFormat('video/quicktime')).toBe('mov');
  expect(videoFormat('video/webm')).toBe('matroska');
});

test('attachmentUpdated reaches online clients with the sealed text of the attachment (name, thumb), not the bare jsonb row', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const { id: chatId } = (await (await fetch(`${base}/chats`, { method: 'POST', headers: { ...as(a.token), 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Фото', memberIds: [b.userId] }) })).json()) as { id: number };
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?token=${b.token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ op: 'hello', lastSeq: 0, since: 0 }));
  await nextFrame(ws, (f) => f.op === 'hello');
  const bytes = await makeImage('live.jpg', 1600, 1200);
  const up = await uploadFile(base, a.token, { name: 'live.jpg', mime: 'image/jpeg', kind: 'photo', w: 1600, h: 1200 }, bytes) as unknown as Attachment;
  const { sendMessage } = await import('../src/domain/messages');
  // слушатели — до действия: кадр может прийти раньше, чем вернётся вызов
  const sent = nextFrame(ws, (f) => f.op === 'push' && f.items.some((i) => i.update.type === 'newMessage'), 10_000);
  const pushed = nextFrame(ws, (f) => f.op === 'push' && f.items.some((i) => i.update.type === 'attachmentUpdated'), 10_000);
  const { message } = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: '', attachment: { id: up.id, thumb: 'data:image/jpeg;base64,AAAA' } });
  await sent;
  await drainJobs();
  const f = (await pushed) as Extract<ServerFrame, { op: 'push' }>;
  const u = f.items.find((i) => i.update.type === 'attachmentUpdated')!.update as Extract<Update, { type: 'attachmentUpdated' }>;
  // живой кадр несёт событие как есть: имя и миниатюра из шифра — на месте, копии и размер — новые
  expect(u).toMatchObject({ chatId, id: message.id, attachment: { id: up.id, name: 'live.jpg', thumb: 'data:image/jpeg;base64,AAAA', size: bytes.length, preview: { name: 'preview', w: 480, h: 360 }, variants: [{ name: 'medium', w: 800, h: 600 }] } });
  // а в самой строке текст вложения по-прежнему только в шифре
  const [raw] = await sql`select attachment from messages where id = ${message.id}`;
  expect((raw.attachment as Record<string, unknown>).thumb).toBeUndefined();
  expect((raw.attachment as Record<string, unknown>).name).toBeUndefined();
  ws.close();
});
