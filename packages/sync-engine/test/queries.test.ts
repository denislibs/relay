import { expect, test } from 'bun:test';
import { openDb } from '../src/idb';
import { computeQuery, diffResults } from '../src/queries';
import { Store } from '../src/store';
import { msg } from './fixtures';

const ME = 1, PEER = 2;
const fresh = async () => Store.open(await openDb('q-' + crypto.randomUUID()), ME);

test('first result is a snapshot, an unchanged result produces no patch', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 10, senderId: PEER }) });
  const r = computeQuery(s, { kind: 'chatList', limit: 50 });
  const p = diffResults(null, r)!;
  expect(p.op).toBe('snapshot');
  expect(p.order).toEqual(['c10']);
  expect(diffResults(r, computeQuery(s, { kind: 'chatList', limit: 50 }))).toBeNull();
});

test('chatList is newest first; a change sends one upsert and a new order only when it moved', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 10, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 2, chatId: 20, senderId: PEER }) });
  const r1 = computeQuery(s, { kind: 'chatList', limit: 50 });
  expect(r1.order).toEqual(['c20', 'c10']);

  s.applyUpdate({ type: 'readOwn', chatId: 20, upToId: 2 }); // меняется unread, порядок тот же
  const r2 = computeQuery(s, { kind: 'chatList', limit: 50 });
  const p2 = diffResults(r1, r2)!;
  expect(p2).toMatchObject({ op: 'diff', remove: [] });
  expect(p2.op === 'diff' && p2.upsert.map((i) => i.key)).toEqual(['c20']);
  expect(p2.op === 'diff' && p2.order).toBeUndefined();

  s.applyUpdate({ type: 'newMessage', message: msg({ id: 3, chatId: 10, senderId: PEER }) }); // c10 поднимается
  const p3 = diffResults(r2, computeQuery(s, { kind: 'chatList', limit: 50 }))!;
  expect(p3.op === 'diff' && p3.order).toEqual(['c10', 'c20']);
});

test('limit cuts the list and items falling out are removed', async () => {
  const s = await fresh();
  for (let i = 1; i <= 3; i++) s.applyUpdate({ type: 'newMessage', message: msg({ id: i, chatId: i * 10, senderId: PEER }) });
  const r1 = computeQuery(s, { kind: 'chatList', limit: 2 });
  expect(r1.order).toEqual(['c30', 'c20']);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 4, chatId: 10, senderId: PEER }) });
  const p = diffResults(r1, computeQuery(s, { kind: 'chatList', limit: 2 }))!;
  expect(p).toMatchObject({ op: 'diff', remove: ['c20'], order: ['c10', 'c30'] });
});

test('messages returns the last `limit` by sort; counters sum unread', async () => {
  const s = await fresh();
  for (let i = 1; i <= 5; i++) s.applyUpdate({ type: 'newMessage', message: msg({ id: i, chatId: 7, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 6, chatId: 8, senderId: PEER }) });
  const m = computeQuery(s, { kind: 'messages', chatId: 7, limit: 3 });
  expect([...m.items.values()].map((i) => i.id)).toEqual([3, 4, 5]);
  const c = computeQuery(s, { kind: 'counters' });
  expect([...c.items.values()][0]).toMatchObject({ key: 'counters', unreadChats: 2, unreadMessages: 6 });
});

test('service chat: peer.system and message.service reach the chat list and the feed', async () => {
  const s = await fresh();
  const last = { ...msg({ id: 5, chatId: 30, senderId: 99 }), service: { type: 'login_code' as const } };
  s.applySnapshot([{ id: 30, kind: 'direct', title: null, lastReadId: 0, unread: 1, last, peer: { id: 99, name: 'Relay', system: true } }]);
  const item = [...computeQuery(s, { kind: 'chatList', limit: 50 }).items.values()][0];
  expect(item.peer).toEqual({ id: 99, name: 'Relay', system: true });
  expect((item.last as { service?: unknown }).service).toEqual({ type: 'login_code' });
  const feed = [...computeQuery(s, { kind: 'messages', chatId: 30, limit: 10 }).items.values()];
  expect(feed[0].service).toEqual({ type: 'login_code' });
  // обычный личный чат — без пометки system
  s.applySnapshot([{ id: 31, kind: 'direct', title: null, lastReadId: 0, unread: 0, last: null, peer: { id: 2, name: 'Bob' } }]);
  const plain = computeQuery(s, { kind: 'chatList', limit: 50 }).items.get('c31')!;
  expect((plain.peer as { system?: boolean }).system).toBeUndefined();
});

/** База, которая считает транзакции записи, задевающие chats. */
const counted = async () => {
  const db = await openDb('q-' + crypto.randomUUID());
  const orig = db.transaction.bind(db);
  const n = { chats: 0 };
  db.transaction = ((names: string | string[], mode?: IDBTransactionMode) => {
    if (mode === 'readwrite' && [names].flat().includes('chats')) n.chats++;
    return orig(names, mode);
  }) as IDBDatabase['transaction'];
  return { s: await Store.open(db, ME), n };
};
const bob = (name: string) => ({ id: PEER, name, firstName: name, lastName: '', username: null, bio: null, birthday: null, phone: null, links: [] });

test('userUpdated renames the peer: the chat list row changes, the chats row in IndexedDB is not rewritten', async () => {
  const { s, n } = await counted();
  s.applySnapshot([{ id: 40, kind: 'direct', title: null, lastReadId: 0, unread: 0, last: null, peer: { id: PEER, name: 'Bob', photo: null } }]);
  await s.flush();
  const r1 = computeQuery(s, { kind: 'chatList', limit: 50 });
  expect(r1.items.get('c40')).toMatchObject({ title: 'Bob', peerId: PEER, peer: { id: PEER, name: 'Bob' } });
  expect(s.chats.get(40)).not.toHaveProperty('title');   // в строке чата — только peerId
  expect(s.users.get(PEER)?.name).toBe('Bob');            // собеседник из снимка — в people

  n.chats = 0;
  const photo = { id: 'p1', w: 10, h: 10 } as never;
  s.applyUpdate({ type: 'userUpdated', user: { ...bob('Bob New'), photo } }, 5);
  const p = diffResults(r1, computeQuery(s, { kind: 'chatList', limit: 50 }))!;
  expect(p.op === 'diff' && p.upsert[0]).toMatchObject({ key: 'c40', title: 'Bob New', photo, peer: { name: 'Bob New' } });
  await s.flush();
  expect(n.chats).toBe(0);
});

test('a chat first seen through a message: no title until the peer profile arrives', async () => {
  const s = await fresh();
  const wanted: number[] = [];
  s.wantUser = (id) => wanted.push(id);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 50, senderId: PEER }) });
  expect(s.unnamed()).toEqual([50]);   // ни собеседника, ни группы — чату нужен снимок
  expect(computeQuery(s, { kind: 'chatList', limit: 50 }).items.get('c50')).toMatchObject({ title: null, peer: null });

  // снимок чата знает собеседника, а профиля в people нет (например, вытеснен) — список просит профиль
  s.applyChats([{ id: 50, kind: 'direct', title: null, lastReadId: 0, unread: 1, last: null, peer: { id: PEER, name: 'Bob' } }]);
  expect(s.unnamed()).toEqual([]);
  s.users.delete(PEER);
  const r1 = computeQuery(s, { kind: 'chatList', limit: 50 });
  expect(r1.items.get('c50')).toMatchObject({ title: null, peerId: PEER });
  expect(wanted).toEqual([PEER]);
  s.applyUpdate({ type: 'userUpdated', user: bob('Bob') }, 3);
  const r2 = computeQuery(s, { kind: 'chatList', limit: 50 });
  expect(r2.items.get('c50')).toMatchObject({ title: 'Bob', peer: { id: PEER, name: 'Bob' } });
});

test('snapshot peer does not overwrite a fresher userUpdated', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'userUpdated', user: bob('Bob New') }, 9);
  s.applySnapshot([{ id: 60, kind: 'direct', title: null, lastReadId: 0, unread: 0, last: null, peer: { id: PEER, name: 'Bob Old' } }]);
  expect(computeQuery(s, { kind: 'chatList', limit: 50 }).items.get('c60')).toMatchObject({ title: 'Bob New' });
  expect(s.users.get(PEER)).toMatchObject({ name: 'Bob New', seq: 9 });
});

test('group title and photo come from chat.group', async () => {
  const s = await fresh();
  const group = { title: 'Дача', photo: { id: 'g' } } as never;
  s.applySnapshot([{ id: 70, kind: 'group', title: 'Дача', lastReadId: 0, unread: 0, last: null, peer: null, group }]);
  expect(computeQuery(s, { kind: 'chatList', limit: 50 }).items.get('c70')).toMatchObject({ title: 'Дача', photo: { id: 'g' }, peer: null });
  s.applyUpdate({ type: 'groupUpdated', chatId: 70, group: { ...(group as object), title: 'Дача 2' } as never });
  expect(computeQuery(s, { kind: 'chatList', limit: 50 }).items.get('c70')).toMatchObject({ title: 'Дача 2' });
});

test('1000 chats: one changed chat gives exactly one upsert; an unchanged base reuses every item', async () => {
  const s = await fresh();
  const list = Array.from({ length: 1000 }, (_, i) => ({
    id: 1000 + i, kind: 'direct' as const, title: null, lastReadId: 0, unread: 0,
    last: msg({ id: i + 1, chatId: 1000 + i, senderId: 3000 + i }), peer: { id: 3000 + i, name: 'U' + i },
  }));
  s.applySnapshot(list);
  const q = { kind: 'chatList' as const, limit: 2000 };
  const r1 = computeQuery(s, q);
  expect(r1.order).toHaveLength(1000);
  // неизменная база: ни одного нового элемента и ни одной сериализации — только подписи из версий строк
  let best = Infinity, r2 = r1;
  for (let k = 0; k < 3; k++) { const t0 = performance.now(); r2 = computeQuery(s, q); best = Math.min(best, performance.now() - t0); }
  expect(diffResults(r1, r2)).toBeNull();
  for (const k of r1.order) expect(r2.items.get(k)).toBe(r1.items.get(k)!);
  expect(best).toBeLessThan(2);

  s.applyUpdate({ type: 'readOwn', chatId: 1500, upToId: 501 });   // порядок тот же
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 5000, chatId: 1200, senderId: 3200 }) });   // c1200 наверх
  const p = diffResults(r2, computeQuery(s, q))!;
  expect(p.op === 'diff' && p.upsert.map((i) => i.key).sort()).toEqual(['c1200', 'c1500']);
  const r3 = computeQuery(s, q);
  s.setTyping(1300, 3300, true);
  const p2 = diffResults(r3, computeQuery(s, q))!;
  expect(p2.op === 'diff' && p2.upsert.map((i) => i.key)).toEqual(['c1300']);
  expect(p2.op === 'diff' && p2.upsert[0].typing).toBe(true);
});

test('chat row signature: a removed and re-created chat never repeats an old signature', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 10, senderId: PEER }) });
  const r1 = computeQuery(s, { kind: 'chatList', limit: 50 });
  s.removeChat(10);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 10, senderId: PEER, body: 'другое' }) });
  const r2 = computeQuery(s, { kind: 'chatList', limit: 50 });
  expect(r2.sig.get('c10')).not.toBe(r1.sig.get('c10'));
  expect(diffResults(r1, r2)).toMatchObject({ op: 'diff', upsert: [{ key: 'c10' }] });
});
