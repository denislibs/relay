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

const user = (id: number, bio: string) => ({ id, name: 'Б' + id, firstName: 'Б', lastName: '', username: null, bio, birthday: null, phone: null, links: [] });
const contact = (id: number, firstName: string, seq: number) => ({ userId: id, firstName, lastName: '', note: '', user: user(id, ''), seq });

test('a person at seq 12 survives a stale snapshot at seq 11 and a restart', async () => {
  const name = 'store-' + crypto.randomUUID();
  const s = await Store.open(await openDb(name), ME);
  s.applyUpdate({ type: 'userUpdated', user: user(2, 'свежее') }, 12);
  s.profile.applyUser(user(2, 'старое'), 11);   // ответ GET /users/:id со снимком seq 11
  expect(s.users.get(2)?.bio).toBe('свежее');
  await s.flush();
  const again = await Store.open(await openDb(name), ME);
  expect(again.users.get(2)).toMatchObject({ bio: 'свежее', seq: 12 });
  again.profile.applyUser(user(2, 'старое'), 11);   // после перезапуска — то же правило
  expect(again.users.get(2)?.bio).toBe('свежее');
  again.profile.applyUser(user(2, 'новее'), 13);
  expect(again.users.get(2)?.bio).toBe('новее');
});

test('editing one of 1000 contacts writes one contacts row', async () => {
  const s = await Store.open(await openDb('store-' + crypto.randomUUID()), ME);
  s.contacts.applySnapshot(Array.from({ length: 1000 }, (_, i) => contact(100 + i, 'К' + i, 5)), 5);
  await s.flush();
  expect(s.contacts.table.rows.size).toBe(1000);
  const counts: number[] = [];
  s.onFlush = (keys) => counts.push(keys);
  s.contacts.applyContact(contact(500, 'Правка', 6));
  await s.flush();
  expect(counts).toEqual([1]);
  // ещё один снимок без перемен ничего, кроме общего пола, не пишет
  s.contacts.applySnapshot(Array.from({ length: 1000 }, (_, i) => (i === 400 ? contact(500, 'Правка', 7) : contact(100 + i, 'К' + i, 7))), 7);
  await s.flush();
  expect(counts.slice(1).every((n) => n <= 2)).toBe(true);
});

test('contacts and the block list survive a restart; removals are deleted from the stores', async () => {
  const name = 'store-' + crypto.randomUUID();
  const s = await Store.open(await openDb(name), ME);
  s.contacts.applySnapshot([contact(2, 'Боря', 3), contact(3, 'Вася', 3)], 3);
  s.blocks.applySnapshot([], 3);
  s.blocks.applyBlocked({ userId: 2, user: user(2, ''), at: '2026-01-01T00:00:00.000Z', seq: 4 });
  s.blocks.applyBlocked({ userId: 3, user: user(3, ''), at: '2026-01-02T00:00:00.000Z', seq: 4 });
  s.contacts.applyRemoved(3, 5);
  await s.flush();
  let again = await Store.open(await openDb(name), ME);
  expect([...again.contacts.table.rows.keys()]).toEqual([2]);
  expect(again.contacts.loaded).toBe(true);
  expect([...again.blocks.table.rows.keys()].sort()).toEqual([2, 3]);
  expect(again.blocks.loaded).toBe(true);
  // старая запись журнала после перезапуска не воскрешает и не откатывает
  expect(again.contacts.applyContact(contact(2, 'Старое', 3))).toBe(false);
  again.blocks.applyUnblocked(2, 6);
  expect(again.blocks.applyBlocked({ userId: 2, user: user(2, ''), at: 'x', seq: 5 })).toBe(false);   // запоздавшая блокировка
  await again.flush();
  again = await Store.open(await openDb(name), ME);
  expect([...again.blocks.table.rows.keys()]).toEqual([3]);
});

test('a deleted message keeps no content in memory or IndexedDB (loaded and unloaded paths); its quote and tabs go too', async () => {
  const name = 'store-' + crypto.randomUUID();
  const db = await openDb(name);
  const s = await Store.open(db, ME);
  const photo = { id: 'f1', kind: 'photo' as const, mime: 'image/png', name: 'секрет.png', size: 1, w: 1, h: 1 };
  const rich = (id: number) => msg({
    id, chatId: 7, senderId: PEER, kind: 'photo', body: 'тайна https://x.y', attachment: photo,
    entities: [{ type: 'bold', offset: 0, length: 5 }], link: { url: 'https://x.y', title: 'тайна' },
    blocks: [{ type: 'p', text: 'тайна' }], fwdFrom: { userId: 9, name: 'Кто-то', chatId: 3, messageId: 4, at: new Date().toISOString() },
  } as never);
  s.applyUpdate({ type: 'newMessage', message: rich(10) });
  s.applyUpdate({ type: 'newMessage', message: rich(11) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 12, chatId: 7, senderId: PEER, body: 'последнее' }) });
  s.addQuotes(7, [rich(10) as never]);
  await s.flush();
  const check = (m: Record<string, unknown> | undefined) => {
    expect(m).toBeDefined();
    expect(m!.deleted).toBe(true);
    expect(m!.body).toBe('');
    for (const k of ['attachment', 'link', 'blocks', 'fwdFrom', 'todo']) expect(m![k] ?? null).toBeNull();
    expect(m!.entities).toEqual([]);
    expect(m!.tab).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain('тайна');
    expect(JSON.stringify(m)).not.toContain('секрет');
  };
  const rows = async () => new Promise<Record<string, unknown>[]>((res) => { const r = db.transaction('messages').objectStore('messages').getAll(); r.onsuccess = () => res(r.result); });
  const terms = async () => new Promise<{ term: string; sort: number }[]>((res) => { const r = db.transaction('terms').objectStore('terms').getAll(); r.onsuccess = () => res(r.result); });

  // загруженное: в памяти и после записи
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 10 });
  check(s.messageById(7, 10) as never);
  expect(s.quoteFor(7, 10)).toBeUndefined();
  await s.flush();
  check((await rows()).find((r) => r.id === 10));
  expect((await terms()).some((t) => t.sort === 10)).toBe(false);

  // незагруженное: правка строки в IDB
  const cold = await Store.open(db, ME);
  cold.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 11 });
  await cold.flush();
  check((await rows()).find((r) => r.id === 11));
  expect((await terms()).some((t) => t.sort === 11)).toBe(false);
  await cold.loadChatMessages(7);
  check(cold.messageById(7, 11) as never);

  // удалённое, пришедшее с сервера (страница истории) — тоже без содержимого
  cold.applyHistory(7, [{ ...rich(5), deleted: true, attachment: null } as never], true, 10);
  check(cold.messageById(7, 5) as never);
});
