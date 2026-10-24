import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { createGroup } from '../../../apps/server/src/domain/chats';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { setLinkedChat } from '../../../apps/server/src/domain/groups';
import { sql } from '../../../apps/server/src/db';
import '../../../apps/server/src/jobs/kinds';
import { drainJobs } from '../../../apps/server/src/jobs/worker';
import { Engine } from '../src/engine';
import { hasUnreadReplies } from '../src/channel';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const send = (userId: number, chatId: number, body: string, threadId?: number) =>
  sendMessage(userId, { chatId, clientId: crypto.randomUUID(), body, ...(threadId ? { threadId } : {}) }).then((r) => r.message);
const copyOf = async (ch: number, postId: number) => Number((await sql`select copy_id from message_threads where chat_id = ${ch} and post_id = ${postId}`)[0].copy_id);
/** Отложенные replies.flush — на сейчас и прогнать. */
const flushReplies = async () => { await sql`update jobs set run_at = now()`; await drainJobs(); };

/** Канал a с подписчиком b и группой обсуждения (a, b); пост с копией. */
async function setup() {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const { chatId: ch } = await createGroup(a.userId, { kind: 'channel', title: 'Новости', memberIds: [b.userId] });
  const { chatId: g } = await createGroup(a.userId, { title: 'Обсуждение', memberIds: [b.userId] });
  await setLinkedChat(a.userId, ch, g);
  const post = await send(a.userId, ch, 'пост');
  return { a, b, ch, g, post, copyId: await copyOf(ch, post.id) };
}

test('thread query: the header (copy) first, then the comments; an incoming comment extends the thread and the group feed', async () => {
  const { a, b, g, copyId } = await setup();
  await send(a.userId, g, 'просто в группе');
  await send(a.userId, g, 'к1', copyId);
  await send(a.userId, g, 'к2', copyId);
  const eb = await open(srv.config(b));
  eb.connect(); await eb.whenIdle();
  const th = watchInto(eb, { kind: 'thread', chatId: g, threadId: copyId, limit: 50 });
  const l = await th.until((x) => x.length === 3);
  expect(l.map((m) => m.body)).toEqual(['пост', 'к1', 'к2']);
  expect(l[0]).toMatchObject({ id: copyId, origin: { id: expect.any(Number) }, post: true, senderId: 0 });
  const feed = watchInto(eb, { kind: 'messages', chatId: g, limit: 50 });
  await feed.until((x) => x.some((m) => m.body === 'к2'));
  // комментарий из журнала группы — и в треде, и в ленте группы
  await send(a.userId, g, 'к3', copyId);
  expect((await th.until((x) => x.length === 4)).map((m) => m.body)).toEqual(['пост', 'к1', 'к2', 'к3']);
  await feed.until((x) => x.some((m) => m.body === 'к3' && m.threadId === copyId));
  // свой комментарий: в треде сразу (pending), после ответа — на месте
  await eb.call({ type: 'sendMessage', chatId: g, body: 'мой', threadId: copyId });
  await th.until((x) => x.some((m) => m.body === 'мой'));
  await eb.whenIdle();
  const mine = (await th.until((x) => x.some((m) => m.body === 'мой' && m.id != null))).find((m) => m.body === 'мой')!;
  expect(mine.threadId).toBe(copyId);
  expect(Number((await sql`select thread_id from messages where id = ${mine.id as number}`)[0].thread_id)).toBe(copyId);
});

test('replies on the post: the history carries the button, the replies event patches it (readMaxId kept), readThread and markThreadRead clear the dot without touching the main lastRead', async () => {
  const { a, b, ch, g, post, copyId } = await setup();
  const k1 = await send(a.userId, g, 'к1', copyId);
  await flushReplies();
  const eb = await open(srv.config(b));
  eb.connect(); await eb.whenIdle();
  const feed = watchInto(eb, { kind: 'messages', chatId: ch, limit: 50 });
  const p0 = (await feed.until((x) => x.some((m) => m.id === post.id && m.replies))).find((m) => m.id === post.id)!;
  expect(p0.replies).toEqual({ copyId, chatId: g, count: 1, lastId: k1.id, recent: [a.userId] });
  expect(hasUnreadReplies(p0 as never)).toBe(true);
  // прочитал тред на этом устройстве: точка гаснет сразу, лента группы не прочитана
  const lastReadBefore = eb.store.chats.get(g)?.lastReadId ?? 0;
  await eb.call({ type: 'markThreadRead', chatId: g, threadId: copyId, upToId: k1.id });
  const p1 = (await feed.until((x) => x.find((m) => m.id === post.id)?.replies?.readMaxId === k1.id)).find((m) => m.id === post.id)!;
  expect(hasUnreadReplies(p1 as never)).toBe(false);
  expect(eb.store.chats.get(g)?.lastReadId ?? 0).toBe(lastReadBefore);
  await eb.whenIdle();
  expect(Number((await sql`select read_max_id from thread_reads where user_id = ${b.userId} and thread_id = ${copyId}`)[0].read_max_id)).toBe(k1.id);
  // новый комментарий → событие replies в журнале канала: число и последний новые, readMaxId — мой прежний
  const k2 = await send(a.userId, g, 'к2', copyId);
  await flushReplies();
  const p2 = (await feed.until((x) => x.find((m) => m.id === post.id)?.replies?.count === 2)).find((m) => m.id === post.id)!;
  expect(p2.replies).toEqual({ copyId, chatId: g, count: 2, lastId: k2.id, recent: [a.userId], readMaxId: k1.id });
  expect(hasUnreadReplies(p2 as never)).toBe(true);
  // прочитал на другом устройстве (readThread в личном журнале) — точка гаснет и здесь
  await fetch(`${srv.base}/chats/${g}/threads/${copyId}/read`, { method: 'PUT', headers: { cookie: `relay_session=${b.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ upToId: k2.id }) });
  await feed.until((x) => x.find((m) => m.id === post.id)?.replies?.readMaxId === k2.id);
  expect(eb.store.chats.get(g)?.lastReadId ?? 0).toBe(lastReadBefore);
});

test('a subscriber outside the discussion group: the post came by journal without a button, the replies event makes the engine refetch it', async () => {
  const a = await srv.login('Анна'), c = await srv.login('Вера');
  const { chatId: ch } = await createGroup(a.userId, { kind: 'channel', title: 'Новости', memberIds: [c.userId] });
  const b = await srv.login('Борис');
  const { chatId: g } = await createGroup(a.userId, { title: 'Обсуждение', memberIds: [b.userId] });   // c в группе не состоит
  await setLinkedChat(a.userId, ch, g);
  const ec = await open(srv.config(c));
  ec.connect(); await ec.whenIdle();
  const feed = watchInto(ec, { kind: 'messages', chatId: ch, limit: 50 });
  await feed.until((x) => x.length === 1);
  const post = await send(a.userId, ch, 'пост');
  expect((await feed.until((x) => x.some((m) => m.id === post.id))).find((m) => m.id === post.id)!.replies).toBeUndefined();
  const copyId = await copyOf(ch, post.id);
  await send(a.userId, g, 'первый', copyId);
  await flushReplies();
  const p = (await feed.until((x) => x.find((m) => m.id === post.id)?.replies?.count === 1)).find((m) => m.id === post.id)!;
  expect(p.replies).toMatchObject({ copyId, chatId: g, count: 1 });
});

test('resetChat (chatTooLong) clears the thread ranges; the thread reloads on open', async () => {
  const { a, b, g, copyId } = await setup();
  await send(a.userId, g, 'к1', copyId);
  const eb = await open(srv.config(b));
  eb.connect(); await eb.whenIdle();
  const th = watchInto(eb, { kind: 'thread', chatId: g, threadId: copyId, limit: 50 });
  await th.until((x) => x.length === 2);
  expect(eb.store.chats.get(g)?.threads?.[copyId]?.ranges.length).toBe(1);
  th.handle.close();
  await eb.store.resetChat(g);
  expect(eb.store.chats.get(g)?.threads).toBeUndefined();
  const again = watchInto(eb, { kind: 'thread', chatId: g, threadId: copyId, limit: 50 });
  expect((await again.until((x) => x.length === 2)).map((m) => m.body)).toEqual(['пост', 'к1']);
});

test('a guest thread (subscriber outside the group): loads and updates from threadPush without a chat row; own comment and markThreadRead; nothing in the chat list', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис'), c = await srv.login('Вера');
  const { chatId: ch } = await createGroup(a.userId, { kind: 'channel', title: 'Новости', memberIds: [b.userId, c.userId] });
  const { chatId: g } = await createGroup(a.userId, { title: 'Обсуждение', memberIds: [b.userId] });   // c — только в канале
  await setLinkedChat(a.userId, ch, g);
  const post = await send(a.userId, ch, 'пост');
  const copyId = await copyOf(ch, post.id);
  await send(b.userId, g, 'к1', copyId);
  const ec = await open(srv.config(c));
  ec.connect(); await ec.whenIdle();
  const list = watchInto(ec, { kind: 'chatList', limit: 50 });
  await list.until((x) => x.some((r) => r.id === ch));
  const th = watchInto(ec, { kind: 'thread', chatId: g, threadId: copyId, limit: 50 });
  expect((await th.until((x) => x.length === 2)).map((m) => m.body)).toEqual(['пост', 'к1']);
  expect(th.item('~thread')).toMatchObject({ loaded: true, guest: { channelId: ch, title: 'Обсуждение', joinToSend: false, joinApproval: false } });
  expect(ec.store.chats.has(g)).toBe(false);
  expect(ec.store.isGuest(g)).toBe(true);
  // живые комментарии участника — кадром threadPush (подписка на тред после первой страницы)
  await ec.whenIdle();
  await send(b.userId, g, 'к2', copyId);
  await send(b.userId, g, 'в группе, не в треде');
  expect((await th.until((x) => x.length === 3)).map((m) => m.body)).toEqual(['пост', 'к1', 'к2']);
  // свой комментарий: сразу в треде, после ack — с id; строки чата так и нет
  await ec.call({ type: 'sendMessage', chatId: g, body: 'от гостя', threadId: copyId });
  await th.until((x) => x.some((m) => m.body === 'от гостя'));
  await ec.whenIdle();
  const mine = (await th.until((x) => x.some((m) => m.body === 'от гостя' && m.id != null))).find((m) => m.body === 'от гостя')!;
  expect(Number((await sql`select thread_id from messages where id = ${mine.id as number}`)[0].thread_id)).toBe(copyId);
  expect(ec.store.chats.has(g)).toBe(false);
  // прочитал — на сервер (thread_reads гостя)
  const k3 = await send(b.userId, g, 'к3', copyId);
  await th.until((x) => x.some((m) => m.body === 'к3'));
  await ec.call({ type: 'markThreadRead', chatId: g, threadId: copyId, upToId: k3.id });
  const readOf = async () => Number((await sql`select read_max_id from thread_reads where user_id = ${c.userId} and thread_id = ${copyId}`)[0]?.read_max_id ?? 0);
  for (let i = 0; i < 100 && (await readOf()) !== k3.id; i++) await Bun.sleep(20);
  expect(await readOf()).toBe(k3.id);
  // список чатов — без группы, в IndexedDB ни строки, ни сообщений группы
  expect(list.list().some((r) => r.id === g)).toBe(false);
  await ec.store.flush();
  expect(ec.store.chats.has(g)).toBe(false);
  // тред закрыт — подписка снята: новые события не применяются; открыли снова — край догружен
  th.handle.close();
  await ec.whenIdle();
  await send(b.userId, g, 'к4', copyId);
  await Bun.sleep(150);
  expect(ec.store.chatMessages(g).some((m) => m.body === 'к4')).toBe(false);
  const again = watchInto(ec, { kind: 'thread', chatId: g, threadId: copyId, limit: 50 });
  expect((await again.until((x) => x.some((m) => m.body === 'к4'))).map((m) => m.body)).toEqual(['пост', 'к1', 'к2', 'от гостя', 'к3', 'к4']);
});

test('a guest who joins the discussion group: the chat row appears and the guest state is dropped', async () => {
  const a = await srv.login('Анна'), c = await srv.login('Вера');
  const { chatId: ch } = await createGroup(a.userId, { kind: 'channel', title: 'Новости', memberIds: [c.userId] });
  const b = await srv.login('Борис');
  const { chatId: g } = await createGroup(a.userId, { title: 'Обсуждение', memberIds: [b.userId] });
  await setLinkedChat(a.userId, ch, g);
  const post = await send(a.userId, ch, 'пост');
  const copyId = await copyOf(ch, post.id);
  const ec = await open(srv.config(c));
  ec.connect(); await ec.whenIdle();
  const th = watchInto(ec, { kind: 'thread', chatId: g, threadId: copyId, limit: 50 });
  await th.until((x) => x.length === 1);
  expect(ec.store.isGuest(g)).toBe(true);
  expect((await fetch(`${srv.base}/groups/${g}/join`, { method: 'POST', headers: { cookie: `relay_session=${c.token}` } })).status).toBe(200);
  for (let i = 0; i < 150 && !ec.store.chats.get(g)?.group; i++) await Bun.sleep(20);
  expect(ec.store.chats.get(g)?.group).toMatchObject({ title: 'Обсуждение' });
  expect(ec.store.isGuest(g)).toBe(false);
  await send(b.userId, g, 'уже участнику', copyId);
  await th.until((x) => x.some((m) => m.body === 'уже участнику'));
}, 15_000);

test('a guest thread after a reconnect: comments posted while offline arrive (the edge is reloaded), live pushes resume', async () => {
  const a = await srv.login('Анна'), c = await srv.login('Вера');
  const { chatId: ch } = await createGroup(a.userId, { kind: 'channel', title: 'Новости', memberIds: [c.userId] });
  const b = await srv.login('Борис');
  const { chatId: g } = await createGroup(a.userId, { title: 'Обсуждение', memberIds: [b.userId] });
  await setLinkedChat(a.userId, ch, g);
  const post = await send(a.userId, ch, 'пост');
  const copyId = await copyOf(ch, post.id);
  const ec = await open(srv.config(c));
  ec.connect(); await ec.whenIdle();
  const th = watchInto(ec, { kind: 'thread', chatId: g, threadId: copyId, limit: 50 });
  await th.until((x) => x.length === 1);
  await ec.whenIdle();
  ec.disconnect();
  await send(b.userId, g, 'пока не было связи', copyId);
  ec.connect();
  expect((await th.until((x) => x.length === 2)).map((m) => m.body)).toEqual(['пост', 'пока не было связи']);
  await ec.whenIdle();
  await send(b.userId, g, 'снова живой', copyId);
  await th.until((x) => x.some((m) => m.body === 'снова живой'));
  expect(ec.store.chats.has(g)).toBe(false);
});
