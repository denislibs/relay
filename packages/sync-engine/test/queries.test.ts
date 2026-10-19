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

// ---------- отрезки истории: сообщения через дыру в ленту не попадают ----------

const CH = 40;
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
// одно и то же сообщение с сервера — тот же clientId, сколько раз ни грузи
const server = new Map<number, ReturnType<typeof msg>>();
const page = (list: number[]) => list.map((id) => { let m = server.get(id); if (!m) server.set(id, m = msg({ id, chatId: CH, senderId: PEER })); return m; });
const feedIds = (s: Store, q: { limit: number; anchor?: { sort: number; side: 'start' | 'end' | 'center' } }) =>
  [...computeQuery(s, { kind: 'messages', chatId: CH, ...q }).items.values()].filter((i) => i.key !== '~window').map((i) => i.id);
const feedMeta = (s: Store, q: { limit: number; anchor?: { sort: number; side: 'start' | 'end' | 'center' } }) =>
  computeQuery(s, { kind: 'messages', chatId: CH, ...q }).items.get('~window');

test('history ranges: loose old messages stay behind the gap until history reaches them', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 200, chatId: CH, senderId: PEER }) });
  s.applyHistory(CH, page(ids(100, 199)), true, 200);
  expect(s.chats.get(CH)!.ranges).toEqual([[100, 200]]);
  s.addLoose(CH, page([10, 20]));   // медиа догрузили отдельно
  expect(s.chats.get(CH)!.ranges).toEqual([[100, 200]]);

  // лента у 100: старее есть, 10 и 20 не показаны
  expect(feedIds(s, { limit: 500 })).toEqual(ids(100, 200));
  expect(feedIds(s, { limit: 50, anchor: { sort: 100, side: 'end' } })).toEqual([100]);
  expect(feedMeta(s, { limit: 50, anchor: { sort: 100, side: 'end' } })).toMatchObject({ hasOlder: true, hasNewer: true });

  // история 21..99 — отрезки слились, 10 и 20 всё ещё за дырой
  s.applyHistory(CH, page(ids(21, 99)), true, 100);
  expect(s.chats.get(CH)!.ranges).toEqual([[21, 200]]);
  expect(feedIds(s, { limit: 500 })).toEqual(ids(21, 200));
  expect(feedMeta(s, { limit: 500 })).toMatchObject({ hasOlder: true, hasNewer: false, live: true });

  // дошли до начала — 10 и 20 в ленте, старее нет
  s.applyHistory(CH, page(ids(1, 20)), false, 21);
  expect(s.chats.get(CH)!.ranges).toEqual([[1, 200]]);
  expect(s.chats.get(CH)!.historyStart).toBe(true);
  expect(feedIds(s, { limit: 500 })).toEqual(ids(1, 200));
  expect(feedMeta(s, { limit: 500 })).toMatchObject({ hasOlder: false, hasNewer: false, live: true });
});

test('history ranges: window at the live end ignores a loose old message; new and pending messages join the live range', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 100, chatId: CH, senderId: PEER }) });
  s.applyHistory(CH, page(ids(90, 99)), true, 100);
  s.addLoose(CH, page([5]));
  expect(feedIds(s, { limit: 50 })).toEqual(ids(90, 100));
  expect(feedMeta(s, { limit: 50 })).toMatchObject({ hasOlder: true, hasNewer: false, live: true });
  // окно у старого края живого отрезка — 5 не подтягивается
  expect(feedIds(s, { limit: 3, anchor: { sort: 90, side: 'start' } })).toEqual([90, 91, 92]);
  expect(feedIds(s, { limit: 3, anchor: { sort: 92, side: 'end' } })).toEqual([90, 91, 92]);

  s.applyUpdate({ type: 'newMessage', message: msg({ id: 101, chatId: CH, senderId: PEER }) });
  s.addPending({ clientId: 'p1', chatId: CH, body: 'hi', replyToId: null, createdAt: Date.now(), failed: false });
  expect(s.chats.get(CH)!.ranges).toEqual([[90, 101]]);
  const live = feedIds(s, { limit: 50 });
  expect(live.slice(-2)).toEqual([101, null]);
  expect(live).not.toContain(5);
  s.ack('p1', 102, new Date().toISOString());
  expect(s.chats.get(CH)!.ranges).toEqual([[90, 102]]);
});

test('history ranges: a page fetched from the newest end before any range starts the live range', async () => {
  const s = await fresh();
  s.addLoose(CH, page([3]));
  expect(feedIds(s, { limit: 50 })).toEqual([]);
  expect(feedMeta(s, { limit: 50 })).toMatchObject({ hasOlder: true });
  s.applyHistory(CH, page(ids(40, 60)), true, null);
  expect(s.chats.get(CH)!.ranges).toEqual([[40, 60]]);
  expect(feedIds(s, { limit: 50 })).toEqual(ids(40, 60));
});

test('history ranges: kept with the chat across a restart; a cached chat from before ranges gets one range from its messages', async () => {
  const db = await openDb('q-' + crypto.randomUUID());
  const s = await Store.open(db, ME);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 300, chatId: CH, senderId: PEER }) });
  s.applyHistory(CH, page(ids(290, 299)), false, 300);
  await s.flush();
  const again = await Store.open(db, ME);
  expect(again.chats.get(CH)!.ranges).toEqual([[290, 300]]);
  expect(again.chats.get(CH)!.historyStart).toBe(true);

  // строка чата без ranges (кэш до отрезков): при загрузке — один отрезок по сообщениям, historyComplete → historyStart
  const t = db.transaction('chats', 'readwrite');
  const { ranges: _r, historyStart: _h, ...old } = again.chats.get(CH)!;
  t.objectStore('chats').put({ ...old, historyComplete: true });
  await new Promise((r) => { t.oncomplete = r; });
  const legacy = await Store.open(db, ME);
  await legacy.loadChatMessages(CH);
  expect(legacy.chats.get(CH)!.ranges).toEqual([[290, 300]]);
  expect(legacy.chats.get(CH)!.historyStart).toBe(true);
  expect(feedIds(legacy, { limit: 50 })).toEqual(ids(290, 300));
});

const summary = (last: ReturnType<typeof msg>) => ({ id: CH, kind: 'direct' as const, title: null, lastReadId: 0, unread: 0, last, peer: { id: PEER, name: 'b' } });

test('history ranges: a snapshot last ahead of the journal waits for it — one continuous live range, the feed never shrinks', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: page([110])[0] });
  s.applyHistory(CH, page(ids(100, 109)), true, 110);
  s.applyChats([summary(page([110])[0])]);   // уже в отрезке — ничего
  expect(s.chats.get(CH)!.ranges).toEqual([[100, 110]]);
  expect(s.chats.get(CH)!.snapLast).toBeUndefined();
  // страница диалогов обогнала журнал: 150 ещё не пришло журналом
  s.applyChats([summary(page([150])[0])]);
  expect(s.chats.get(CH)!.ranges).toEqual([[100, 110]]);
  expect(s.chats.get(CH)!.snapLast).toBe(150);
  expect(feedIds(s, { limit: 50 })).toEqual(ids(100, 110));   // окно не схлопнулось до одного сообщения
  // журнал доставил — тот же живой отрезок продлился
  s.applyUpdate({ type: 'newMessage', message: page([150])[0] });
  expect(s.chats.get(CH)!.ranges).toEqual([[100, 150]]);
  expect(s.chats.get(CH)!.snapLast).toBeUndefined();
  expect(feedIds(s, { limit: 50 })).toEqual([...ids(100, 110), 150]);
  s.settleSnapshots(new Map([[CH, 150]]));   // конец догонки: ждать уже нечего
  expect(s.chats.get(CH)!.ranges).toEqual([[100, 150]]);
});

test('history ranges: a snapshot last the journal never delivers (rejoin gap) gets its own range after the catch-up', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: page([110])[0] });
  s.applyHistory(CH, page(ids(100, 109)), true, 110);
  s.applyChats([summary(page([150])[0])]);
  const pending = s.pendingSnapshots();   // догонка началась
  s.applyChats([summary(page([160])[0])]);   // пришло во время догонки — ждёт следующей
  s.settleSnapshots(pending);
  expect(s.chats.get(CH)!.ranges).toEqual([[100, 110]]);
  expect(s.chats.get(CH)!.snapLast).toBe(160);
  s.settleSnapshots(s.pendingSnapshots());   // и следующая догонка его не принесла
  expect(s.chats.get(CH)!.ranges).toEqual([[100, 110], [160, 160]]);
  expect(s.chats.get(CH)!.seed).toBe(160);
  expect(feedIds(s, { limit: 50 })).toEqual([160]);
  expect(feedMeta(s, { limit: 50 })).toMatchObject({ hasOlder: true, live: true });
  expect(feedIds(s, { limit: 50, anchor: { sort: 105, side: 'center' } })).toEqual(ids(100, 110));   // через дыру не тянет
  expect(feedMeta(s, { limit: 50, anchor: { sort: 105, side: 'center' } })).toMatchObject({ hasNewer: true, live: false });
  // страница перед seed дотянулась до старого отрезка — слились, seed проверен
  s.applyHistory(CH, page(ids(105, 159)), true, 160);
  expect(s.chats.get(CH)!.ranges).toEqual([[100, 160]]);
  expect(s.chats.get(CH)!.seed).toBeUndefined();
});

test('history ranges: a history page answered after a reset is dropped', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 60, chatId: CH, senderId: PEER }) });
  const gen = s.resetGen;
  s.resetForSnapshot();
  s.applyHistory(CH, page(ids(40, 59)), true, 60, gen);
  expect(s.chats.get(CH)!.ranges).toEqual([]);
  expect(feedIds(s, { limit: 50 })).toEqual([]);
  expect(s.chatMessages(CH)).toHaveLength(0);
});

test('history ranges: own message acked below a snapshot-seeded live start stays in the feed; pages before seed fill the messages between', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: page([100])[0] });
  s.applyHistory(CH, page(ids(90, 99)), true, 100);
  s.applyChats([summary(page([200])[0])]);
  s.settleSnapshots(s.pendingSnapshots());   // дыра: живой отрезок начат снимком
  expect(s.chats.get(CH)!.ranges).toEqual([[90, 100], [200, 200]]);
  s.addPending({ clientId: 'own', chatId: CH, body: 'моё', replyToId: null, createdAt: Date.now(), failed: false });
  s.ack('own', 150, new Date().toISOString());
  expect(s.chats.get(CH)!.ranges).toEqual([[90, 100], [150, 200]]);
  expect(s.chats.get(CH)!.seed).toBe(200);   // между 150 и 200 ещё не проверено
  expect(feedIds(s, { limit: 50 })).toEqual([150, 200]);
  // ниже конца предыдущего отрезка — не трогаем (отрезки не пересекаются)
  s.addPending({ clientId: 'own2', chatId: CH, body: 'ещё', replyToId: null, createdAt: Date.now(), failed: false });
  s.ack('own2', 95, new Date().toISOString());
  expect(s.chats.get(CH)!.ranges).toEqual([[90, 100], [150, 200]]);
  // страница перед seed не дошла до 150 — проверка продолжается ниже; следующая дошла — seed снят, ничего не пропущено
  s.applyHistory(CH, page(ids(170, 199)), true, 200);
  expect(s.chats.get(CH)!.seed).toBe(170);
  expect(feedIds(s, { limit: 100 })).toEqual([150, ...ids(170, 200)]);
  s.applyHistory(CH, [msg({ id: 150, chatId: CH, senderId: ME, clientId: 'own' }), ...page(ids(151, 169))], true, 170);
  expect(s.chats.get(CH)!.seed).toBeUndefined();
  expect(s.chats.get(CH)!.ranges).toEqual([[90, 100], [150, 200]]);
  expect(feedIds(s, { limit: 100 })).toEqual(ids(150, 200));
});

test('history ranges: a newer page from an old range merges with the next range when it reaches it', async () => {
  const s = await fresh();
  s.applyUpdate({ type: 'newMessage', message: page([300])[0] });
  s.applyHistory(CH, page(ids(290, 299)), true, 300);
  s.applyHistory(CH, page(ids(250, 255)), true, 256);   // старый отрезок сам по себе (как после вытеснения)
  expect(s.chats.get(CH)!.ranges).toEqual([[250, 255], [290, 300]]);
  expect(feedMeta(s, { limit: 50, anchor: { sort: 253, side: 'center' } })).toMatchObject({ hasNewer: true, live: false });
  s.applyNewerHistory(CH, page(ids(256, 270)), true, 255);
  expect(s.chats.get(CH)!.ranges).toEqual([[250, 270], [290, 300]]);
  s.applyNewerHistory(CH, page(ids(271, 292)), true, 270);
  expect(s.chats.get(CH)!.ranges).toEqual([[250, 300]]);
  expect(feedMeta(s, { limit: 100, anchor: { sort: 253, side: 'center' } })).toMatchObject({ hasNewer: false, live: true });
});
