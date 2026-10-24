import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import type { ServerFrame } from '@relay/protocol';
import { createGroup } from '../../../apps/server/src/domain/chats';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { editMessage, reactMessage } from '../../../apps/server/src/domain/messageOps';
import { deleteGroup, setGroupAdmin, setGroupUsername } from '../../../apps/server/src/domain/groups';
import { joinByInvite } from '../../../apps/server/src/domain/invites';
import { flushOwn } from '../../../apps/server/src/valkey';
import '../../../apps/server/src/jobs/kinds';
import { drainJobs } from '../../../apps/server/src/jobs/worker';
import { openDb } from '../src/idb';
import { Engine } from '../src/engine';
import { Store } from '../src/store';
import { canPost, isPost, shiftCounts } from '../src/channel';
import { msg, resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(async () => { await resetDb(); await flushOwn(); });   // наборы просмотров (seen:<user>:<chat>) — от прошлых тестов с теми же id
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const inject = (e: Engine, f: ServerFrame) => (e as unknown as { onFrame(f: ServerFrame): void }).onFrame(f);
const post = (userId: number, chatId: number, body: string) => sendMessage(userId, { chatId, clientId: crypto.randomUUID(), body }).then((r) => r.message);

async function channel() {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const { chatId } = await createGroup(a.userId, { kind: 'channel', title: 'Новости', memberIds: [b.userId] });
  return { a, b, chatId };
}

test('an incoming post is from the channel (senderId 0, isPost, not mine for the author); canSend — admin with post only', async () => {
  const { a, b, chatId } = await channel();
  const eb = await open(srv.config(b)), ea = await open(srv.config(a));
  eb.connect(); ea.connect(); await eb.whenIdle(); await ea.whenIdle();
  const listB = watchInto(eb, { kind: 'chatList', limit: 50 }), listA = watchInto(ea, { kind: 'chatList', limit: 50 });
  const rowB = (await listB.until((l) => l.some((c) => c.id === chatId))).find((c) => c.id === chatId)!;
  const rowA = (await listA.until((l) => l.some((c) => c.id === chatId))).find((c) => c.id === chatId)!;
  expect(rowB).toMatchObject({ kind: 'channel', canSend: false });
  expect(rowA).toMatchObject({ kind: 'channel', canSend: true });
  const feedB = watchInto(eb, { kind: 'messages', chatId, limit: 50 }), feedA = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await post(a.userId, chatId, 'первый пост');
  const [mb] = (await feedB.until((l) => l.some((m) => m.body === 'первый пост'))).filter((m) => m.body === 'первый пост');
  expect(mb).toMatchObject({ senderId: 0, post: true });
  expect(isPost(mb as never)).toBe(true);
  const [ma] = (await feedA.until((l) => l.some((m) => m.body === 'первый пост'))).filter((m) => m.body === 'первый пост');
  expect(ma).toMatchObject({ senderId: 0, post: true });   // у автора — тоже пост, не «своё»
  // служебное «создал(а) канал» — тоже от канала
  expect((await feedB.until((l) => l.some((m) => (m.service as { type?: string } | undefined)?.type === 'channel_created'))).find((m) => m.service)).toMatchObject({ senderId: 0 });
  // подписчик стал админом с post — может писать
  await setGroupAdmin(a.userId, chatId, b.userId, { rights: { post: true } });
  await listB.until((l) => l.find((c) => c.id === chatId)?.canSend === true);
  // группа и личный — как раньше
  expect(canPost({ kind: 'group', me: undefined })).toBe(true);
  expect(canPost({ kind: 'channel', me: undefined })).toBe(false);
});

test('views: posts on screen are sent once per session, in one batch per second, and only grow', async () => {
  const { a, b, chatId } = await channel();
  const p1 = await post(a.userId, chatId, 'раз'), p2 = await post(a.userId, chatId, 'два'), p3 = await post(a.userId, chatId, 'три');
  const eb = await open({ ...srv.config(b), viewsFlushMs: 1000 });
  eb.connect(); await eb.whenIdle();
  const feed = watchInto(eb, { kind: 'messages', chatId, limit: 50 });
  await feed.until((l) => l.length === 4);
  // считаем запросы просмотров
  const calls: { at: number; ids: number[] }[] = [];
  const real = (eb as unknown as { http: (p: string, i?: { method: string; body?: string }) => Promise<unknown> }).http.bind(eb);
  (eb as unknown as { http: typeof real }).http = (p, i) => { if (p.endsWith('/views')) calls.push({ at: Date.now(), ids: JSON.parse(i!.body!).ids }); return real(p, i); };
  await eb.call({ type: 'countViews', chatId, ids: [p1.id, p2.id] });
  await eb.call({ type: 'countViews', chatId, ids: [p2.id] });
  await feed.until((l) => l.filter((m) => m.views === 1).length === 2, 3000);
  expect(calls.map((c) => c.ids)).toEqual([[p1.id, p2.id]]);
  // уже посчитанные за сессию не уходят; новое — следующим батчем, не раньше чем через секунду
  await eb.call({ type: 'countViews', chatId, ids: [p1.id, p3.id] });
  await feed.until((l) => l.find((m) => m.id === p3.id)?.views === 1, 3000);
  expect(calls.map((c) => c.ids)).toEqual([[p1.id, p2.id], [p3.id]]);
  expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(950);
  await eb.call({ type: 'countViews', chatId, ids: [p1.id, p2.id, p3.id] });
  await Bun.sleep(1200);
  expect(calls.length).toBe(2);
  // только рост: запоздалый меньший ответ не опускает
  const store = (eb as unknown as { store: Store }).store;
  store.applyViews(chatId, [[p1.id, 7]]);
  store.applyViews(chatId, [[p1.id, 3]]);
  expect(store.messageById(chatId, p1.id)?.views).toBe(7);
});

test('reactionCounts from the channel journal patch the post; own react is optimistic and then exact from the answer', async () => {
  const { a, b, chatId } = await channel();
  const p = await post(a.userId, chatId, 'пост');
  const eb = await open(srv.config(b));
  eb.connect(); await eb.whenIdle();
  const feed = watchInto(eb, { kind: 'messages', chatId, limit: 50 });
  await feed.until((l) => l.some((m) => m.id === p.id));
  await reactMessage(a.userId, chatId, p.id, '🔥');
  await Bun.sleep(1100); await drainJobs();
  await feed.until((l) => JSON.stringify(l.find((m) => m.id === p.id)?.reactionCounts) === JSON.stringify([['🔥', 1]]));
  await eb.call({ type: 'react', chatId, id: p.id, emoji: '👍' });
  const m = (await feed.until((l) => l.find((x) => x.id === p.id)?.myReaction === '👍')).find((x) => x.id === p.id)!;
  expect(m.reactionCounts).toEqual([['👍', 1], ['🔥', 1]]);
  expect(m.reactions ?? []).toEqual([]);   // списка реакторов у поста нет
  await eb.call({ type: 'react', chatId, id: p.id, emoji: null });
  const m2 = (await feed.until((l) => l.find((x) => x.id === p.id)?.myReaction === undefined)).find((x) => x.id === p.id)!;
  expect(m2.reactionCounts).toEqual([['🔥', 1]]);
  expect(shiftCounts([['👍', 2], ['🔥', 1]], '👍', '🔥')).toEqual([['👍', 1], ['🔥', 2]].sort((x, y) => (y[1] as number) - (x[1] as number)) as [string, number][]);
});

test('newMessage / messageEdited without views or counts keep what the client already has (absent ≠ reset)', async () => {
  const s = await Store.open(await openDb('channel-' + crypto.randomUUID()), 1);
  const m = msg({ id: 5, chatId: 9, senderId: 0, post: true, views: 12, reactionCounts: [['👍', 3]], myReaction: '👍' });
  s.applyUpdate({ type: 'newMessage', message: m });
  // журнал: то же сообщение без просмотров и счётчиков (гидрация их не берёт)
  s.applyUpdate({ type: 'newMessage', message: { ...m, views: undefined, reactionCounts: undefined, myReaction: undefined } });
  expect(s.messageById(9, 5)).toMatchObject({ views: 12, reactionCounts: [['👍', 3]], myReaction: '👍', post: true });
  s.applyUpdate({ type: 'messageEdited', chatId: 9, id: 5, body: 'правка', editedAt: new Date().toISOString() });
  expect(s.messageById(9, 5)).toMatchObject({ body: 'правка', views: 12, reactionCounts: [['👍', 3]] });
  // история с меньшим числом просмотров не опускает; счётчики из истории — новые, без моей — «не ставил»
  s.applyUpdate({ type: 'newMessage', message: { ...m, views: 4, reactionCounts: [['🔥', 1]], myReaction: undefined } });
  const got = s.messageById(9, 5)!;
  expect(got.views).toBe(12);
  expect(got.reactionCounts).toEqual([['🔥', 1]]);
  expect(got.myReaction).toBeUndefined();
  s.applyUpdate({ type: 'reactionCounts', chatId: 9, id: 5, counts: [['🔥', 2], ['👍', 1]] });
  expect(s.messageById(9, 5)?.reactionCounts).toEqual([['🔥', 2], ['👍', 1]]);
});

test('typing frames in a channel are ignored on the client', async () => {
  const { a, b, chatId } = await channel();
  const eb = await open(srv.config(b));
  eb.connect(); await eb.whenIdle();
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  await list.until((l) => l.some((c) => c.id === chatId));
  inject(eb, { op: 'typing', chatId, userId: 0 });
  inject(eb, { op: 'typing', chatId, userId: a.userId });
  await Bun.sleep(50);
  expect(list.list().find((c) => c.id === chatId)?.typing).toBe(false);
  expect((eb as unknown as { store: Store }).store.typing.has(chatId)).toBe(false);
  // editMessage поста в канале доходит как обычно
  const p = await post(a.userId, chatId, 'было');
  await editMessage(a.userId, chatId, p.id, 'стало');
  const feed = watchInto(eb, { kind: 'messages', chatId, limit: 50 });
  await feed.until((l) => l.some((m) => m.id === p.id && m.body === 'стало'));
});

test('groupUpdated of a channel carries no owner: an admin keeps the known ownerId, a subscriber has none', async () => {
  const { allAdminRights, allRights, subscriberRights: noRights } = await import('@relay/protocol');
  const s = await Store.open(await openDb('channel-' + crypto.randomUUID()), 1);
  const group = { title: 'Новости', about: '', photo: null, ownerId: 7, rights: noRights(), slowMode: 0, historyHidden: false, joinApproval: false, username: null,
    reactions: { mode: 'all' as const, allowed: [] }, protected: false, members: 3, requests: 0, signatures: false, linkedChatId: null };
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 9, senderId: 0, post: true }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 10, senderId: 0, post: true }) });
  for (const id of [9, 10]) { const c = s.chats.get(id)!; c.kind = 'channel'; c.group = group; }
  s.applyUpdate({ type: 'membership', chatId: 9, me: { role: 'admin', admin: allAdminRights('channel'), rank: null, rights: allRights(), restricted: false } });
  s.applyUpdate({ type: 'membership', chatId: 10, me: { role: 'member', admin: null, rank: null, rights: noRights(), restricted: false } });
  s.applyUpdate({ type: 'groupUpdated', chatId: 9, group: { ...group, about: 'новое', ownerId: null } });
  s.applyUpdate({ type: 'groupUpdated', chatId: 10, group: { ...group, about: 'новое', ownerId: null } });
  expect(s.chats.get(9)!.group).toMatchObject({ about: 'новое', ownerId: 7 });
  expect(s.chats.get(10)!.group).toMatchObject({ about: 'новое', ownerId: null });
});

// ---------- превью публичного канала без подписки ----------

/** Публичный канал (@name) Анны, в котором Чужой не состоит; два поста. */
async function publicChannel() {
  const a = await srv.login('Анна'), x = await srv.login('Чужой');
  const { chatId } = await createGroup(a.userId, { kind: 'channel', title: 'Новости', memberIds: [] });
  await setGroupUsername(a.userId, chatId, 'news_pv');
  const p1 = await post(a.userId, chatId, 'раз'), p2 = await post(a.userId, chatId, 'два');
  return { a, x, chatId, p1, p2 };
}

test('preview: a public channel opens for a non-member — feed loads, no list row, no counters, nothing in IndexedDB', async () => {
  const { x, chatId } = await publicChannel();
  const cfg = srv.config(x);
  const ex = await open(cfg);
  ex.connect(); await ex.whenIdle();
  const list = watchInto(ex, { kind: 'chatList', limit: 50 }), previews = watchInto(ex, { kind: 'previews' });
  expect(await ex.call({ type: 'openPreview', chatId })).toEqual({ member: false, requested: false });
  const row = (await previews.until((l) => l.length === 1))[0];
  expect(row).toMatchObject({ id: chatId, kind: 'channel', title: 'Новости', preview: true, canSend: false, me: null, group: { username: 'news_pv', ownerId: null } });
  const feed = watchInto(ex, { kind: 'messages', chatId, limit: 50 });
  expect((await feed.until((l) => l.some((m) => m.body === 'два'))).filter((m) => !m.service).map((m) => m.body)).toEqual(['раз', 'два']);
  await ex.whenIdle();
  expect(list.list().some((c) => c.id === chatId)).toBe(false);
  const counters = watchInto(ex, { kind: 'counters' });
  expect((await counters.until((l) => l.length === 1))[0]).toMatchObject({ unreadChats: 0, unreadMessages: 0 });
  // в IndexedDB — ничего от превью
  const s = await Store.open(await openDb(cfg.dbName), x.userId);
  expect(s.chats.has(chatId)).toBe(false);
  expect(s.chatSeq.has(chatId)).toBe(false);
  await s.loadChatMessages(chatId);
  expect(s.chatMessages(chatId)).toEqual([]);
});

test('preview: a new post arrives by push (watchChat); views, reads and reactions are not sent', async () => {
  const { a, x, chatId, p1 } = await publicChannel();
  const ex = await open(srv.config(x));
  ex.connect(); await ex.whenIdle();
  await ex.call({ type: 'openPreview', chatId });
  const feed = watchInto(ex, { kind: 'messages', chatId, limit: 50 });
  await feed.until((l) => l.some((m) => m.body === 'два'));
  await ex.whenIdle();
  const calls: string[] = [];
  const real = (ex as unknown as { http: (p: string, i?: { method: string; body?: string }) => Promise<unknown> }).http.bind(ex);
  (ex as unknown as { http: typeof real }).http = (p, i) => { calls.push(p); return real(p, i); };
  await post(a.userId, chatId, 'три');
  await feed.until((l) => l.some((m) => m.body === 'три'));
  await ex.call({ type: 'countViews', chatId, ids: [p1.id] });
  await ex.call({ type: 'seen', chatId, upToId: p1.id });
  await expect(ex.call({ type: 'react', chatId, id: p1.id, emoji: '👍' })).rejects.toThrow('not_member');
  await Bun.sleep(1200);
  expect(calls.filter((c) => c.endsWith('/views'))).toEqual([]);
  expect(Number((await (await import('../../../apps/server/src/db')).sql`select count(*)::int as n from message_views where chat_id = ${chatId}`)[0].n)).toBe(0);
});

test('preview: subscribing promotes it to a listed chat without reloading the feed; then it is cached like any chat', async () => {
  const { a, x, chatId } = await publicChannel();
  const cfg = srv.config(x);
  const ex = await open(cfg);
  ex.connect(); await ex.whenIdle();
  await ex.call({ type: 'openPreview', chatId });
  const list = watchInto(ex, { kind: 'chatList', limit: 50 }), previews = watchInto(ex, { kind: 'previews' });
  const feed = watchInto(ex, { kind: 'messages', chatId, limit: 50 });
  await feed.until((l) => l.some((m) => m.body === 'два'));
  await ex.whenIdle();
  const history: string[] = [];
  const real = (ex as unknown as { http: (p: string, i?: { method: string; body?: string }) => Promise<unknown> }).http.bind(ex);
  (ex as unknown as { http: typeof real }).http = (p, i) => { if (p.includes('/messages')) history.push(p); return real(p, i); };
  const before = feed.patches.length;
  await joinByInvite(x.userId, '@news_pv');
  const row = (await list.until((l) => l.some((c) => c.id === chatId))).find((c) => c.id === chatId)!;
  expect(row).toMatchObject({ kind: 'channel', unread: 0, me: { role: 'member' }, canSend: false });
  await previews.until((l) => l.length === 0);
  // лента не перезагружалась: ни снимка заново, ни запроса истории
  expect(feed.patches.slice(before).some((p) => p.op === 'snapshot')).toBe(false);
  expect(history).toEqual([]);
  await post(a.userId, chatId, 'после');
  await feed.until((l) => l.some((m) => m.body === 'после'));
  await ex.call({ type: 'closePreview', chatId });   // интерфейс закрыл ленту — чат остаётся (уже подписан)
  await ex.whenIdle();
  expect(list.list().some((c) => c.id === chatId)).toBe(true);
  const s = await Store.open(await openDb(cfg.dbName), x.userId);
  expect(s.chats.get(chatId)?.me?.role).toBe('member');
  await s.loadChatMessages(chatId);
  expect(s.chatMessages(chatId).filter((m) => !m.service).map((m) => m.body)).toEqual(['раз', 'два', 'после']);
  expect(s.chatSeq.get(chatId)).toBeGreaterThan(0);
});

test('preview: closing forgets it; a deleted channel drops an open preview (chatGone)', async () => {
  const { a, x, chatId } = await publicChannel();
  const ex = await open(srv.config(x));
  ex.connect(); await ex.whenIdle();
  const previews = watchInto(ex, { kind: 'previews' });
  await ex.call({ type: 'openPreview', chatId });
  const feed = watchInto(ex, { kind: 'messages', chatId, limit: 50 });
  await feed.until((l) => l.some((m) => m.body === 'два'));
  feed.handle.close();
  await ex.call({ type: 'closePreview', chatId });
  await previews.until((l) => l.length === 0);
  expect((ex as unknown as { store: Store }).store.chats.has(chatId)).toBe(false);
  // снова открыли — и канал удалили, пока смотрим
  await ex.call({ type: 'openPreview', chatId });
  await previews.until((l) => l.length === 1);
  await ex.whenIdle();
  await deleteGroup(a.userId, chatId);
  await previews.until((l) => l.length === 0, 5000);
  expect((ex as unknown as { store: Store }).store.chats.has(chatId)).toBe(false);
  // приватный канал по id — не участник
  const { chatId: priv } = await createGroup(a.userId, { kind: 'channel', title: 'Закрытый', memberIds: [] });
  expect(await ex.call({ type: 'openPreview', chatId: priv })).toEqual({ error: 'not_member' });
});
