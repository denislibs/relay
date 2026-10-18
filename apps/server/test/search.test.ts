import { beforeEach, expect, test } from 'bun:test';
import { deleteMessage } from '../src/domain/messageOps';
import { sendMessage } from '../src/domain/messages';
import { searchPostgres } from '../src/domain/search';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const say = (u: number, chatId: number, body: string) => sendMessage(u, { chatId, clientId: crypto.randomUUID(), body }).then((r) => r.message);

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
