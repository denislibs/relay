import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { Engine } from '../src/engine';
import { evict, EVICT_LIMITS, trimRanges, type EvictKeep } from '../src/evict';
import { openDb, termsOf } from '../src/idb';
import { Store } from '../src/store';
import { PENDING_BASE, type LocalChat, type LocalMessage } from '../src/types';
import { MediaLoader } from '../src/media';
import { msg, resetDb, startTestServer, watchInto } from './helpers';

const ME = 1;
const keepNone = (): EvictKeep => ({ windows: new Map(), people: new Set(), members: new Set(), busy: new Set() });
const all = <T>(db: IDBDatabase, store: string) => new Promise<T[]>((res, rej) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result as T[]); r.onerror = () => rej(r.error); });
const count = (db: IDBDatabase, store: string) => new Promise<number>((res, rej) => { const r = db.transaction(store).objectStore(store).count(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const row = (chatId: number, id: number, p: Partial<LocalMessage> = {}): LocalMessage => ({
  key: `k${id}`, clientId: `k${id}`, id, chatId, senderId: 2, body: '', replyToId: null, createdAt: new Date(1_700_000_000_000 + id).toISOString(),
  status: 'sent', sort: id, kind: 'text', attachment: null, entities: [], reactions: [], ...p,
});
const chatRow = (id: number, last: LocalMessage, p: Partial<LocalChat> = {}): LocalChat => ({
  id, kind: 'direct', lastReadId: 0, unread: 0, knownMaxId: last.id!, peerReadUpTo: 0, ranges: [], peerId: null, last, lastAt: last.createdAt, ...p,
});

/** Кэш прямо в IDB (как после прошлых запусков): чаты, сообщения и слова указателя. */
async function seed(name: string, chats: { chat: LocalChat; msgs: LocalMessage[] }[]): Promise<IDBDatabase> {
  const db = await openDb(name);
  const t = db.transaction(['chats', 'messages', 'terms'], 'readwrite');
  for (const { chat, msgs } of chats) {
    t.objectStore('chats').put(chat);
    for (const m of msgs) {
      t.objectStore('messages').put(m);
      for (const term of termsOf(m)) t.objectStore('terms').put({ term, chatId: m.chatId, sort: m.sort, key: m.key });
    }
  }
  await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  return db;
}

test('ranges shrink around evicted messages and never claim what is gone', () => {
  // [1..1000] подряд, оставили от 501 и закреплённое 100: два отрезка
  const removed = Array.from({ length: 500 }, (_, i) => i + 1).filter((s) => s !== 100);
  expect(trimRanges([[1, 1000]], 501, removed, [100])).toEqual([[100, 100], [501, 1000]]);
  // ничего не стёрто в отрезке — он прежний; отрезок целиком стёрт — пропал
  const low = [1, 2, 3, 4, 5, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20];
  expect(trimRanges([[1, 5], [10, 20], [30, 40]], 30, low, [12])).toEqual([[12, 12], [30, 40]]);
  expect(trimRanges([[10, 20], [30, 40]], 15, [10, 12], [])).toEqual([[15, 20], [30, 40]]);
});

/**
 * Большой кэш: 120 чатов по P (чат 7 — P + 20), всего ≥ 120·P; пределы — согласованные, делённые на k.
 * k = 1 — ровно 60 000 → ≤ 50 000. fake-indexeddb стирает строку за время, растущее с размером хранилища
 * (~20 мс при 60 000), поэтому полный размер — по RELAY_SLOW_TESTS=1 (минуты), в обычном прогоне — k = 10.
 */
async function bigCase(k: number) {
  const P = EVICT_LIMITS.perChat / k, T = EVICT_LIMITS.total / k, S = EVICT_LIMITS.stale / k;
  const limits = { ...EVICT_LIMITS, perChat: P, total: T, stale: S };
  const name = 'evict-' + crypto.randomUUID();
  const chats: { chat: LocalChat; msgs: LocalMessage[] }[] = [];
  for (let c = 1; c <= 120; c++) {
    const n = c === 7 ? P + 20 : P, base = c * 1000;
    const msgs = Array.from({ length: n }, (_, j) => row(c, base + j + 1));
    if (c === 120) {
      for (let j = 5; j < 15; j++) msgs[j].body = 'alpha bravo';                           // уйдут — их слова тоже
      msgs[n - 1].body = 'omega';                                                         // последнее — останется
      msgs[4] = { ...msgs[4], kind: 'photo', attachment: { id: 'a1', kind: 'photo', mime: 'image/jpeg', name: 'p.jpg', size: 1, w: 1, h: 1 } };
    }
    const last = msgs[n - 1];
    chats.push({ chat: chatRow(c, last, {
      ranges: [[base + 1, base + n]], historyStart: true,
      ...(c <= 30 ? { openedAt: Date.now() - c * 1000 } : {}),   // недавно открытые — остаются по P
      // 120 — самый давний (последнее сообщение старее всех): урезается первым
      ...(c === 120 ? { pinned: [base + 3], mediaDone: { media: base + 1 }, lastAt: '2000-01-01T00:00:00.000Z' } : {}),
    }), msgs });
  }
  const db = await seed(name, chats);
  const s = await Store.open(db, ME);
  const clientId = crypto.randomUUID();
  s.addPending({ clientId, chatId: 60, body: 'unsent', createdAt: Date.now(), replyToId: null, failed: false });
  await s.flush();
  const before = 120 * P + 21;
  expect(await count(db, 'messages')).toBe(before);
  if (k === 1) expect(before).toBeGreaterThanOrEqual(60_000);

  // в чате 7 открыто окно в старой истории: 7001..7005
  const keep = keepNone();
  keep.windows.set(7, new Set(Array.from({ length: 5 }, (_, j) => `k${7001 + j}`)));
  const t0 = Date.now();
  const st = await evict(s, db, () => keep, limits);
  const msgs = await all<LocalMessage>(db, 'messages');
  expect(msgs.length).toBeLessThanOrEqual(T);
  expect(st.messages).toBe(before - msgs.length);
  const keys = new Set(msgs.map((m) => m.key));
  for (let c = 1; c <= 120; c++) expect(keys.has(s.chats.get(c)!.last!.key)).toBe(true);   // последнее каждого чата
  expect(keys.has(clientId)).toBe(true);                                                   // неотправленное
  expect(msgs.find((m) => m.key === clientId)!.sort).toBeGreaterThanOrEqual(PENDING_BASE);
  expect(keys.has('k120003')).toBe(true);                                                  // закреплённое
  for (let j = 0; j < 5; j++) expect(keys.has(`k${7001 + j}`)).toBe(true);                // открытое окно

  // недавно открытые — последние P; чат 7 — P + окно; давно не открытый (120) — S
  const per = (c: number) => msgs.filter((m) => m.chatId === c && m.id != null).length;
  expect(per(1)).toBe(P);
  expect(per(7)).toBe(P + 5);
  expect(per(120)).toBe(S + 1);   // S + закреплённое

  // отрезки: чат 7 — окно отдельно (оно от начала истории — начало остаётся), последние P подряд
  expect(s.chats.get(7)!.ranges).toEqual([[7001, 7005], [7021, 7020 + P]]);
  expect(s.chats.get(7)!.historyStart).toBe(true);
  // чат 120: начало стёрто — история уже не от начала
  expect(s.chats.get(120)!.ranges).toEqual([[120003, 120003], [120000 + P - S + 1, 120000 + P]]);
  expect(s.chats.get(120)!.historyStart).toBeUndefined();
  expect(s.chats.get(1)!.ranges).toEqual([[1001, 1000 + P]]);
  expect(s.chats.get(1)!.historyStart).toBe(true);
  // вкладка медиа потеряла сообщения — заново с сервера
  expect(s.chats.get(120)!.mediaDone).toBeUndefined();
  // слова стёртых сообщений — тоже; последнего — на месте
  const terms = await all<{ term: string; chatId: number }>(db, 'terms');
  expect(terms.filter((r) => r.term === 'alpha' || r.term === 'bravo')).toEqual([]);
  expect(terms.filter((r) => r.term === 'omega')).toHaveLength(1);
  // строки чатов на диске — с новыми отрезками (переживут перезапуск)
  const again = await Store.open(await openDb(name), ME);
  expect(again.chats.get(7)!.ranges).toEqual([[7001, 7005], [7021, 7020 + P]]);
  console.log(`evict ${before} → ${msgs.length}: ${Date.now() - t0} ms`);
}

test('big cache (limits / 10): last, unsent, pinned and the open window intact; ranges and terms follow', () => bigCase(10), 60_000);
test.if(!!process.env.RELAY_SLOW_TESTS)('60 000 messages → at most 50 000 left (full size, slow on fake-indexeddb)', () => bigCase(1), 900_000);

test('loaded chat: evicted messages leave memory too', async () => {
  const name = 'evict-' + crypto.randomUUID();
  const msgs = Array.from({ length: 30 }, (_, j) => row(5, 100 + j, { body: 'w' + j }));
  const db = await seed(name, [{ chat: chatRow(5, msgs[29], { ranges: [[100, 129]] }), msgs }]);
  const s = await Store.open(db, ME);
  s.applyUpdate({ type: 'messageDeleted', chatId: 5, id: 101 } as never);   // не загружен — правка строки в очереди
  await s.loadChatMessages(5);
  s.applyUpdate({ type: 'messageEdited', chatId: 5, id: 102, body: 'changed', editedAt: new Date().toISOString() } as never);
  await evict(s, db, keepNone, { ...EVICT_LIMITS, perChat: 10 });
  expect(s.chatMessages(5).map((m) => m.id)).toEqual(Array.from({ length: 10 }, (_, j) => 120 + j));
  expect(s.chats.get(5)!.ranges).toEqual([[120, 129]]);
  expect(s.termsDirty).toBe(false);
  expect((await all<LocalMessage>(db, 'messages')).length).toBe(10);
});

test('people: over the limit, unreferenced are removed with their profile lists; referenced stay', async () => {
  const name = 'evict-' + crypto.randomUUID();
  const msgs = [row(9, 10, { senderId: 50, service: { type: 'members_added', data: { users: [{ id: 54, name: 'x' }] } } }),
    row(9, 11, { senderId: 51, reactions: [{ userId: 52, emoji: '👍' }], kind: 'todo', todo: { title: 't', items: [], othersCanAppend: false, othersCanComplete: true, completions: [{ id: 1, by: 55, at: '' }] } })];
  const db = await seed(name, [{ chat: chatRow(9, msgs[1], { ranges: [[10, 11]], kind: 'group', group: { members: 3 } as never }), msgs },
    { chat: chatRow(10, row(10, 20, { senderId: 60 }), { peerId: 60, ranges: [[20, 20]] }), msgs: [row(10, 20, { senderId: 60 })] }]);
  const s = await Store.open(db, ME);
  for (let id = 50; id <= 80; id++) s.profile.applyPeer({ id, name: 'u' + id });
  s.members.applySnapshot(9, [{ userId: 70, role: 'member', rank: null }], 0);
  s.contacts.table.put(71, { userId: 71, firstName: 'c', lastName: '' } as never, 0);
  s.blocks.table.put(72, { userId: 72 } as never, 0);
  s.quotes.set('9:5', { id: 5, sort: 5, body: '', senderId: 73 });
  s.profileLists.applyMusic(80, [{ id: 't1', title: 't', duration: 1, mime: 'audio/mpeg', addedAt: new Date().toISOString() }]);
  s.profileLists.applyMusic(74, [{ id: 't2', title: 't', duration: 1, mime: 'audio/mpeg', addedAt: new Date().toISOString() }]);
  await s.flush();
  const keep = keepNone();
  keep.people.add(74);   // интерфейс подписан на человека
  const st = await evict(s, db, () => keep, { ...EVICT_LIMITS, people: 5 });
  const left = new Set((await all<{ id: number }>(db, 'users')).map((u) => u.id));
  for (const id of [50, 51, 52, 54, 55, 60, 70, 71, 72, 73, 74]) expect(left.has(id)).toBe(true);
  for (const id of [53, 61, 75, 80]) expect(left.has(id)).toBe(false);
  expect(st.users).toBe(31 - 11);
  // списки удалённого — вместе с ним; подписанного — на месте
  const music = await all<{ userId: number }>(db, 'profileMusic');
  expect(music.filter((r) => r.userId !== 74)).toEqual([]);
  expect(s.profileLists.loaded('m:80')).toBe(false);
  // больше 100 треков (в обход ответа сервера) — остаются 100 новых, подписка на список пересчитается
  const tracks = Array.from({ length: 105 }, (_, i) => ({ userId: 74, attId: 'x' + i, title: 't', duration: 1, mime: 'audio/mpeg', addedAt: new Date(1_700_000_000_000 + i * 1000).toISOString() }));
  s.profileLists.music.apply(74, tracks);
  s.profileLists.touched.clear();
  const st3 = await evict(s, db, () => keep, { ...EVICT_LIMITS, people: 5 });
  expect(st3.lists).toBe(5);
  expect(s.profileLists.touched.has('m:74')).toBe(true);
  expect(s.profileLists.music.rows(74).map((r) => r.attId).sort()).toEqual(tracks.slice(5).map((t) => t.attId).sort());
  // под пределом — никого не трогаем
  const st2 = await evict(s, db, keepNone, { ...EVICT_LIMITS, people: 5_000 });
  expect(st2.users).toBe(0);
});

test('members: a big group keeps the first 200; an open members list is not touched', async () => {
  const name = 'evict-' + crypto.randomUUID();
  const m1 = row(3, 1), m2 = row(4, 2);
  const db = await seed(name, [
    { chat: chatRow(3, m1, { kind: 'group', group: { members: 1500 } as never, membersDone: false, ranges: [[1, 1]] }), msgs: [m1] },
    { chat: chatRow(4, m2, { kind: 'group', group: { members: 1500 } as never, membersDone: false, ranges: [[2, 2]] }), msgs: [m2] },
  ]);
  const s = await Store.open(db, ME);
  const list = Array.from({ length: 260 }, (_, i) => ({ userId: 100 + i, role: 'member' as const, rank: null }));
  s.members.applySnapshot(3, list, 0);   // журнал дописал участников сверх 200
  s.members.applySnapshot(4, list, 0);
  await s.flush();
  const keep = keepNone();
  keep.members.add(4);
  await evict(s, db, () => keep);
  expect(s.members.list(3).map((r) => r.userId)).toEqual(list.slice(0, 200).map((m) => m.userId));
  expect(s.members.list(4)).toHaveLength(260);
  expect((await all<{ chatId: number }>(db, 'members')).filter((r) => r.chatId === 3)).toHaveLength(200);
});

test('a big chat is trimmed in bounded transactions; a flush issued mid-eviction is not held until the end', async () => {
  const name = 'evict-' + crypto.randomUUID();
  const msgs = Array.from({ length: 1000 }, (_, j) => row(4, j + 1, { body: 'w' + j }));
  const db = await seed(name, [{ chat: chatRow(4, msgs[999], { ranges: [[1, 1000]], historyStart: true }), msgs }]);
  const s = await Store.open(db, ME);
  const chunks: number[] = [], order: string[] = [];
  await evict(s, db, keepNone, { ...EVICT_LIMITS, perChat: 10 }, {
    chunk: 300,
    onChunk: (_id, n) => {
      chunks.push(n);
      if (chunks.length > 1) return;
      s.applyUpdate({ type: 'newMessage', message: msg({ id: 2000, chatId: 9, senderId: 2, body: 'mid' }) });
      s.flush().then(() => order.push('flush'));
    },
  });
  order.push('evict');
  expect(chunks).toEqual([300, 300, 300, 90]);
  expect(order).toEqual(['flush', 'evict']);
  expect(s.chats.get(4)!.ranges).toEqual([[991, 1000]]);
  expect(s.chats.get(4)!.historyStart).toBeUndefined();
  expect(await count(db, 'messages')).toBe(11);
  expect(await count(db, 'terms')).toBe(11);
});

test('the chat row is narrowed in the same transaction as its rows: a reopened cache and a later message never bridge evicted history', async () => {
  const name = 'evict-' + crypto.randomUUID();
  const msgs = Array.from({ length: 30 }, (_, j) => row(3, j + 1, { body: 'w' + j }));
  const db = await seed(name, [{ chat: chatRow(3, msgs[29], { ranges: [[1, 30]], historyStart: true, seed: 3 }), msgs }]);
  const s = await Store.open(db, ME);
  await s.loadChatMessages(3);
  let stop = false;
  // первая порция — и «воркер закрылся»: память на диск не попала
  await evict(s, db, keepNone, { ...EVICT_LIMITS, perChat: 10 }, { chunk: 5, closed: () => stop, onChunk: () => { stop = true; } });
  const stored = (await all<LocalChat>(db, 'chats')).find((c) => c.id === 3)!;
  expect(stored.ranges).toEqual([[6, 30]]);
  expect(stored.historyStart).toBeUndefined();
  expect(stored.seed).toBeUndefined();
  const re = await Store.open(db, ME);
  await re.loadChatMessages(3);
  expect(re.chats.get(3)!.ranges).toEqual([[6, 30]]);
  expect(re.chatMessages(3)[0].id).toBe(6);
  // журнал после уборки продлевает живой отрезок, но не перекидывает его через стёртое
  re.applyUpdate({ type: 'newMessage', message: msg({ id: 31, chatId: 3, senderId: 2, body: 'new' }) });
  expect(re.chats.get(3)!.ranges).toEqual([[6, 31]]);
  // сообщение журнала посреди уборки (ещё не записано): в памяти отрезок до него, на диске — только записанное
  const s2 = await Store.open(db, ME);
  await evict(s2, db, keepNone, { ...EVICT_LIMITS, perChat: 10 }, {
    chunk: 5,
    onChunk: (_id, n) => { if (n && !s2.messageById(3, 32)) s2.applyUpdate({ type: 'newMessage', message: msg({ id: 32, chatId: 3, senderId: 2, body: 'mid' }) }); },
  });
  expect(s2.chats.get(3)!.ranges).toEqual([[21, 32]]);
  const after = (await all<LocalChat>(db, 'chats')).find((c) => c.id === 3)!;
  const rows = (await all<LocalMessage>(db, 'messages')).filter((m) => m.chatId === 3).map((m) => m.sort).sort((x, y) => x - y);
  expect(after.ranges).toEqual([[rows[0], rows[rows.length - 1]]]);
});

test('a flush issued while a chunk is being trimmed does not write the wider chat row over the narrowed one', async () => {
  const name = 'evict-' + crypto.randomUUID();
  const msgs = Array.from({ length: 30 }, (_, j) => row(3, j + 1));
  const db = await seed(name, [{ chat: chatRow(3, msgs[29], { ranges: [[1, 30]] }), msgs }]);
  const s = await Store.open(db, ME);
  // вторая транзакция уборки: сразу за ней — flush (его транзакция встанет после неё)
  const orig = db.transaction.bind(db);
  let trims = 0, flushed: Promise<void> | null = null;
  (db as { transaction: unknown }).transaction = (names: string | string[], mode?: IDBTransactionMode) => {
    const t = orig(names as string[], mode);
    if (Array.isArray(names) && names.includes('chats') && names.includes('terms') && ++trims === 2) flushed = s.flush();
    return t;
  };
  let chunks = 0;
  await evict(s, db, keepNone, { ...EVICT_LIMITS, perChat: 10 }, { chunk: 5, closed: () => chunks >= 2, onChunk: () => { chunks++; } });
  await flushed;
  (db as { transaction: unknown }).transaction = orig;
  expect(flushed).not.toBeNull();
  const stored = (await all<LocalChat>(db, 'chats')).find((c) => c.id === 3)!;
  expect(stored.ranges).toEqual([[11, 30]]);
  expect(s.chats.get(3)!.ranges).toEqual([[11, 30]]);
  await s.flush();   // придержанная строка пишется следующим flush — уже сжатой
  expect((await all<LocalChat>(db, 'chats')).find((c) => c.id === 3)!.ranges).toEqual([[11, 30]]);
});

test('a loading chat is skipped; a closed engine stops between chunks', async () => {
  const name = 'evict-' + crypto.randomUUID();
  const a = Array.from({ length: 30 }, (_, j) => row(1, 100 + j)), b = Array.from({ length: 30 }, (_, j) => row(2, 200 + j));
  const db = await seed(name, [{ chat: chatRow(1, a[29], { ranges: [[100, 129]] }), msgs: a }, { chat: chatRow(2, b[29], { ranges: [[200, 229]] }), msgs: b }]);
  const s = await Store.open(db, ME);
  const keep = keepNone();
  keep.busy.add(1);
  await evict(s, db, () => keep, { ...EVICT_LIMITS, perChat: 10 });
  expect(s.chats.get(1)!.ranges).toEqual([[100, 129]]);
  expect(s.chats.get(2)!.ranges).toEqual([[220, 229]]);
  keep.busy.clear();
  let stop = false;
  const st = await evict(s, db, () => keep, { ...EVICT_LIMITS, perChat: 10 }, { chunk: 5, closed: () => stop, onChunk: () => { stop = true; } });
  expect(st.messages).toBe(5);
  expect(s.chats.get(1)!.ranges).toEqual([[105, 129]]);
});

test('a media page in flight during eviction does not write a cursor over evicted rows', async () => {
  const name = 'evict-' + crypto.randomUUID();
  const photo = { id: 'a', kind: 'photo' as const, mime: 'image/jpeg', name: 'p.jpg', size: 1, w: 1, h: 1 };
  const msgs = Array.from({ length: 60 }, (_, j) => row(6, 101 + j, { kind: 'photo', attachment: photo }));
  const db = await seed(name, [{ chat: chatRow(6, msgs[59], { ranges: [[101, 160]] }), msgs }]);
  const s = await Store.open(db, ME);
  await s.loadChatMessages(6);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const runs: Promise<unknown>[] = [];
  const media = new MediaLoader(s, {
    online: () => true,
    http: async <T>(path: string): Promise<T> => {
      if (path.includes('/counts')) return { media: 70, file: 0, audio: 0, voice: 0, link: 0 } as T;
      await gate;   // страница старше 101 — в пути, пока идёт уборка
      return { messages: Array.from({ length: 10 }, (_, j) => msg({ id: 91 + j, chatId: 6, senderId: 2, kind: 'photo', attachment: photo })), hasMore: true } as T;
    },
    run: (fn) => { runs.push(fn().catch(() => {})); },
    changed: () => {},
  });
  media.want({ kind: 'media', chatId: 6, tab: 'media', limit: 100 });
  await evict(s, db, keepNone, { ...EVICT_LIMITS, perChat: 10 });   // busy не передаём — проверяем сам ответ страницы
  expect(s.chats.get(6)!.ranges).toEqual([[151, 160]]);
  release();
  await Promise.all(runs);
  // ответ лёг вне ленты, но курсор «подряд от новых до 91» поверх стёртых 101..150 не записан
  expect(s.chats.get(6)!.mediaDone?.media).toBeUndefined();
  expect(s.messageById(6, 91)).toBeDefined();
});

// ---------- движок с сервером ----------

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });

test('feed after eviction pages older history from the server again', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ids: number[] = [];
  for (let i = 0; i < 40; i++) ids.push((await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'm' + i })).message.id);
  const eb = await Engine.open({ ...srv.config(b), historyPage: 20 });
  engines.push(eb);
  eb.connect();
  await eb.whenIdle();
  const feed = watchInto(eb, { kind: 'messages', chatId, limit: 60 });
  await feed.until((l) => l.length === 40);
  await eb.whenIdle();
  const chat = () => eb.store.chats.get(chatId)!;
  expect(chat().ranges).toEqual([[ids[0], ids[39]]]);
  expect(chat().historyStart).toBe(true);
  // время открытия — при открытии ленты, не на каждом сдвиге окна
  const opened = chat().openedAt!;
  expect(opened).toBeGreaterThan(0);
  await Bun.sleep(5);
  feed.handle.update({ kind: 'messages', chatId, limit: 50 });
  expect(chat().openedAt).toBe(opened);
  feed.handle.close();

  await eb.evict({ ...EVICT_LIMITS, perChat: 10 });
  expect(chat().ranges).toEqual([[ids[30], ids[39]]]);
  expect(chat().historyStart).toBeUndefined();
  expect(eb.store.chatMessages(chatId).map((m) => m.id)).toEqual(ids.slice(30));

  // окно на 10 — есть старее (история уже не от начала)
  const small = watchInto(eb, { kind: 'messages', chatId, limit: 10 });
  await small.until((l) => l.length === 10);
  const meta = () => small.patches.flatMap((p) => (p.op === 'snapshot' ? p.items : p.upsert)).filter((i) => i.key === '~window').pop();
  expect(meta()!.hasOlder).toBe(true);
  small.handle.close();
  // окно больше — догружает старое с сервера, отрезок снова от начала
  const big = watchInto(eb, { kind: 'messages', chatId, limit: 40 });
  await big.until((l) => l.length === 40);
  await eb.whenIdle();
  expect(big.list().map((m) => m.id)).toEqual(ids);
  expect(chat().ranges).toEqual([[ids[0], ids[39]]]);
  expect(chat().historyStart).toBe(true);
});

test('eviction runs on its own after a flush when idle, at most once per period', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  for (let i = 0; i < 5; i++) await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'm' + i });
  const eb = await Engine.open({ ...srv.config(b), evictDelayMs: 20, evictEveryMs: 60_000 });
  engines.push(eb);
  const runs: unknown[] = [];
  const orig = eb.evict.bind(eb);
  eb.evict = (l) => { runs.push(l); return orig(l); };
  eb.connect();
  await eb.whenIdle();
  await Bun.sleep(100);
  await eb.whenIdle();
  expect(runs.length).toBe(1);
  await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'more' });
  await Bun.sleep(100);
  await eb.whenIdle();
  expect(runs.length).toBe(1);   // не чаще раза в период
});

test('a window opened in the middle of eviction keeps its rows', async () => {
  const a = await srv.login('a'), b = await srv.login('b'), c = await srv.login('c');
  const chats = [await srv.chat(a.token, [a.userId, b.userId]), await srv.chat(c.token, [c.userId, b.userId])];
  const ids = new Map<number, number[]>();
  for (const [i, chatId] of chats.entries()) {
    const list: number[] = [];
    for (let k = 0; k < 40; k++) list.push((await sendMessage([a, c][i].userId, { chatId, clientId: crypto.randomUUID(), body: 'm' + k })).message.id);
    ids.set(chatId, list);
  }
  const eb = await Engine.open({ ...srv.config(b), historyPage: 20 });
  engines.push(eb);
  eb.connect();
  await eb.whenIdle();
  for (const chatId of chats) {
    const f = watchInto(eb, { kind: 'messages', chatId, limit: 60 });
    await f.until((l) => l.length === 40);
    await eb.whenIdle();
    f.handle.close();
  }
  let fw: ReturnType<typeof watchInto> | null = null, other = 0;
  await eb.evict({ ...EVICT_LIMITS, perChat: 10 }, {
    chunk: 5,
    onChunk: (id) => {
      if (fw) return;
      // после первой порции первого чата — открыть окно в старой истории другого
      other = id === chats[0] ? chats[1] : chats[0];
      fw = watchInto(eb, { kind: 'messages', chatId: other, limit: 5, anchor: { sort: ids.get(other)![2], side: 'start' } });
    },
  });
  const want = ids.get(other)!.slice(2, 7);
  await fw!.until((l) => l.length === 5);
  for (const id of want) expect(eb.store.messageById(other, id)).toBeDefined();
  expect(fw!.list().map((m) => m.id)).toEqual(want);
  // окно ни разу не теряло своих строк
  const keys = new Set(fw!.list().map((m) => m.key));
  expect(fw!.patches.some((p) => p.op === 'diff' && p.remove.some((k) => keys.has(k)))).toBe(false);
  fw!.handle.close();
});

test('an evicted person is asked again when a new message brings them back (no reconnect)', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис'), c = await srv.login('Вера');
  const chatId = await srv.chat(a.token, [a.userId, b.userId, c.userId]);
  await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'привет' });
  const eb = await Engine.open(srv.config(b));
  engines.push(eb);
  eb.connect();
  await eb.whenIdle();
  const p1 = watchInto(eb, { kind: 'people', ids: [c.userId] });
  await p1.until((l) => l[0]?.name === 'Вера');
  p1.handle.close();
  await eb.whenIdle();
  const st = await eb.evict({ ...EVICT_LIMITS, people: 0 });
  expect(st.users).toBeGreaterThan(0);
  expect(eb.store.users.get(c.userId)).toBeUndefined();
  // Вера пишет снова: лента спрашивает автора — профиль приходит без переподключения
  await sendMessage(c.userId, { chatId, clientId: crypto.randomUUID(), body: 'я тут' });
  const feed = watchInto(eb, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l.some((m) => m.body === 'я тут'));
  const p2 = watchInto(eb, { kind: 'people', ids: [c.userId] });
  expect((await p2.until((l) => l[0]?.name === 'Вера'))[0].id).toBe(c.userId);
});

test('thread ranges: an open thread (its window kept) keeps its ranges; otherwise they shrink by its own evicted comments', async () => {
  const mk = () => {
    const msgs = Array.from({ length: 30 }, (_, j) => row(5, 100 + j, (j >= 10 && j <= 15) || j >= 25 ? { threadId: 200 } : {}));
    return { msgs, chat: chatRow(5, msgs[29], { kind: 'group', ranges: [[100, 129]], threads: { 200: { ranges: [[110, 128]], historyStart: true }, 300: { ranges: [[90, 95]] } } }) };
  };
  // тред открыт: окно треда защищено — отрезки треда на месте
  const a = mk();
  const dbA = await seed('evict-' + crypto.randomUUID(), [a]);
  const sA = await Store.open(dbA, ME);
  const win = new Set(a.msgs.filter((m) => m.threadId === 200).map((m) => m.key));
  await evict(sA, dbA, () => ({ ...keepNone(), windows: new Map([[5, win]]) }), { ...EVICT_LIMITS, perChat: 10 });
  expect(sA.chats.get(5)!.threads).toEqual({ 200: { ranges: [[110, 128]], historyStart: true }, 300: { ranges: [[90, 95]] } });
  // не открыт: стёрты его ранние комментарии — отрезок с пола, начала истории треда больше нет; другой тред не тронут
  const b = mk();
  const dbB = await seed('evict-' + crypto.randomUUID(), [b]);
  const sB = await Store.open(dbB, ME);
  await evict(sB, dbB, keepNone, { ...EVICT_LIMITS, perChat: 10 });
  expect(sB.chats.get(5)!.threads).toEqual({ 200: { ranges: [[120, 128]] }, 300: { ranges: [[90, 95]] } });
});
