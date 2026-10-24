import { afterAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { importFileKey, newFileKey, openFile, sealFile, variantKey, type Attachment } from '@relay/protocol';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { sendMessage } from '../src/domain/messages';
import { getHistory } from '../src/domain/chats';
import { s3 } from '../src/domain/files';
import '../src/jobs/kinds';
import { drainJobs } from '../src/jobs/worker';
import { resetFileKeyCache } from '../src/crypto/fileKeys';
import { resetDb } from './helpers';

setDefaultTimeout(60_000);
const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(async () => { await resetDb(); resetFileKeyCache(); });

const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const as = (t: string) => ({ cookie: `relay_session=${t}`, 'content-type': 'application/json' });
const chatOf = async (a: { userId: number; token: string }, b: { userId: number }) =>
  ((await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number }).id;

/** Клиент: ключ файла, шифр, заявка с enc и ключом, PUT шифра, подтверждение. */
async function uploadEncrypted(token: string, meta: Record<string, unknown>, plain: Uint8Array): Promise<{ att: Attachment; raw: Uint8Array }> {
  const raw = newFileKey();
  const sealed = new Uint8Array(await (await sealFile(new Blob([plain]), await importFileKey(raw))).arrayBuffer());
  const intent = await fetch(`${base}/uploads`, { method: 'POST', headers: as(token), body: JSON.stringify({ ...meta, size: plain.length, enc: 1, key: Buffer.from(raw).toString('base64') }) });
  if (!intent.ok) throw new Error(`intent ${intent.status} ${await intent.text()}`);
  const { id, url, mime } = await intent.json() as { id: string; url: string; mime: string };
  expect(mime).toBe('application/octet-stream');
  const put = await fetch(url, { method: 'PUT', body: sealed, headers: { 'content-type': mime } });
  if (!put.ok) throw new Error(`put ${put.status}`);
  const ok = await fetch(`${base}/uploads/${id}/confirm`, { method: 'POST', headers: { cookie: `relay_session=${token}` } });
  if (!ok.ok) throw new Error(`confirm ${ok.status} ${await ok.text()}`);
  return { att: await ok.json() as Attachment, raw };
}

const SECRET = new TextEncoder().encode('договор: сумма 1 000 000, подпись Анны'.repeat(50));

test('an encrypted file: the storage holds only cipher, the server row no name; a chat member gets the key in the message and opens the file', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await chatOf(a, b);
  const { att } = await uploadEncrypted(a.token, { name: 'договор.txt', mime: 'text/plain' }, SECRET);
  expect(att).toMatchObject({ enc: 1, name: 'договор.txt', size: SECRET.length });
  const stored = new Uint8Array(await s3().file(att.id).arrayBuffer());
  expect(Buffer.from(stored).includes(Buffer.from('договор'))).toBe(false);
  const [row] = await sql`select name, meta, enc from attachments where id = ${att.id}`;
  expect(row).toMatchObject({ name: '', enc: 1 });
  expect(row.meta).not.toBeNull();

  await sendMessage(a.userId, { chatId: chat, clientId: crypto.randomUUID(), body: '', attachment: { id: att.id } });
  const [m] = (await getHistory(b.userId, chat, null, 10)).messages;
  expect(m.attachment).toMatchObject({ id: att.id, enc: 1, name: 'договор.txt' });
  expect(typeof m.attachment!.key).toBe('string');
  // как клиент Бориса: шифр по /files (редирект на хранилище) + ключ из сообщения
  const got = await fetch(`${base}/files/${att.id}`, { headers: as(b.token) });
  expect(got.status).toBe(200);
  const plain = await openFile(await got.blob(), await importFileKey(new Uint8Array(Buffer.from(m.attachment!.key!, 'base64'))));
  expect(new Uint8Array(await plain.arrayBuffer())).toEqual(SECRET);
  // ключ в базе — только шифром (сообщение — content, вложение — keys.attachment_keys)
  const dump = JSON.stringify({ m: await sql`select attachment from messages`, a: await sql`select * from attachments` });
  expect(dump).not.toContain(m.attachment!.key!);
});

test('a wrong size or a plain upload under enc is refused; a bad key is refused', async () => {
  const a = await login('Анна');
  const bad = await fetch(`${base}/uploads`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ name: 'x', mime: 'text/plain', size: 10, enc: 1, key: 'short' }) });
  expect(bad.status).toBe(400);
  const raw = newFileKey();
  const intent = await (await fetch(`${base}/uploads`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ name: 'x', mime: 'text/plain', size: 10, enc: 1, key: Buffer.from(raw).toString('base64') }) })).json() as { id: string; url: string; mime: string };
  await fetch(intent.url, { method: 'PUT', body: new Uint8Array(10), headers: { 'content-type': intent.mime } });   // открытые 10 байт вместо шифра
  const ok = await fetch(`${base}/uploads/${intent.id}/confirm`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` } });
  expect(await ok.json()).toMatchObject({ code: 'upload_mismatch' });
});

async function video(seconds = 4): Promise<Uint8Array> {
  const out = `/tmp/relay-enc-${crypto.randomUUID()}.mp4`;
  const p = Bun.spawn(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=25:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '4M', '-pix_fmt', 'yuv420p', out]);
  await p.exited;
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

test('an encrypted video is processed by the worker: faststart original and copies are stored encrypted, copies open with derived keys', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await chatOf(a, b);
  const bytes = await video();
  const { att, raw } = await uploadEncrypted(a.token, { name: 'clip.mp4', mime: 'video/mp4', kind: 'video', w: 1280, h: 720, duration: 4 }, bytes);
  await sendMessage(a.userId, { chatId: chat, clientId: crypto.randomUUID(), body: '', attachment: { id: att.id } });
  await drainJobs();
  const vs = await sql`select name, key, size from attachment_variants where attachment_id = ${att.id}`;
  expect(vs.length).toBeGreaterThan(0);
  for (const v of vs) {
    const obj = await s3().file(v.key as string).arrayBuffer();
    expect(new TextDecoder().decode(new Uint8Array(obj).subarray(0, 4))).toBe('RLF1');
    const plain = await openFile(new Blob([obj]), await importFileKey(await variantKey(raw, v.name as string)));
    expect(plain.size).toBe(Number(v.size));
    expect(new TextDecoder().decode(new Uint8Array(await plain.slice(4, 8).arrayBuffer()))).toBe('ftyp');   // настоящий mp4
  }
  const [m] = (await getHistory(b.userId, chat, null, 10)).messages;
  expect(m.attachment).toMatchObject({ enc: 1, name: 'clip.mp4' });
  expect(m.attachment!.preview ?? m.attachment!.variants).toBeTruthy();
});

test('an encrypted photo: preview and medium copies are stored encrypted with derived keys and open as WebP of the right size', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await chatOf(a, b);
  const out = `/tmp/relay-enc-${crypto.randomUUID()}.jpg`;
  const p = Bun.spawn(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1600x1200:rate=1', '-vf', 'noise=alls=30:allf=t', '-frames:v', '1', '-q:v', '2', out]);
  await p.exited;
  const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
  const { att, raw } = await uploadEncrypted(a.token, { name: 'photo.jpg', mime: 'image/jpeg', kind: 'photo', w: 1600, h: 1200 }, bytes);
  await sendMessage(a.userId, { chatId: chat, clientId: crypto.randomUUID(), body: '', attachment: { id: att.id } });
  await drainJobs();
  const vs = await sql`select name, key, mime, size, width from attachment_variants where attachment_id = ${att.id} order by name`;
  expect(vs.map((v) => [v.name, v.width])).toEqual([['medium', 800], ['preview', 480]]);
  for (const v of vs) {
    const obj = await s3().file(v.key as string).arrayBuffer();
    expect(new TextDecoder().decode(new Uint8Array(obj).subarray(0, 4))).toBe('RLF1');
    // ключом другой копии не открыть
    const other = vs.find((x) => x.name !== v.name)!.name as string;
    await expect(openFile(new Blob([obj]), await importFileKey(await variantKey(raw, other)))).rejects.toThrow();
    const plain = await openFile(new Blob([obj]), await importFileKey(await variantKey(raw, v.name as string)));
    expect(plain.size).toBe(Number(v.size));
    expect(new TextDecoder().decode(new Uint8Array(await plain.slice(8, 12).arrayBuffer()))).toBe('WEBP');
  }
  // наружу — шифр: тип octet-stream, расшифровывает клиент (SW) ключом копии
  const r = await fetch(`${base}/files/${att.id}/medium`, { headers: { cookie: `relay_session=${b.token}` } });
  expect(r.status).toBe(200);
  expect(new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()).subarray(0, 4))).toBe('RLF1');
  const [m] = (await getHistory(b.userId, chat, null, 10)).messages;
  expect(m.attachment).toMatchObject({ enc: 1, preview: { name: 'preview', w: 480 }, variants: [{ name: 'medium', w: 800, h: 600 }] });
});
