import { expect, test } from 'bun:test';
import { recomputeLast } from '../src/derive';
import { openDb } from '../src/idb';
import { computeQuery } from '../src/queries';
import { Store } from '../src/store';
import { msg } from './fixtures';

const ME = 1, PEER = 2;
const fresh = async () => Store.open(await openDb('d-' + crypto.randomUUID()), ME);

test('deleting the last message makes the previous one last; lastAt follows it', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 2, chatId: 10, senderId: PEER }) });
  expect(s.chats.get(10)!.lastAt).toBe(msg({ id: 2, chatId: 10, senderId: PEER }).createdAt);
  s.applyUpdate({ type: 'messageDeleted', chatId: 10, id: 2 });
  const chat = s.chats.get(10)!;
  expect(chat.last).toMatchObject({ id: 1, body: 'text 1' });
  expect(chat.last?.deleted).toBeFalsy();
  expect(chat.lastAt).toBe(chat.last!.createdAt);   // чат опускается к дате нового верхнего сообщения
});

test('after deleting the last message the chat moves down in the list; a newer draft still lifts it', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 2, chatId: 20, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 3, chatId: 10, senderId: PEER }) });
  const order = () => computeQuery(s, { kind: 'chatList', limit: 50 }).order;
  expect(order()).toEqual(['c10', 'c20']);
  s.applyUpdate({ type: 'messageDeleted', chatId: 10, id: 3 });
  expect(order()).toEqual(['c20', 'c10']);
  s.setDraft(10, 'пишу');
  expect(order()).toEqual(['c10', 'c20']);
});

test('deleting an older message leaves last alone', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 2, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'messageDeleted', chatId: 10, id: 1 });
  expect(s.chats.get(10)!.last).toMatchObject({ id: 2, body: 'text 2' });
});

test('nothing else known: last is empty (no «Сообщение удалено»), lastAt stays, the row is asked from the server', async () => {
  const db = await openDb('d-' + crypto.randomUUID());
  const s = await Store.open(db, ME);
  const wanted: number[] = [];
  s.wantRow = (id) => wanted.push(id);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 5, chatId: 10, senderId: PEER }) });
  const at = s.chats.get(10)!.lastAt;
  s.applyUpdate({ type: 'messageDeleted', chatId: 10, id: 5 });
  expect(s.chats.get(10)!.last).toBeNull();
  expect(s.chats.get(10)!.lastAt).toBe(at);   // не удалённых нет — lastAt прежний
  expect(wanted).toEqual([10]);

  // после перезапуска сообщений чата в памяти нет — только chat.last
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 6, chatId: 10, senderId: PEER }) });
  await s.flush();
  const again = await Store.open(db, ME);
  again.wantRow = (id) => wanted.push(id);
  const at6 = again.chats.get(10)!.lastAt;
  again.applyUpdate({ type: 'messageDeleted', chatId: 10, id: 6 });
  expect(again.chats.get(10)!.last).toBeNull();
  expect(again.chats.get(10)!.lastAt).toBe(at6);
  expect(wanted).toEqual([10, 10]);
  // строка с сервера — предыдущее не удалённое — становится превью
  again.applyChats([{ id: 10, kind: 'direct', title: null, lastReadId: 0, unread: 0, last: msg({ id: 4, chatId: 10, senderId: PEER }) }]);
  expect(again.chats.get(10)!.last).toMatchObject({ id: 4, body: 'text 4' });
});

test('a tombstone left in an old cache is replaced by the server last, even an older one', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 7, chatId: 10, senderId: PEER }) });
  const chat = s.chats.get(10)!;
  chat.last = { ...chat.last!, deleted: true, body: '' };   // как строка из кэша до этого правила
  s.applyChats([{ id: 10, kind: 'direct', title: null, lastReadId: 0, unread: 0, last: msg({ id: 3, chatId: 10, senderId: PEER }) }]);
  expect(chat.last).toMatchObject({ id: 3, deleted: false });
});

test('editing the last message updates last.body, loaded or not', async () => {
  const db = await openDb('d-' + crypto.randomUUID());
  const s = await Store.open(db, ME);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 2, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'messageEdited', chatId: 10, id: 2, body: 'правка', editedAt: new Date().toISOString() });
  expect(s.chats.get(10)!.last).toMatchObject({ id: 2, body: 'правка' });
  s.applyUpdate({ type: 'messageEdited', chatId: 10, id: 1, body: 'старое' });
  expect(s.chats.get(10)!.last).toMatchObject({ id: 2, body: 'правка' });

  await s.flush();
  const again = await Store.open(db, ME);   // сообщения не загружены — правится chat.last
  again.applyUpdate({ type: 'messageEdited', chatId: 10, id: 2, body: 'ещё раз', editedAt: new Date().toISOString() });
  expect(again.chats.get(10)!.last).toMatchObject({ id: 2, body: 'ещё раз' });
});

test('recomputeLast prefers the newest not-deleted message', async () => {
  const s = await fresh();
  for (let i = 1; i <= 3; i++) s.applyUpdate({ type: 'newMessage', message: msg({ id: i, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'messageDeleted', chatId: 10, id: 3 });
  s.applyUpdate({ type: 'messageDeleted', chatId: 10, id: 2 });
  const chat = s.chats.get(10)!;
  expect(chat.last?.id).toBe(1);
  recomputeLast(s, chat);
  expect(chat.last?.id).toBe(1);
});

test('discarding a pending last falls back to the previous message', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 10, senderId: PEER }) });
  s.addPending({ clientId: 'p1', chatId: 10, body: 'не ушло', replyToId: null, createdAt: Date.now(), failed: true } as never);
  expect(s.chats.get(10)!.last?.key).toBe('p1');
  s.discard(['p1']);
  expect(s.chats.get(10)!.last?.id).toBe(1);
});

test('incoming messages still count as unread; reading clears them', async () => {
  const s = await fresh();
  for (let i = 1; i <= 3; i++) s.applyUpdate({ type: 'newMessage', message: msg({ id: i, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 4, chatId: 10, senderId: ME }) });
  expect(s.chats.get(10)!.unread).toBe(3);
  s.applyUpdate({ type: 'readOwn', chatId: 10, upToId: 2 });
  expect(s.chats.get(10)!.unread).toBe(1);
});
