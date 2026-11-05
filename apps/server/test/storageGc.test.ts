import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { sql } from '../src/db';
import { s3 } from '../src/domain/files';
import { sendMessage } from '../src/domain/messages';
import { deleteMessage } from '../src/domain/messageOps';
import { collectGarbage } from '../src/domain/storageGc';
import '../src/jobs/kinds';
import { drainJobs } from '../src/jobs/worker';
import { makeChat, makeUser, resetDb, uploadFile } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

const cid = () => crypto.randomUUID();
const DAY = 24 * 3600_000;
/** Готовое вложение без объекта в S3 (для проверок ссылок), созданное days дней назад. */
const attachment = async (owner: number, days = 30, kind = 'photo') =>
  (await sql`insert into attachments (owner_id, mime, name, size, status, kind, width, height, created_at)
    values (${owner}, 'image/png', 'a.png', 10, 'ready', ${kind}, 10, 10, now() - ${days} * interval '1 day') returning id`)[0].id as string;
const exists = async (id: string) => (await sql`select 1 from attachments where id = ${id}`).length > 0;
const gc = () => collectGarbage({ graceMs: 7 * DAY });
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };

test('never sent within the grace period: the row and the S3 object go; a fresh upload stays', async () => {
  const a = await login('Анна');
  const old = await uploadFile(base, a.token, { name: 'old.pdf', mime: 'application/pdf' }, 'old') as { id: string };
  const fresh = await uploadFile(base, a.token, { name: 'new.pdf', mime: 'application/pdf' }, 'new') as { id: string };
  await sql`update attachments set created_at = now() - interval '8 days' where id = ${old.id}`;
  expect(await s3().exists(old.id)).toBe(true);

  expect(await gc()).toMatchObject({ deleted: 1, done: true });
  await drainJobs();   // attachment.purge
  expect(await exists(old.id)).toBe(false);
  expect(await s3().exists(old.id)).toBe(false);
  expect(await exists(fresh.id)).toBe(true);
  expect(await s3().exists(fresh.id)).toBe(true);
});

test('a sent file stays; deleted for everyone — goes', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const id = await attachment(a);
  const { message } = await sendMessage(a, { chatId: chat, clientId: cid(), body: '', attachment: { id } });
  expect((await gc()).deleted).toBe(0);
  expect(await exists(id)).toBe(true);
  await deleteMessage(a, chat, message.id);
  expect((await gc()).deleted).toBe(1);
  expect(await exists(id)).toBe(false);
});

test('forwards share the attachment id: it lives while any copy lives', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  const id = await attachment(a);
  const { message: src } = await sendMessage(a, { chatId: ab, clientId: cid(), body: 'котик', attachment: { id } });
  const { message: fwd } = await sendMessage(b, { chatId: bc, clientId: cid(), body: '', forward: { chatId: ab, id: src.id } });
  expect(fwd.attachment).toMatchObject({ id });

  await deleteMessage(a, ab, src.id);   // оригинал удалён у всех — копия в другом чате осталась
  expect((await gc()).deleted).toBe(0);
  expect(await exists(id)).toBe(true);

  await deleteMessage(b, bc, fwd.id);
  expect((await gc()).deleted).toBe(1);
  expect(await exists(id)).toBe(false);
});

test('a forward of an already collected attachment fails instead of pointing at a missing file', async () => {
  const a = await makeUser(), b = await makeUser();
  const ab = await makeChat([a, b]);
  const id = await attachment(a);
  const { message: src } = await sendMessage(a, { chatId: ab, clientId: cid(), body: '', attachment: { id } });
  await sql`delete from attachments where id = ${id}`;   // как если бы сборка мусора успела раньше пересылки
  await expect(sendMessage(b, { chatId: ab, clientId: cid(), body: '', forward: { chatId: ab, id: src.id } })).rejects.toMatchObject({ code: 'not_found' });
});

test('profile music, profile photos (current and history, video avatar), group photos and link previews keep their files', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const track = await attachment(a, 30, 'audio');
  const { message } = await sendMessage(a, { chatId: chat, clientId: cid(), body: '', attachment: { id: track } });
  await sql`insert into profile_music (user_id, attachment_id, title) values (${b}, ${track}, 'song')`;
  await deleteMessage(a, chat, message.id);   // трек остался только в профиле Бориса

  const [big, small, video, curBig, curSmall, gBig, gSmall, lp] = await Promise.all(Array.from({ length: 8 }, () => attachment(a)));
  await sql`insert into user_photos (user_id, big, small, thumb, video) values (${a}, ${big}, ${small}, '', ${video})`;
  await sql`update users set photo = ${sql.json({ id: curBig, small: curSmall, thumb: '', at: Date.now() } as never)} where id = ${a}`;
  await sql`insert into chat_photos (chat_id, big, small, thumb) values (${chat}, ${gBig}, ${gSmall}, '')`;
  await sql`insert into link_previews (url_hash, photo_id) values ('test', ${lp})`;
  const loose = await attachment(a);

  expect((await gc()).deleted).toBe(1);
  for (const id of [track, big, small, video, curBig, curSmall, gBig, gSmall, lp]) expect(await exists(id)).toBe(true);
  expect(await exists(loose)).toBe(false);

  // фото убрали из истории — его файлы теперь мусор
  await sql`delete from user_photos where user_id = ${a}`;
  await sql`delete from profile_music where user_id = ${b}`;
  expect((await gc()).deleted).toBe(4);
  for (const id of [track, big, small, video]) expect(await exists(id)).toBe(false);
});

test('pending uploads are not touched (the 24 h sweep owns them); the cursor walks a big table in batches', async () => {
  const a = await makeUser();
  const [p] = await sql`insert into attachments (owner_id, mime, name, size, status, created_at) values (${a}, 'text/plain', 'p', 1, 'pending', now() - interval '30 days') returning id`;
  const ids = await Promise.all(Array.from({ length: 7 }, () => attachment(a)));
  // одинаковое время у всех — курсор обязан различать по id, а не застрять на одной метке
  await sql`update attachments set created_at = now() - interval '30 days' where id = any(${ids}::uuid[])`;

  const first = await collectGarbage({ graceMs: 7 * DAY, batch: 3, maxBatches: 1 });
  expect(first).toMatchObject({ scanned: 3, deleted: 3, done: false });
  const rest = await collectGarbage({ graceMs: 7 * DAY, batch: 3, maxBatches: 10 });
  expect(rest).toMatchObject({ scanned: 4, deleted: 4, done: true });
  for (const id of ids) expect(await exists(id)).toBe(false);
  expect(await exists(p.id as string)).toBe(true);
  expect((await sql`select 1 from server_meta where k = 'storage_gc_cursor'`).length).toBe(0);
});

test('storage.gc runs as a periodic job and reschedules itself', async () => {
  const a = await makeUser();
  const id = await attachment(a);
  const { ensurePeriodic } = await import('../src/jobs/queue');
  await ensurePeriodic('storage.gc');
  await drainJobs();
  expect(await exists(id)).toBe(false);
  const [job] = await sql`select run_at > now() + interval '30 minutes' as later from jobs where kind = 'storage.gc'`;
  expect(job.later).toBe(true);
});
