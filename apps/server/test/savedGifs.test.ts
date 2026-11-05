import { afterAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFileKey, newFileKey, openFile, SAVED_GIFS_LIMIT, sealFile, variantKey, type Attachment, type SavedGif } from '@relay/protocol';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { resetFileKeyCache } from '../src/crypto/fileKeys';
import { s3 } from '../src/domain/files';
import { sendMessage } from '../src/domain/messages';
import { deleteMessage } from '../src/domain/messageOps';
import { listSavedGifs, removeGif, saveGif } from '../src/domain/savedGifs';
import { collectGarbage } from '../src/domain/storageGc';
import { deleteDirectChat } from '../src/domain/chats';
import { expireStep, setAutoDelete } from '../src/domain/autoDelete';
import '../src/jobs/kinds';
import { drainJobs } from '../src/jobs/worker';
import { makeChat, makeUser, resetDb } from './helpers';

setDefaultTimeout(60_000);
const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
const dir = await mkdtemp(join(tmpdir(), 'relay-gif-test-'));
afterAll(async () => { server.stop(true); await rm(dir, { recursive: true, force: true }); });
beforeEach(async () => { await resetDb(); resetFileKeyCache(); });

const cid = () => crypto.randomUUID();
const THUMB = 'data:image/jpeg;base64,QUJDRA==';
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const as = (t: string) => ({ cookie: `relay_session=${t}`, 'content-type': 'application/json' });
const dm = async (a: { userId: number; token: string }, b: { userId: number }) =>
  ((await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number }).id;

/** Настоящая анимация от генератора ffmpeg (чужих файлов в тестах нет). */
async function makeGif(w = 64, h = 48): Promise<Uint8Array> {
  const out = join(dir, `${w}x${h}.gif`);
  const p = Bun.spawn(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=5:duration=1', '-vf', `scale=${w}:${h}`, out], { stderr: 'pipe' });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

/** Как клиент: ключ файла, шифр, заявка, PUT, подтверждение. */
async function upload(token: string, plain: Uint8Array, meta: Record<string, unknown> = {}): Promise<{ att: Attachment; raw: Uint8Array }> {
  const raw = newFileKey();
  const sealed = new Uint8Array(await (await sealFile(new Blob([plain]), await importFileKey(raw))).arrayBuffer());
  const intent = await fetch(`${base}/uploads`, { method: 'POST', headers: as(token), body: JSON.stringify({ name: 'cat.gif', mime: 'image/gif', kind: 'photo', w: 64, h: 48, size: plain.length, enc: 1, key: Buffer.from(raw).toString('base64'), ...meta }) });
  if (!intent.ok) throw new Error(`intent ${intent.status}`);
  const { id, url, mime } = await intent.json() as { id: string; url: string; mime: string };
  if (!(await fetch(url, { method: 'PUT', body: sealed, headers: { 'content-type': mime } })).ok) throw new Error('put');
  const ok = await fetch(`${base}/uploads/${id}/confirm`, { method: 'POST', headers: { cookie: `relay_session=${token}` } });
  if (!ok.ok) throw new Error(`confirm ${ok.status}`);
  return { att: await ok.json() as Attachment, raw };
}

/** Готовое вложение-GIF без файла в хранилище: для проверок прав и лимита. */
const rowGif = async (owner: number, days = 0) => (await sql`insert into attachments (owner_id, mime, name, size, status, kind, width, height, created_at)
  values (${owner}, 'image/gif', 'a.gif', 10, 'ready', 'photo', 10, 10, now() - ${days} * interval '1 day') returning id`)[0].id as string;
const sent = async (from: number, chatId: number, attId: string) => (await sendMessage(from, { chatId, clientId: cid(), body: '', attachment: { id: attId, thumb: THUMB } })).message;
const exists = async (id: string) => (await sql`select 1 from attachments where id = ${id}`).length > 0;
const hasKey = async (id: string) => (await sql`select 1 from keys.attachment_keys where attachment_id = ${id}`).length > 0;
const ids = (l: { list: SavedGif[] }) => l.list.map((g) => g.id);
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
const DAY = 24 * 3600_000;

test('save and remove: newest first, the same file is saved once, re-saving lifts it, the journal notifies my devices only', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const g1 = await rowGif(a), g2 = await rowGif(a);
  const m1 = await sent(a, chat, g1), m2 = await sent(a, chat, g2);
  const [{ seq: before }] = await sql`select coalesce(max(seq), 0)::bigint as seq from updates where user_id = ${b}`;
  await saveGif(b, chat, m1.id);
  await saveGif(b, chat, m2.id);
  expect(ids(await listSavedGifs(b, []))).toEqual([g2, g1]);
  await saveGif(b, chat, m1.id);
  expect(ids(await listSavedGifs(b, []))).toEqual([g1, g2]);
  expect(ids(await listSavedGifs(a, []))).toEqual([]);   // отправка сама ничего не сохраняет; чужой список другому не виден
  const journal = await sql`select type from updates where user_id = ${b} and seq > ${before}`;
  expect(journal.filter((r) => r.type === 'myGifs')).toHaveLength(3);
  expect((await sql`select thumb from saved_gifs where user_id = ${b}`).every((r) => r.thumb === null)).toBe(true);   // старый незашифрованный файл: ключа нет — миниатюра не хранится
  await removeGif(b, g1);
  await removeGif(b, g1);   // повтор — без ошибки
  expect(ids(await listSavedGifs(b, []))).toEqual([g2]);
  expect(await exists(g1)).toBe(true);   // сообщение ещё живо: файл остаётся
});

test('only GIFs: a photo and a text message cannot be saved', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const [{ id: png }] = await sql`insert into attachments (owner_id, mime, name, size, status, kind, width, height) values (${a}, 'image/png', 'a.png', 10, 'ready', 'photo', 10, 10) returning id`;
  const photo = await sent(a, chat, png as string);
  const text = (await sendMessage(a, { chatId: chat, clientId: cid(), body: 'привет' })).message;
  expect(await code(saveGif(b, chat, photo.id))).toBe('bad_frame');
  expect(await code(saveGif(b, chat, text.id))).toBe('bad_frame');
});

test('over the limit the oldest is evicted; an evicted file nobody else references goes with its key', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const old = await rowGif(a);
  const mOld = await sent(a, chat, old);
  await saveGif(b, chat, mOld.id);
  await deleteMessage(a, chat, mOld.id);   // теперь файл держит только сохранённая
  await sql`update saved_gifs set saved_at = now() - interval '1 day' where attachment_id = ${old}`;
  // заполнить до лимита прямо в базе: 200 сообщений здесь ни к чему
  const fill = (await sql`insert into attachments (owner_id, mime, name, size, status, kind, width, height)
    select ${a}, 'image/gif', 'a.gif', 10, 'ready', 'photo', 10, 10 from generate_series(1, ${SAVED_GIFS_LIMIT - 1}) returning id`).map((r) => r.id as string);
  await sql`insert into saved_gifs (user_id, attachment_id) select ${b}, unnest(${fill}::uuid[])`;
  const last = await rowGif(a);
  const r = await saveGif(b, chat, (await sent(a, chat, last)).id);
  expect(r.evicted).toEqual([old]);
  const list = ids(await listSavedGifs(b, []));
  expect(list).toHaveLength(SAVED_GIFS_LIMIT);
  expect(list[0]).toBe(last);
  expect(list).not.toContain(old);
  expect(await exists(old)).toBe(false);
});

test('a chat I am not in, hidden history and a deleted message cannot be saved from', async () => {
  const a = await makeUser(), b = await makeUser(), stranger = await makeUser();
  const chat = await makeChat([a, b]);
  const g = await rowGif(a);
  const m = await sent(a, chat, g);
  expect(await code(saveGif(stranger, chat, m.id))).toBe('not_member');
  expect(ids(await listSavedGifs(stranger, []))).toEqual([]);
  // скрытая история: b вступил после сообщения
  await sql`update chat_members set history_from = ${m.id + 1} where chat_id = ${chat} and user_id = ${b}`;
  expect(await code(saveGif(b, chat, m.id))).toBe('not_found');
  await sql`update chat_members set history_from = 0 where chat_id = ${chat} and user_id = ${b}`;
  await deleteMessage(a, chat, m.id);
  expect(await code(saveGif(b, chat, m.id))).toBe('not_found');
});

test('a protected chat refuses saving, over HTTP as well', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await makeChat([a.userId, b.userId], 'group');
  const m = await sent(a.userId, chat, await rowGif(a.userId));
  await sql`update chats set protected = true where id = ${chat}`;
  expect(await code(saveGif(b.userId, chat, m.id))).toBe('forbidden');
  const res = await fetch(`${base}/my-gifs`, { method: 'POST', headers: as(b.token), body: JSON.stringify({ chatId: chat, messageId: m.id }) });
  expect(res.status).toBe(403);
  expect(await sql`select 1 from saved_gifs`).toHaveLength(0);
});

test('someone else\'s saved GIF gives nothing: no file, no sending, no removal', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const chat = await dm(a, b), other = await dm(c, b);
  const { att } = await upload(a.token, await makeGif());
  const m = await sent(a.userId, chat, att.id);
  await saveGif(b.userId, chat, m.id);
  const file = (t: string) => fetch(`${base}/files/${att.id}`, { headers: as(t), redirect: 'manual' });
  expect((await file(c.token)).status).toBe(404);
  expect(await code(sendMessage(c.userId, { chatId: other, clientId: cid(), body: '', attachment: { id: att.id } }))).toBe('not_found');
  await removeGif(c.userId, att.id);
  expect(ids(await listSavedGifs(b.userId, []))).toEqual([att.id]);
});

test('sending a saved GIF reuses the attachment: no upload, the recipient gets the key in the message and opens the file', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const ab = await dm(a, b), bc = await dm(b, c);
  const bytes = await makeGif();
  const { att, raw } = await upload(a.token, bytes);
  const m = await sent(a.userId, ab, att.id);
  await saveGif(b.userId, ab, m.id);
  const before = (await sql`select count(*)::int as n from attachments`)[0].n;
  const { message } = await sendMessage(b.userId, { chatId: bc, clientId: cid(), body: '', attachment: { id: att.id, thumb: THUMB } });
  expect(message.attachment).toMatchObject({ id: att.id, kind: 'photo', mime: 'image/gif', key: Buffer.from(raw).toString('base64') });
  expect((await sql`select count(*)::int as n from attachments`)[0].n).toBe(before);
  const res = await fetch(`${base}/files/${att.id}`, { headers: as(c.token), redirect: 'manual' });
  expect(res.status).toBe(302);
  const stored = await fetch(res.headers.get('location')!);
  expect(new Uint8Array(await (await openFile(await stored.blob(), await importFileKey(raw))).arrayBuffer())).toEqual(bytes);
});

test('encryption: the row holds no open key or thumbnail, the thumbnail opens only with the file key and only for its owner', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await dm(a, b);
  const { att, raw } = await upload(a.token, await makeGif());
  const m = await sent(a.userId, chat, att.id);
  const { gif } = await saveGif(b.userId, chat, m.id);
  expect(gif).toMatchObject({ id: att.id, thumb: THUMB, key: Buffer.from(raw).toString('base64'), enc: 1, name: 'cat.gif' });
  const [row] = await sql`select * from saved_gifs where attachment_id = ${att.id}`;
  expect(Object.keys(row).sort()).toEqual(['attachment_id', 'saved_at', 'thumb', 'user_id']);   // колонки для копии ключа нет
  const stored = Buffer.from(row.thumb as Uint8Array);
  expect(stored.includes(Buffer.from(THUMB))).toBe(false);
  expect(stored.includes(Buffer.from('QUJDRA'))).toBe(false);
  // шифр чужой строки не открывается: перенесённая миниатюра не читается (AAD — пользователь и файл)
  await sql`insert into saved_gifs (user_id, attachment_id, thumb) values (${a.userId}, ${att.id}, ${stored})`;
  expect((await listSavedGifs(a.userId, [])).list[0].thumb ?? null).toBeNull();
  // то, что устройство уже знает, приходит без ключа: иначе каждое чтение — до 200 обращений к KMS
  const again = (await listSavedGifs(b.userId, [att.id])).list[0];
  expect(again.key).toBeUndefined();
  expect(again.thumb).toBeNull();
});

test('a file saved by someone survives garbage collection; removing the last reference destroys the file and its key at once', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await dm(a, b);
  const { att } = await upload(a.token, await makeGif());
  const m = await sent(a.userId, chat, att.id);
  await drainJobs();
  await saveGif(b.userId, chat, m.id);
  await deleteMessage(a.userId, chat, m.id);
  await sql`update attachments set created_at = now() - interval '30 days' where id = ${att.id}`;
  expect((await collectGarbage({ graceMs: 7 * DAY })).deleted).toBe(0);
  expect(await exists(att.id)).toBe(true);
  expect(await hasKey(att.id)).toBe(true);
  expect(await s3().exists(att.id)).toBe(true);
  await removeGif(b.userId, att.id);
  expect(await exists(att.id)).toBe(false);
  expect(await hasKey(att.id)).toBe(false);
  await drainJobs();   // attachment.purge
  expect(await s3().exists(att.id)).toBe(false);
});

test('two people saved it: the file lives until the last one removes it', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const chat = await makeChat([a, b, c], 'group');
  const g = await rowGif(a);
  const m = await sent(a, chat, g);
  await saveGif(b, chat, m.id); await saveGif(c, chat, m.id);
  await deleteMessage(a, chat, m.id);
  await removeGif(b, g);
  expect(await exists(g)).toBe(true);
  await removeGif(c, g);
  expect(await exists(g)).toBe(false);
});

test('source deleted for everyone: the saver keeps a working copy; the sender loses nothing but the message', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await dm(a, b);
  const bytes = await makeGif();
  const { att, raw } = await upload(a.token, bytes);
  const m = await sent(a.userId, chat, att.id);
  await saveGif(b.userId, chat, m.id);
  await deleteMessage(a.userId, chat, m.id);
  const fresh = (await listSavedGifs(b.userId, [])).list[0];
  expect(fresh).toMatchObject({ id: att.id, key: Buffer.from(raw).toString('base64'), thumb: THUMB });
  expect((await fetch(`${base}/files/${att.id}`, { headers: as(b.token), redirect: 'manual' })).status).toBe(302);
});

test('«delete the chat for both» shreds the chat key, not the saved copy: the saver keeps the GIF, the other side has no way to it', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const chat = await dm(a, b), other = await dm(a, c);
  const { att } = await upload(c.token, await makeGif());
  const cm = await sent(c.userId, other, att.id);
  await saveGif(a.userId, other, cm.id);
  await sendMessage(a.userId, { chatId: chat, clientId: cid(), body: '', attachment: { id: att.id, thumb: THUMB } });
  await deleteDirectChat(a.userId, chat, true);
  expect(await hasKey(att.id)).toBe(true);
  expect((await listSavedGifs(a.userId, [])).list[0].key).toBeDefined();
  expect((await fetch(`${base}/files/${att.id}`, { headers: as(b.token), redirect: 'manual' })).status).toBe(404);
});

test('auto-delete: a message with a term cannot be saved (the promise has an end date); nothing outlives it', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await dm(a, b);
  await setAutoDelete(a.userId, chat, 86400);
  const { att } = await upload(a.token, await makeGif());
  const m = await sent(a.userId, chat, att.id);
  expect(await code(saveGif(b.userId, chat, m.id))).toBe('forbidden');
  await sql`update messages set expires_at = now() - interval '1 second' where chat_id = ${chat} and id = ${m.id}`;
  await expireStep();
  expect(await exists(att.id)).toBe(false);
  expect(await hasKey(att.id)).toBe(false);
});

test('auto-delete: my own saved GIF sent into such a chat stays mine after the message expires, and only mine', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const ab = await dm(a, b), bc = await dm(b, c);
  const { att } = await upload(a.token, await makeGif());
  await saveGif(b.userId, ab, (await sent(a.userId, ab, att.id)).id);
  await setAutoDelete(b.userId, bc, 86400);
  const m = (await sendMessage(b.userId, { chatId: bc, clientId: cid(), body: '', attachment: { id: att.id, thumb: THUMB } })).message;
  await sql`update messages set expires_at = now() - interval '1 second' where chat_id = ${bc} and id = ${m.id}`;
  expect((await fetch(`${base}/files/${att.id}`, { headers: as(c.token), redirect: 'manual' })).status).toBe(404);
  await expireStep();
  expect(await hasKey(att.id)).toBe(true);
  expect((await fetch(`${base}/files/${att.id}`, { headers: as(b.token), redirect: 'manual' })).status).toBe(302);
  expect((await fetch(`${base}/files/${att.id}`, { headers: as(c.token), redirect: 'manual' })).status).toBe(404);
});

test('a real GIF gets a silent looping H.264 copy under a derived key; an old one gets it on saving; savers learn about it', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await dm(a, b);
  const bytes = await makeGif(65, 47);   // нечётные стороны: yuv420p требует чётных
  const { att, raw } = await upload(a.token, bytes, { w: 65, h: 47 });
  const m = await sent(a.userId, chat, att.id);
  await drainJobs();
  const [v] = await sql`select name, mime, width, height from attachment_variants where attachment_id = ${att.id} and name = 'loop'`;
  expect(v).toMatchObject({ name: 'loop', mime: 'video/mp4' });
  expect(Number(v.width) % 2 + Number(v.height) % 2).toBe(0);
  const res = await fetch(`${base}/files/${att.id}/loop`, { headers: as(b.token), redirect: 'manual' });
  expect(res.status).toBe(302);
  const plain = await openFile(await (await fetch(res.headers.get('location')!)).blob(), await importFileKey(await variantKey(raw, 'loop')));
  const mp4 = new Uint8Array(await plain.arrayBuffer());
  expect(new TextDecoder().decode(mp4.subarray(4, 8))).toBe('ftyp');
  // старая GIF, обработанная до появления копии: сохранение ставит её в очередь, готовая копия приходит журналом
  await sql`delete from attachment_variants where attachment_id = ${att.id} and name = 'loop'`;
  await saveGif(b.userId, chat, m.id);
  expect((await listSavedGifs(b.userId, [])).list[0].variants?.some((x) => x.name === 'loop') ?? false).toBe(false);
  const [{ seq }] = await sql`select coalesce(max(seq), 0)::bigint as seq from updates where user_id = ${b.userId}`;
  await drainJobs();
  expect((await listSavedGifs(b.userId, [])).list[0].variants?.some((x) => x.name === 'loop')).toBe(true);
  const types = (await sql`select type from updates where user_id = ${b.userId} and seq > ${seq}`).map((r) => r.type as string);
  expect(types).toContain('myGifs');
});
