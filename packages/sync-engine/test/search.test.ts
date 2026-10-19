import { expect, test } from 'bun:test';
import { openDb } from '../src/idb';
import { searchLocal } from '../src/search';
import { Store } from '../src/store';
import { msg } from './fixtures';

const ME = 1, PEER = 2;
const open = async () => { const name = 'search-' + crypto.randomUUID(); const db = await openDb(name); return { name, db, s: await Store.open(db, ME) }; };
const put = (s: Store, id: number, chatId: number, body: string) => s.applyUpdate({ type: 'newMessage', message: msg({ id, chatId, senderId: PEER, body }) });
const find = async (db: IDBDatabase, s: Store, q: string, o: { chatId?: number; beforeId?: number; limit?: number } = {}) =>
  (await searchLocal(db, q, { limit: 30, ...o }, (c, k) => s.loadedMessage(c, k))).list.map((m) => m.body);

test('offline: «прив вст» finds «Привет, встречаемся?» (every word by prefix, AND)', async () => {
  const { db, s } = await open();
  put(s, 10, 7, 'Привет, встречаемся?');
  put(s, 11, 7, 'привет всем');
  put(s, 12, 8, 'встречаемся завтра');
  await s.flush();
  expect(await find(db, s, 'прив вст')).toEqual(['Привет, встречаемся?']);
  expect(await find(db, s, 'ПРИВЕТ')).toEqual(['привет всем', 'Привет, встречаемся?']);   // новые первыми
  expect(await find(db, s, 'встр')).toEqual(['встречаемся завтра', 'Привет, встречаемся?']);
  expect(await find(db, s, 'пока')).toEqual([]);
  expect(await find(db, s, 'п')).toEqual([]);   // слов короче двух букв нет
});

test('messages only in IDB (not loaded) are found; attachment name and track tags are indexed', async () => {
  const { name, db, s } = await open();
  put(s, 10, 7, 'отчёт готов');
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 11, chatId: 7, senderId: PEER, body: '', kind: 'audio', attachment: { id: 'a1', kind: 'audio', mime: 'audio/mpeg', name: 'track01.mp3', size: 1, title: 'Офисный планктон', performer: 'Ария' } as any }) });
  await s.flush();
  const again = await Store.open(await openDb(name), ME);
  expect(await find(db, again, 'отчет')).toEqual(['отчёт готов']);
  const att = async (q: string) => (await searchLocal(db, q, { limit: 30 }, (c, k) => again.loadedMessage(c, k))).list.map((m) => m.id);
  expect(await att('планктон')).toEqual([11]);
  expect(await att('ария')).toEqual([11]);
  expect(await att('track01')).toEqual([11]);
});

test('chatId filter: only that chat', async () => {
  const { db, s } = await open();
  put(s, 10, 7, 'отпуск в июле');
  put(s, 11, 8, 'отпуск в августе');
  await s.flush();
  expect(await find(db, s, 'отпуск', { chatId: 7 })).toEqual(['отпуск в июле']);
  expect(await find(db, s, 'отп', { chatId: 8 })).toEqual(['отпуск в августе']);
  expect(await find(db, s, 'отпуск')).toEqual(['отпуск в августе', 'отпуск в июле']);
});

test('paging by beforeId: limit, hasMore, the next page continues without repeats', async () => {
  const { db, s } = await open();
  for (let id = 1; id <= 7; id++) put(s, id, id % 2 ? 7 : 8, 'слово ' + id);
  await s.flush();
  const by = (c: number, k: string) => s.loadedMessage(c, k);
  const p1 = await searchLocal(db, 'слово', { limit: 3 }, by);
  expect(p1.list.map((m) => m.id)).toEqual([7, 6, 5]);
  expect(p1.hasMore).toBe(true);
  const p2 = await searchLocal(db, 'слово', { limit: 3, beforeId: 5 }, by);
  expect(p2.list.map((m) => m.id)).toEqual([4, 3, 2]);
  expect(p2.hasMore).toBe(true);
  const p3 = await searchLocal(db, 'слово', { limit: 3, beforeId: 2 }, by);
  expect(p3.list.map((m) => m.id)).toEqual([1]);
  expect(p3.hasMore).toBe(false);
});

test('deleted message is never found: in memory, only in IDB, or deleted after the last flush', async () => {
  const { name, db, s } = await open();
  put(s, 10, 7, 'секретное слово');
  put(s, 11, 7, 'секретное тоже');
  await s.flush();
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 10 } as any);
  await s.flush();
  expect(await find(db, s, 'секрет')).toEqual(['секретное тоже']);
  const again = await Store.open(await openDb(name), ME);   // только в IDB
  expect(await find(db, again, 'секрет')).toEqual(['секретное тоже']);
  // удалено в памяти, указатель ещё старый (до flush): проверка по самой строке
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 11 } as any);
  expect(await find(db, s, 'секрет')).toEqual([]);
});
