import { expect, test } from 'bun:test';
import { openDb } from '../src/idb';
import { Store } from '../src/store';
import { msg } from './fixtures';

const ME = 1, PEER = 2;

test('applied updates survive a reopen together with lastSeq', async () => {
  const name = 'store-' + crypto.randomUUID();
  const s = await Store.open(await openDb(name), ME);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 10, chatId: 7, senderId: PEER, body: 'привет' }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 11, chatId: 7, senderId: PEER, body: 'как дела' }) });
  s.applyUpdate({ type: 'readOwn', chatId: 7, upToId: 10 });
  s.lastSeq = 3;
  await s.flush();

  const again = await Store.open(await openDb(name), ME);
  expect(again.lastSeq).toBe(3);
  const chat = again.chats.get(7)!;
  expect(chat).toMatchObject({ lastReadId: 10, unread: 1, knownMaxId: 11 });
  expect(chat.last?.body).toBe('как дела');
  await again.loadChatMessages(7);
  expect(again.chatMessages(7).map((m) => m.id)).toEqual([10, 11]);
});

test('a repeated newMessage neither duplicates nor double counts unread', async () => {
  const s = await Store.open(await openDb('store-' + crypto.randomUUID()), ME);
  const m = msg({ id: 5, chatId: 1, senderId: PEER });
  s.applyUpdate({ type: 'newMessage', message: m });
  s.applyUpdate({ type: 'newMessage', message: m });
  expect(s.chats.get(1)!.unread).toBe(1);
  expect(s.chatMessages(1)).toHaveLength(1);
});

test('own messages never count as unread, and readBy turns them read', async () => {
  const s = await Store.open(await openDb('store-' + crypto.randomUUID()), ME);
  const mine = msg({ id: 3, chatId: 1, senderId: ME });
  s.applyUpdate({ type: 'newMessage', message: mine });
  expect(s.chats.get(1)!.unread).toBe(0);
  expect(s.chatMessages(1)[0].status).toBe('sent');
  s.applyUpdate({ type: 'readBy', chatId: 1, userId: PEER, upToId: 3 });
  expect(s.chatMessages(1)[0].status).toBe('read');
  expect(s.chats.get(1)!.last?.status).toBe('read');
});

test('ids already covered by a snapshot do not bump unread again', async () => {
  const s = await Store.open(await openDb('store-' + crypto.randomUUID()), ME);
  const last = msg({ id: 9, chatId: 4, senderId: PEER });
  s.applySnapshot([{ id: 4, kind: 'direct', title: null, lastReadId: 0, unread: 3, last }]);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 8, chatId: 4, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: last });
  expect(s.chats.get(4)!.unread).toBe(3);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 12, chatId: 4, senderId: PEER }) });
  expect(s.chats.get(4)!.unread).toBe(4);
});

test('pending message sorts after real ones and keeps its key through ack', async () => {
  const s = await Store.open(await openDb('store-' + crypto.randomUUID()), ME);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 20, chatId: 2, senderId: PEER }) });
  const clientId = crypto.randomUUID();
  s.addPending({ clientId, chatId: 2, body: 'ещё', replyToId: null, createdAt: Date.now(), failed: false });
  expect(s.chatMessages(2).map((m) => m.status)).toEqual(['sent', 'pending']);
  s.ack(clientId, 21, new Date().toISOString());
  expect(s.chatMessages(2).map((m) => [m.key, m.id, m.status])).toEqual([[expect.any(String), 20, 'sent'], [clientId, 21, 'sent']]);
  expect(s.outbox.has(clientId)).toBe(false);
});
