import { expect, test } from 'bun:test';
import { openDb } from '../src/idb';
import { computeQuery } from '../src/queries';
import { Store } from '../src/store';
import { msg } from './fixtures';

// Удаление как в Telegram: messageDeleted убирает сообщение целиком — из кэша, ленты, уведомлений; цитаты на него —
// «Удалённое сообщение». Только копия поста в группе обсуждения остаётся пометкой: шапка треда «Пост удалён».

const ME = 1, PEER = 2;
const fresh = async () => Store.open(await openDb('del-' + crypto.randomUUID()), ME);
const feedIds = (s: Store, chatId: number) => {
  const r = computeQuery(s, { kind: 'messages', chatId, limit: 50 });
  return r.order.filter((k) => !k.startsWith('~')).map((k) => r.items.get(k)!.id);
};

test('removed from the feed; the range keeps its hole; a later page still merges', async () => {
  const s = await fresh();
  s.applyHistory(7, [1, 2, 3, 4].map((id) => msg({ id, chatId: 7, senderId: PEER })), true, null);
  expect(s.chats.get(7)!.ranges).toEqual([[1, 4]]);
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 3 });
  expect(feedIds(s, 7)).toEqual([1, 2, 4]);
  expect(s.messageById(7, 3)).toBeUndefined();
  expect(s.chats.get(7)!.ranges).toEqual([[1, 4]]);   // отрезок — интервал id: дыра на месте удалённого ему не мешает
  // страница новее и страница старше, где удалённых уже нет (сервер их не отдаёт), сливаются как обычно
  s.applyNewerHistory(7, [msg({ id: 6, chatId: 7, senderId: PEER })], false, 4);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 7, chatId: 7, senderId: PEER }) });
  expect(s.chats.get(7)!.ranges).toEqual([[1, 7]]);
  expect(feedIds(s, 7)).toEqual([1, 2, 4, 6, 7]);
  const r = computeQuery(s, { kind: 'messages', chatId: 7, limit: 50 }).items.get('~window')!;
  expect(r).toMatchObject({ hasNewer: false, live: true });
});

test('unread: a deleted unread incoming message is subtracted; read, own or unknown are not', async () => {
  const s = await fresh();
  for (let i = 1; i <= 4; i++) s.applyUpdate({ type: 'newMessage', message: msg({ id: i, chatId: 7, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 5, chatId: 7, senderId: ME }) });
  s.applyUpdate({ type: 'readOwn', chatId: 7, upToId: 1 });
  expect(s.chats.get(7)!.unread).toBe(3);
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 3 });   // непрочитанное чужое
  expect(s.chats.get(7)!.unread).toBe(2);
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 1 });   // прочитанное
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 5 });   // своё
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 3 });   // повтор
  expect(s.chats.get(7)!.unread).toBe(2);
  // чьё — неизвестно (нет в кэше), новее прочитанного: число спросим у сервера
  const wanted: number[] = [];
  s.wantRow = (id) => wanted.push(id);
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 99 });
  expect(s.chats.get(7)!.unread).toBe(2);
  expect(wanted).toEqual([7]);
});

test('chat last falls back to the previous message, also from an unloaded cache', async () => {
  const db = await openDb('del-' + crypto.randomUUID());
  const s = await Store.open(db, ME);
  for (let i = 1; i <= 3; i++) s.applyUpdate({ type: 'newMessage', message: msg({ id: i, chatId: 7, senderId: PEER }) });
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 3 });
  expect(s.chats.get(7)!.last).toMatchObject({ id: 2, deleted: false });
  await s.flush();
  const again = await Store.open(db, ME);
  await again.loadChatMessages(7);   // как движок перед событиями закрытого чата (patchedChats)
  again.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 2 });
  expect(again.chats.get(7)!.last).toMatchObject({ id: 1, body: 'text 1' });
  expect(computeQuery(again, { kind: 'chatList', limit: 5 }).items.get('c7')!.last).toMatchObject({ id: 1, deleted: false });
});

test('quotes: a reply to the deleted shows «Удалённое сообщение» at once; a source the server no longer returns is a deleted stub', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 7, senderId: PEER, body: 'исходник' }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 2, chatId: 7, senderId: ME, body: 'ответ', replyToId: 1 }) });
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 1 });
  const r = computeQuery(s, { kind: 'messages', chatId: 7, limit: 50 });
  const reply = [...r.items.values()].find((m) => m.id === 2)!;
  expect(reply.reply).toMatchObject({ id: 1, deleted: true, body: '', senderId: PEER });
  expect(s.quoteWants.size).toBe(0);   // спрашивать сервер не о чем

  // исходник вне кэша: спросили — сервер не вернул (удалён) — заглушка
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 5, chatId: 7, senderId: PEER, body: 'на старое', replyToId: 4 }) });
  computeQuery(s, { kind: 'messages', chatId: 7, limit: 50 });
  expect([...(s.quoteWants.get(7) ?? [])]).toEqual([4]);
  s.addQuotes(7, [], [4]);
  expect(s.quoteFor(7, 4)).toMatchObject({ id: 4, deleted: true, body: '' });
});

test('a notification of the deleted message is withdrawn', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 7, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 2, chatId: 7, senderId: PEER }) });
  expect(s.notifications.map((n) => n.id)).toEqual([1, 2]);
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 2 });
  expect(s.notifications.map((n) => n.id)).toEqual([1]);
});

test('post copy in the discussion group: gone from the group feed and the row preview, stays as the thread header «Пост удалён»; deleted comments vanish', async () => {
  const s = await fresh();
  const G = 8, CH = 9;
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: G, senderId: PEER, body: 'до' }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 2, chatId: G, senderId: PEER, body: 'пост', post: true, origin: { chatId: CH, id: 50 } }) });
  s.applyThreadPage(G, 2, null, [3, 4].map((id) => msg({ id, chatId: G, senderId: PEER, threadId: 2, body: 'коммент ' + id })), false, null, 'older');
  s.applyUpdate({ type: 'messageDeleted', chatId: G, id: 4 });
  s.applyUpdate({ type: 'messageDeleted', chatId: G, id: 3 });
  expect(s.chats.get(G)!.last).toMatchObject({ id: 2, body: 'пост' });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 6, chatId: G, senderId: PEER, threadId: 2, body: 'живой' }) });
  s.applyUpdate({ type: 'messageDeleted', chatId: G, id: 6 });
  s.applyUpdate({ type: 'messageDeleted', chatId: G, id: 2 });
  expect(feedIds(s, G)).toEqual([1]);
  expect(s.chats.get(G)!.last).toMatchObject({ id: 1, body: 'до' });   // превью — предыдущее, не «удалено»
  const t = computeQuery(s, { kind: 'thread', chatId: G, threadId: 2, limit: 50 });
  const hk = t.items.get('~thread')!.header as string;
  expect(typeof hk).toBe('string');
  const header = t.items.get(hk)!;
  expect(header).toMatchObject({ id: 2, deleted: true, body: '' });
  expect(t.order.filter((k) => !k.startsWith('~')).map((k) => t.items.get(k)!.id)).toEqual([2]);   // шапка; удалённых комментариев нет
  // шапка треда, пришедшая с сервера удалённой, в превью группы не попадает
  s.applyThreadPage(G, 2, msg({ id: 2, chatId: G, senderId: PEER, body: '', deleted: true, post: true, origin: { chatId: CH, id: 50 } }), [], false, null, 'older');
  expect(s.chats.get(G)!.last).toMatchObject({ id: 1 });
});
