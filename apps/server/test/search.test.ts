import { beforeEach, expect, test } from 'bun:test';
import { deleteMessage } from '../src/domain/messageOps';
import { sendMessage } from '../src/domain/messages';
import { searchPostgres } from '../src/domain/search';
import { sql } from '../src/db';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const say = (u: number, chatId: number, body: string) => sendMessage(u, { chatId, clientId: crypto.randomUUID(), body }).then((r) => r.message);
/** Сообщение с загруженным вложением (строка attachments — сразу готовая, как после загрузки). */
async function sendFile(u: number, chatId: number, meta: { name: string; mime: string; kind: string; title?: string; performer?: string }, body = '') {
  const [a] = await sql`insert into attachments (owner_id, mime, name, size, kind, title, performer, status)
    values (${u}, ${meta.mime}, ${meta.name}, 1, ${meta.kind}, ${meta.title ?? null}, ${meta.performer ?? null}, 'ready') returning id`;
  return (await sendMessage(u, { chatId, clientId: crypto.randomUUID(), body, attachment: { id: a.id as string } })).message;
}

test('search: case-insensitive substring, newest first, own chats only, per chat, paging, no deleted, wildcards are literal', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  await say(a, ab, 'Встреча в Пятницу');
  const m2 = await say(b, ab, 'перенесли встречу');
  await say(b, bc, 'встреча без a');                                      // чужой для a чат
  const gone = await say(a, ab, 'встреча удалена');
  await deleteMessage(a, ab, gone.id);
  await say(a, ab, '100% готово');

  const all = await searchPostgres(a, 'ВСТРЕЧ');
  expect(all.hits.map((h) => h.message.body)).toEqual(['перенесли встречу', 'Встреча в Пятницу']);
  expect(all.hits[0].chatTitle).toBe('b');
  const p1 = await searchPostgres(a, 'встреч', { limit: 1 });
  expect(p1.hasMore).toBe(true);
  const p2 = await searchPostgres(a, 'встреч', { limit: 1, beforeId: p1.hits[0].message.id });
  expect(p2.hits[0].message.body).toBe('Встреча в Пятницу');
  expect((await searchPostgres(b, 'встреч', { chatId: bc })).hits.map((h) => h.message.body)).toEqual(['встреча без a']);
  expect((await searchPostgres(a, '0%')).hits.map((h) => h.message.body)).toEqual(['100% готово']);
  expect((await searchPostgres(a, 'ес', { chatId: ab })).hits.some((h) => h.message.id === m2.id)).toBe(true);
  await expect(searchPostgres(a, 'я')).rejects.toMatchObject({ code: 'bad_frame' });
  await expect(searchPostgres(a, 'встреч', { chatId: bc })).rejects.toBeTruthy();
});

test('search: attachments are found by file name and by track title/performer, in all chats and in one', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const song = await sendFile(b, ab, { name: 'track01.mp3', mime: 'audio/mpeg', kind: 'audio', title: 'Офисный планктон', performer: 'Ария' });
  const pdf = await sendFile(a, ab, { name: 'Отчёт_за_май.pdf', mime: 'application/pdf', kind: 'file' }, 'держи');
  await say(a, ab, 'ничего общего');
  const ids = async (q: string, chatId?: number) => (await searchPostgres(a, q, { chatId })).hits.map((h) => h.message.id);
  expect(await ids('планктон')).toEqual([song.id]);
  expect(await ids('ПЛАНКТОН', ab)).toEqual([song.id]);
  expect(await ids('ария', ab)).toEqual([song.id]);
  expect(await ids('track01')).toEqual([song.id]);
  expect(await ids('отчёт_за')).toEqual([pdf.id]);           // «_» — буквально, не любой символ
  expect(await ids('.pdf', ab)).toEqual([pdf.id]);
  expect(await ids('отчёт_зa')).toEqual([]);                 // латинская «a»
  expect((await searchPostgres(a, 'планктон')).hits[0].message.attachment).toMatchObject({ title: 'Офисный планктон', performer: 'Ария' });
});
