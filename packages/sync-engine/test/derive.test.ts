import { expect, test } from 'bun:test';
import { recomputeLast } from '../src/derive';
import { openDb } from '../src/idb';
import { Store } from '../src/store';
import { msg } from './fixtures';

const ME = 1, PEER = 2;
const fresh = async () => Store.open(await openDb('d-' + crypto.randomUUID()), ME);

test('deleting the last message makes the previous one last; lastAt keeps its place', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 2, chatId: 10, senderId: PEER }) });
  const at = s.chats.get(10)!.lastAt;
  s.applyUpdate({ type: 'messageDeleted', chatId: 10, id: 2 });
  const chat = s.chats.get(10)!;
  expect(chat.last).toMatchObject({ id: 1, body: 'text 1' });
  expect(chat.last?.deleted).toBeFalsy();
  expect(chat.lastAt).toBe(at);   // место в списке не прыгает
});

test('deleting an older message leaves last alone', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 2, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'messageDeleted', chatId: 10, id: 1 });
  expect(s.chats.get(10)!.last).toMatchObject({ id: 2, body: 'text 2' });
});

test('nothing else known: the deleted last stays as a tombstone (preview «Сообщение удалено»)', async () => {
  const db = await openDb('d-' + crypto.randomUUID());
  const s = await Store.open(db, ME);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 5, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'messageDeleted', chatId: 10, id: 5 });
  expect(s.chats.get(10)!.last).toMatchObject({ id: 5, deleted: true, body: '' });

  // после перезапуска сообщений чата в памяти нет — только chat.last
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 6, chatId: 10, senderId: PEER }) });
  await s.flush();
  const again = await Store.open(db, ME);
  again.applyUpdate({ type: 'messageDeleted', chatId: 10, id: 6 });
  expect(again.chats.get(10)!.last).toMatchObject({ id: 6, deleted: true });
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
