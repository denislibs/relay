import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Engine } from '../src/engine';
import { getAll, openDb } from '../src/idb';
import { applyMembersReply, type MembersReply } from '../src/members';
import { Store } from '../src/store';
import { allRights } from '@relay/protocol';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const closeOne = async (e: Engine) => { await e.close(); engines.splice(engines.indexOf(e), 1); };
const api = async (token: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${srv.base}${path}`, { method, headers: { cookie: `relay_session=${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
const group = async (owner: { token: string }, ids: number[]) => (await api(owner.token, 'POST', '/chats', { title: 'Дача', memberIds: ids })).id as number;

/** Считает запросы движка к GET /chats/:id/members (fetch подменяется на время теста). */
function countMembersRequests() {
  const orig = globalThis.fetch;
  const box = { n: 0, restore: () => { globalThis.fetch = orig; } };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (/\/chats\/\d+\/members$/.test(String(input))) box.n++;
    return orig(input, init);
  }) as typeof fetch;
  return box;
}

test('members: one request on open, rows stored; restart offline shows the list from IndexedDB at once', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис'), c = await srv.login('Вера');
  const chatId = await group(a, [b.userId, c.userId]);
  const cfg = srv.config(a);
  const reqs = countMembersRequests();
  try {
    const ea = await open(cfg);
    ea.connect();
    await ea.whenIdle();
    const w = watchInto(ea, { kind: 'members', chatId });
    const l = await w.until((x) => x.length === 3);
    await ea.whenIdle();
    expect(reqs.n).toBe(1);
    const byId = new Map(l.map((m) => [m.userId, m]));
    expect(byId.get(a.userId)).toMatchObject({ key: String(a.userId), role: 'owner', rank: null, name: 'Анна', online: true });
    expect(byId.get(b.userId)).toMatchObject({ role: 'member', name: 'Борис' });
    expect(byId.get(c.userId)).toMatchObject({ role: 'member', name: 'Вера' });
    // вторая подписка за то же подключение — без запроса
    const w2 = watchInto(ea, { kind: 'members', chatId });
    await w2.until((x) => x.length === 3);
    await ea.whenIdle();
    expect(reqs.n).toBe(1);
    await closeOne(ea);

    // строки в базе; присутствие не хранится
    const db = await openDb(cfg.dbName);
    const rows = await getAll<Record<string, unknown>>(db, 'members');
    db.close();
    expect(rows.map((r) => r.userId).sort()).toEqual([a.userId, b.userId, c.userId].sort());
    for (const r of rows) { expect(r.chatId).toBe(chatId); expect('online' in r).toBe(false); expect('lastSeen' in r).toBe(false); }

    // без сети: список сразу из IndexedDB, тот же порядок, имена из people
    const cold = await open(cfg);
    const w3 = watchInto(cold, { kind: 'members', chatId });
    const l3 = await w3.until((x) => x.length === 3, 500);
    expect(l3.map((m) => m.userId)).toEqual(l.map((m) => m.userId));
    expect(l3.find((m) => m.userId === b.userId)).toMatchObject({ name: 'Борис', role: 'member' });
    expect(w3.patches[0].op).toBe('snapshot');
    expect(reqs.n).toBe(1);
  } finally { reqs.restore(); }
});

test('members: journal add, role change and removal reach the subscriber as deltas, without a refetch', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис'), c = await srv.login('Вера'), d = await srv.login('Глеб');
  const chatId = await group(a, [b.userId, c.userId]);
  const reqs = countMembersRequests();
  try {
    const ea = await open(srv.config(a));
    ea.connect();
    await ea.whenIdle();
    const w = watchInto(ea, { kind: 'members', chatId });
    await w.until((x) => x.length === 3);
    await ea.whenIdle();
    const before = w.patches.length;

    // добавили Глеба: одна новая строка в конце, профиль — из userUpdated журнала
    await api(a.token, 'POST', `/groups/${chatId}/members`, { userIds: [d.userId] });
    const l = await w.until((x) => x.length === 4 && x[3].name === 'Глеб');
    expect(l[3]).toMatchObject({ userId: d.userId, role: 'member', rank: null });
    const added = w.patches.slice(before).flatMap((p) => (p.op === 'diff' ? p.upsert : p.items)).filter((it) => !it.key.startsWith('~'));
    expect(added.map((it) => it.userId)).toEqual([d.userId]);

    // Борис — админ с должностью: обновилась одна строка, порядок прежний
    const order = l.map((m) => m.userId);
    const mark = w.patches.length;
    await api(a.token, 'PUT', `/groups/${chatId}/admins/${b.userId}`, { rights: { pin: true }, rank: 'Завхоз' });
    const l2 = await w.until((x) => x.find((m) => m.userId === b.userId)?.role === 'admin');
    expect(l2.find((m) => m.userId === b.userId)?.rank).toBe('Завхоз');
    expect(l2.map((m) => m.userId)).toEqual(order);
    const changed = w.patches.slice(mark).flatMap((p) => (p.op === 'diff' ? p.upsert : p.items)).filter((it) => !it.key.startsWith('~'));
    expect(changed.map((it) => it.userId)).toEqual([b.userId]);

    // Веру удалили
    await api(a.token, 'DELETE', `/groups/${chatId}/members/${c.userId}`);
    const l3 = await w.until((x) => x.length === 3);
    expect(l3.map((m) => m.userId)).toEqual(order.filter((id) => id !== c.userId));
    await ea.whenIdle();
    expect(reqs.n).toBe(1);
  } finally { reqs.restore(); }
});

test('members: removed from the group — the chat and its member rows are gone', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис'), c = await srv.login('Вера');
  const chatId = await group(a, [b.userId, c.userId]);
  const cfg = srv.config(c);
  const ec = await open(cfg);
  ec.connect();
  await ec.whenIdle();
  const w = watchInto(ec, { kind: 'members', chatId });
  await w.until((x) => x.length === 3);
  await ec.whenIdle();
  await api(a.token, 'DELETE', `/groups/${chatId}/members/${c.userId}`);
  await w.until((x) => x.length === 0);
  await ec.whenIdle();
  await closeOne(ec);
  const db = await openDb(cfg.dbName);
  expect(await getAll(db, 'members')).toEqual([]);
  db.close();
});

test('members limits: a group over 1000 keeps the first 200 (not complete); journal records for never-loaded members are ignored', async () => {
  const s = await Store.open(await openDb('members-' + crypto.randomUUID()), 1);
  const group = { title: 'Большая', about: '', photo: null, ownerId: 1, rights: allRights(), slowMode: 0, historyHidden: false, joinApproval: false,
    username: null, reactions: { mode: 'all' as const, allowed: [] }, protected: false, members: 1500, requests: 0 };
  s.applyChats([{ id: 7, kind: 'group', title: 'Большая', lastReadId: 0, unread: 0, last: null, group }, { id: 8, kind: 'group', title: 'Малая', lastReadId: 0, unread: 0, last: null, group: { ...group, members: 3 } }]);
  s.applyUpdate({ type: 'members', chatId: 8, upsert: [{ userId: 5, role: 'member', rank: null }], remove: [] }, 3);
  expect(s.members.list(8)).toEqual([]);   // не загружали — следующее открытие возьмёт целиком
  const big: MembersReply = { ownerId: 1, members: Array.from({ length: 1000 }, (_, i) => ({ userId: 100 + i, role: 'member' as const, rank: null, online: false, lastSeen: null, name: 'U' + i, username: null })) };
  applyMembersReply(s, 7, big, 0);
  expect(s.members.list(7).map((r) => r.userId)).toEqual(big.members.slice(0, 200).map((m) => m.userId));
  expect(s.chats.get(7)!.membersDone).toBe(false);
  applyMembersReply(s, 8, { ownerId: 1, members: big.members.slice(0, 3) }, 0);
  expect(s.chats.get(8)!.membersDone).toBe(true);
  // запись журнала новее снимка: новый участник — в конец; снимок, начатый раньше неё, её не откатывает
  s.applyUpdate({ type: 'members', chatId: 8, upsert: [{ userId: 5, role: 'admin', rank: 'Повар' }], remove: [100] }, 4);
  expect(s.members.list(8).map((r) => r.userId)).toEqual([101, 102, 5]);
  applyMembersReply(s, 8, { ownerId: 1, members: big.members.slice(0, 3) }, 2);
  expect(s.members.list(8).map((r) => r.userId)).toEqual([101, 102, 5]);
});

test('members first load: journal records that arrive while the first snapshot is in flight are kept (add stays, removed stays gone)', async () => {
  const s = await Store.open(await openDb('members-' + crypto.randomUUID()), 1);
  const group = { title: 'Дача', about: '', photo: null, ownerId: 1, rights: allRights(), slowMode: 0, historyHidden: false, joinApproval: false,
    username: null, reactions: { mode: 'all' as const, allowed: [] }, protected: false, members: 3, requests: 0 };
  s.applyChats([{ id: 8, kind: 'group', title: 'Дача', lastReadId: 0, unread: 0, last: null, group }]);
  const row = (userId: number) => ({ userId, role: 'member' as const, rank: null, online: false, lastSeen: null, name: 'U' + userId, username: null });
  s.members.loading.add(8);   // движок начал GET при lastSeq = 5
  s.applyUpdate({ type: 'members', chatId: 8, upsert: [{ userId: 4, role: 'member', rank: null }], remove: [3] }, 6);
  // сервер собрал ответ до записи 6: в нём ещё Вера (3) и нет Глеба (4)
  applyMembersReply(s, 8, { ownerId: 1, members: [row(1), row(2), row(3)] }, 5);
  expect(s.members.loading.has(8)).toBe(false);
  expect(s.members.list(8).map((r) => r.userId)).toEqual([1, 2, 4]);
  expect(s.members.list(8).map((r) => r.order)).toEqual([0, 1, 3]);
  expect(s.chats.get(8)!.membersDone).toBe(true);
});

test('members: after resetLocal an open members subscription loads the list again (asked is forgotten)', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await group(a, [b.userId]);
  const reqs = countMembersRequests();
  try {
    const ea = await open(srv.config(a));
    ea.connect();
    await ea.whenIdle();
    const w = watchInto(ea, { kind: 'members', chatId });
    await w.until((x) => x.length === 2);
    await ea.whenIdle();
    expect(reqs.n).toBe(1);
    await ea.call({ type: 'resetLocal', keepOutbox: true });
    await ea.whenIdle();
    expect(reqs.n).toBe(2);
    expect(ea.store.members.list(chatId).length).toBe(2);
    expect((await w.until((x) => x.length === 2)).map((m) => m.userId).sort()).toEqual([a.userId, b.userId].sort());
  } finally { reqs.restore(); }
});
