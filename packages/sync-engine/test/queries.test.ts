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
