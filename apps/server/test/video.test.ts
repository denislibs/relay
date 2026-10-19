import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attachment } from '@relay/protocol';
import { createServer } from '../src/http';
import { sql } from '../src/db';
import { s3 } from '../src/domain/files';
import '../src/jobs/kinds';
import { moovFirst, PREVIEW_MAX_BYTES, probe } from '../src/jobs/video';
import { claim, enqueue } from '../src/jobs/queue';
import { drainJobs } from '../src/jobs/worker';
import { resetDb, uploadFile } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
const dir = await mkdtemp(join(tmpdir(), 'relay-video-test-'));
afterAll(async () => { server.stop(true); await rm(dir, { recursive: true, force: true }); });
beforeEach(resetDb);
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const as = (t: string) => ({ cookie: `relay_session=${t}` });
const chatOf = async (a: { userId: number; token: string }, b: { userId: number }) =>
  ((await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number }).id;

/** Видео как из редактора: H.264/AAC, moov в конце (без +faststart). noise — чтобы битрейт был настоящим, а не сжатым в ноль. */
async function makeMp4(name: string, o: { w: number; h: number; seconds: number; kbit: number; faststart?: boolean }): Promise<Uint8Array> {
  const out = join(dir, name);
  const p = Bun.spawn(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${o.w}x${o.h}:rate=25:duration=${o.seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${o.seconds}`, '-vf', 'noise=alls=40:allf=t', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-b:v', `${o.kbit}k`, '-maxrate', `${o.kbit}k`, '-bufsize', `${o.kbit}k`, '-c:a', 'aac', ...(o.faststart ? ['-movflags', '+faststart'] : []), out], { stderr: 'pipe' });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

async function objectMoovFirst(key: string): Promise<boolean> {
  const path = join(dir, `${key}.check`);
  await Bun.write(path, s3().file(key));
  return moovFirst(path);
}

test('moov-at-end 1080p upload: faststart original, a ≤1 MB 360p preview and a 720p copy; messages and clients learn about them', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await chatOf(a, b);
  const bytes = await makeMp4('big.mp4', { w: 1920, h: 1080, seconds: 8, kbit: 6000 });
  const src = join(dir, 'big.mp4');
  expect(await moovFirst(src)).toBe(false);                     // как выгружает ffmpeg без +faststart
  const up = await uploadFile(base, a.token, { name: 'big.mp4', mime: 'video/mp4', kind: 'video', w: 1920, h: 1080, duration: 8 }, bytes) as unknown as Attachment;
  expect(up.kind).toBe('video');
  expect(up.preview).toBeUndefined();                           // до обработки — как раньше
  const { sendMessage } = await import('../src/domain/messages');
  const { message } = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: '', attachment: { id: up.id, thumb: 'data:image/jpeg;base64,AAAA', spoiler: true } });
  expect((await fetch(`${base}/files/${up.id}/preview`, { headers: as(b.token), redirect: 'manual' })).status).toBe(404);

  expect((await sql`select kind from jobs where kind = 'video.process'`)).toHaveLength(1);
  await drainJobs();

  const [row] = await sql`select * from attachments where id = ${up.id}`;
  expect(row.processed).toBe('done');
  expect(row.storage_key).toBe(`${up.id}.fs`);
  expect(await objectMoovFirst(row.storage_key)).toBe(true);    // оригинал теперь faststart
  const fs = await probe(join(dir, `${row.storage_key}.check`));
  expect(fs).toMatchObject({ codec: 'h264', audio: 'aac', w: 1920, h: 1080 });   // без перекодирования
  // старый объект удалится позже — по нему ещё могут доигрывать
  const [del] = await sql`select payload, run_at > now() + interval '1 hour' as later from jobs where kind = 'storage.delete'`;
  expect(del).toMatchObject({ payload: { key: up.id }, later: true });

  const [m] = await sql`select attachment from messages where id = ${message.id}`;
  const att = m.attachment as Attachment;
  expect(att.thumb).toBe('data:image/jpeg;base64,AAAA');
  expect(att.spoiler).toBe(true);
  expect(att.size).toBe(Number(row.size));
  expect(att.preview).toMatchObject({ name: 'preview', w: 640, h: 360 });
  expect(att.preview!.size).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
  expect(att.variants).toEqual([expect.objectContaining({ name: '720', w: 1280, h: 720 })]);
  // клиенты получают обновлённый снимок через журнал
  const [u] = await sql`select payload from updates where user_id = ${b.userId} and type = 'attachmentUpdated'`;
  expect(u.payload).toMatchObject({ chatId, id: message.id, attachment: { preview: { name: 'preview' } } });

  // копии отдаются по тем же правам, что и оригинал; preview — первые секунды без звука
  const pv = await fetch(`${base}/files/${up.id}/preview`, { headers: as(b.token) });
  expect(pv.status).toBe(200);
  expect(pv.headers.get('content-type')).toBe('video/mp4');
  await Bun.write(join(dir, 'preview.mp4'), await pv.arrayBuffer());
  const pp = await probe(join(dir, 'preview.mp4'));
  expect(pp).toMatchObject({ codec: 'h264', audio: null, w: 640, h: 360 });
  expect(pp!.duration).toBeLessThanOrEqual(4.1);
  expect(await moovFirst(join(dir, 'preview.mp4'))).toBe(true);
  expect((await fetch(`${base}/files/${up.id}/720`, { headers: as(b.token) })).status).toBe(200);
  const c = await login('Чужой');
  expect((await fetch(`${base}/files/${up.id}/preview`, { headers: as(c.token) })).status).toBe(404);
  // оригинал — уже перепакованный объект
  const orig = await fetch(`${base}/files/${up.id}`, { headers: as(b.token), redirect: 'manual' });
  expect(new URL(orig.headers.get('location')!).pathname).toEndWith(`/${up.id}.fs`);

  // отправленное после обработки сразу с копиями
  const again = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: '', attachment: { id: up.id } });
  expect(again.message.attachment).toMatchObject({ preview: { name: 'preview' }, variants: [{ name: '720' }] });
}, 120_000);

test('video jobs run in their own loop: the main loop (except) does not take them, the video loop (only) takes nothing else', async () => {
  await enqueue(sql, 'video.process', { id: crypto.randomUUID() });
  await enqueue(sql, 'test.other', {});
  expect((await claim(10, 300, { except: ['video.process'] })).map((j) => j.kind)).toEqual(['test.other']);
  expect((await claim(10, 300, { only: ['video.process'] })).map((j) => j.kind)).toEqual(['video.process']);
});

test('a small faststart H.264 video needs nothing: no copies, the original stays', async () => {
  const a = await login('Анна');
  const bytes = await makeMp4('small.mp4', { w: 320, h: 240, seconds: 2, kbit: 300, faststart: true });
  expect(bytes.length).toBeLessThan(PREVIEW_MAX_BYTES);
  const up = await uploadFile(base, a.token, { name: 'small.mp4', mime: 'video/mp4', kind: 'video', w: 320, h: 240, duration: 2 }, bytes) as unknown as Attachment;
  await drainJobs();
  const [row] = await sql`select processed, storage_key from attachments where id = ${up.id}`;
  expect(row).toEqual({ processed: 'done', storage_key: null });
  expect(await sql`select 1 from attachment_variants where attachment_id = ${up.id}`).toHaveLength(0);
}, 60_000);

test('a file ffmpeg cannot decode is skipped, and it still plays as uploaded', async () => {
  const a = await login('Анна');
  const up = await uploadFile(base, a.token, { name: 'broken.mp4', mime: 'video/mp4', kind: 'video', w: 640, h: 360, duration: 3 }, 'definitely not a video') as unknown as Attachment;
  await drainJobs();
  const [row] = await sql`select processed, storage_key from attachments where id = ${up.id}`;
  expect(row).toEqual({ processed: 'skipped', storage_key: null });
  expect(await sql`select 1 from jobs_dead`).toHaveLength(0);
  expect((await fetch(`${base}/files/${up.id}`, { headers: as(a.token), redirect: 'manual' })).status).toBe(302);
});
