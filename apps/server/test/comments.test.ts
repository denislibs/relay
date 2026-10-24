import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import type { ServerFrame } from '@relay/protocol';
import { createServer } from '../src/http';
import { startRealtime } from '../src/realtime';
import { sendMessage } from '../src/domain/messages';
import { deleteMessage, editMessage, reactMessage } from '../src/domain/messageOps';
import { setLinkedChat } from '../src/domain/groups';
import { toggleTodo } from '../src/domain/todo';
import { planPush, subscribe } from '../src/domain/push';
import { allowPrivateHostsForTests } from '../src/domain/linkPreview';
import { PUSH_PAGE } from '../src/jobs/kinds';
import { drainJobs, runJob } from '../src/jobs/worker';
import { claim } from '../src/jobs/queue';
import { markRead } from '../src/domain/reads';
import { chatEventsOf, journalOf, nextFrame, opened, pushBrowser, resetDb, uploadFile } from './helpers';

const server = createServer({ port: 0 });
const stopRealtime = await startRealtime(server);   // push групп и треды гостей (watchThread)
const base = `http://localhost:${server.port}`;
// страница для превью ссылки
const page = Bun.serve({ port: 0, fetch: () => new Response('<html><head><meta charset="utf-8"><title>Страница</title><meta property="og:title" content="Заголовок"></head><body>x</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
afterAll(async () => { await stopRealtime(); server.stop(true); page.stop(); allowPrivateHostsForTests(false); });
beforeEach(resetDb);

type U = { userId: number; token: string };
const login = async (name: string): Promise<U> => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const hdr = (u: U) => ({ cookie: `relay_session=${u.token}`, 'content-type': 'application/json' });
const call = (u: U, method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: hdr(u), body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async (u: U, method: string, path: string, body?: unknown) => {
  const r = await call(u, method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
const channel = async (owner: U, members: U[] = []) => (await ok(owner, 'POST', '/chats', { kind: 'channel', title: 'Новости', memberIds: members.map((m) => m.userId) })).id as number;
const group = async (owner: U, members: U[], title = 'Обсуждение') => (await ok(owner, 'POST', '/chats', { title, memberIds: members.map((m) => m.userId) })).id as number;
const send = (u: U, chatId: number, body: string, extra: Record<string, unknown> = {}) => sendMessage(u.userId, { chatId, clientId: crypto.randomUUID(), body, ...extra }).then((r) => r.message);
const comment = (u: U, g: number, threadId: number, body = 'коммент', extra: Record<string, unknown> = {}) => send(u, g, body, { threadId, ...extra });
const copyOf = async (ch: number, postId: number) => {
  const [r] = await sql`select copy_id from message_threads where chat_id = ${ch} and post_id = ${postId}`;
  return r ? Number(r.copy_id) : null;
};
const thread = async (ch: number, postId: number) => {
  const [r] = await sql`select count, last_id, recent from message_threads where chat_id = ${ch} and post_id = ${postId}`;
  return { count: Number(r.count), lastId: r.last_id == null ? null : Number(r.last_id), recent: (r.recent as unknown[]).map(Number) };
};
const history = async (u: U, chatId: number) => (await ok(u, 'GET', `/chats/${chatId}/messages?limit=100`)).messages as any[];
/** Канал a (подписчик b) с группой обсуждения (a, b, c — c в канале не состоит). */
async function linked() {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const ch = await channel(a, [b]);
  const g = await group(a, [b, c]);
  await setLinkedChat(a.userId, ch, g);
  return { a, b, c, ch, g };
}
/** Сдвинуть отложенные задачи (конец секундного окна) на сейчас и прогнать. */
const runNow = async () => { await sql`update jobs set run_at = now()`; await drainJobs(); };

test('a post gets a copy in the discussion group (only after linking): post/origin, senderId 0, re-sealed with the group key, author reads it', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const ch = await channel(a, [b]);
  const g = await group(a, [b]);
  const before = await send(a, ch, 'до привязки');
  await setLinkedChat(a.userId, ch, g);
  expect(await copyOf(ch, before.id)).toBeNull();   // пост до привязки — без копии
  const p = await send(a, ch, 'пост с обсуждением', { entities: [{ type: 'bold', offset: 0, length: 4 }] });
  const copyId = (await copyOf(ch, p.id))!;
  expect(copyId).toBeGreaterThan(0);
  const copy = (await history(b, g)).find((m) => m.id === copyId);
  expect(copy).toMatchObject({ chatId: g, senderId: 0, post: true, origin: { chatId: ch, id: p.id }, body: 'пост с обсуждением', entities: [{ type: 'bold', offset: 0, length: 4 }], kind: 'text' });
  expect(copy.threadId).toBeUndefined();
  expect(copy.reactions).toEqual([]);   // это сообщение группы: реакции списком, а не счётчиками
  // шифр — свой (ключ группы и свой client_id), не блоб поста
  const [rp] = await sql`select content, client_id, sender_id from messages where chat_id = ${ch} and id = ${p.id}`;
  const [rc] = await sql`select content, client_id, sender_id from messages where chat_id = ${g} and id = ${copyId}`;
  expect(Buffer.compare(Buffer.from(rp.content), Buffer.from(rc.content))).not.toBe(0);
  expect(rc.client_id).not.toBe(rp.client_id);
  expect(Number(rc.sender_id)).toBe(a.userId);
  // журнал группы — обычное newMessage
  expect((await chatEventsOf(g, 'newMessage')).find((u: any) => u.message.id === copyId)).toMatchObject({ message: { origin: { chatId: ch, id: p.id }, post: true } });
  // автору копия не непрочитанная: last_read_id в группе и readOwn
  expect(Number((await sql`select last_read_id from chat_members where chat_id = ${g} and user_id = ${a.userId}`)[0].last_read_id)).toBe(copyId);
  expect((await journalOf(a.userId, 'readOwn')).some((u: any) => u.chatId === g && u.upToId === copyId)).toBe(true);
  expect(Number((await sql`select last_read_id from chat_members where chat_id = ${g} and user_id = ${b.userId}`)[0].last_read_id)).toBeLessThan(copyId);
});

test('edit, delete, link preview and checklist of the post reach the copy with group journal events', async () => {
  const { a, b, ch, g } = await linked();
  const p = await send(a, ch, 'исходный');
  const copyId = (await copyOf(ch, p.id))!;
  await editMessage(a.userId, ch, p.id, 'исправленный');
  expect((await history(b, g)).find((m) => m.id === copyId)).toMatchObject({ body: 'исправленный', editedAt: expect.any(String) });
  expect((await chatEventsOf(g, 'messageEdited')).at(-1)).toMatchObject({ chatId: g, id: copyId, body: 'исправленный' });

  // превью ссылки: копия ждала того же и получает его вместе с постом
  allowPrivateHostsForTests(true);
  const url = `http://localhost:${page.port}/page`;
  const lp = await send(a, ch, `смотри ${url}`);
  const lcopy = (await copyOf(ch, lp.id))!;
  expect((await history(b, g)).find((m) => m.id === lcopy).link).toMatchObject({ url, pending: true });
  await drainJobs();
  expect((await history(b, g)).find((m) => m.id === lcopy).link).toMatchObject({ url, title: 'Заголовок' });
  expect((await chatEventsOf(g, 'linkPreview')).at(-1)).toMatchObject({ chatId: g, id: lcopy, link: { title: 'Заголовок' } });

  // чек-лист: отметка админа — и в копии (от канала, by 0)
  const t = await send(a, ch, '', { todo: { title: 'План', items: [{ title: 'раз' }, { title: 'два' }], othersCanAppend: false, othersCanComplete: false } });
  const tcopy = (await copyOf(ch, t.id))!;
  await toggleTodo(a.userId, ch, t.id, [1], []);
  expect((await history(b, g)).find((m) => m.id === tcopy).todo.completions).toEqual([{ id: 1, by: 0, at: expect.any(String) }]);
  expect((await chatEventsOf(g, 'todoUpdated')).at(-1)).toMatchObject({ chatId: g, id: tcopy, todo: { completions: [{ id: 1, by: 0 }] } });

  await deleteMessage(a.userId, ch, p.id);
  expect((await history(b, g)).find((m) => m.id === copyId)).toMatchObject({ deleted: true, body: '' });
  expect((await chatEventsOf(g, 'messageDeleted')).at(-1)).toEqual({ type: 'messageDeleted', chatId: g, id: copyId });
});

test('the copy is managed only through the post: edit, delete, checklist toggle from the group are forbidden; a forward is from the channel', async () => {
  const { a, b, ch, g } = await linked();
  const p = await send(a, ch, 'пост');
  const copyId = (await copyOf(ch, p.id))!;
  await expect(editMessage(a.userId, g, copyId, 'тайком')).rejects.toMatchObject({ code: 'forbidden' });   // автор поста — тоже нет
  await expect(deleteMessage(a.userId, g, copyId)).rejects.toMatchObject({ code: 'forbidden' });           // владелец группы с правом удалять — тоже
  const t = await send(a, ch, '', { todo: { title: 'План', items: [{ title: 'раз' }], othersCanAppend: true, othersCanComplete: true } });
  await expect(toggleTodo(a.userId, g, (await copyOf(ch, t.id))!, [1], [])).rejects.toMatchObject({ code: 'forbidden' });
  // пересылка копии — как пересылка поста: от имени канала, ссылкой на пост
  const dm = (await ok(b, 'POST', '/chats/direct', { userId: a.userId })).id as number;
  const fwd = await send(b, dm, '', { forward: { chatId: g, id: copyId } });
  expect(fwd.fwdFrom).toMatchObject({ userId: null, name: 'Новости', chatId: ch, messageId: p.id });
  // закреп в группе — можно
  expect((await ok(a, 'POST', `/chats/${g}/pins`, { messageId: copyId })).ids).toEqual([copyId]);
});

test('comments: group members (also outside the channel) comment; a non-member is not_member; only into a live copy; replies stay in the thread', async () => {
  const { a, b, c, ch, g } = await linked();
  const outsider = await login('Глеб');
  const p = await send(a, ch, 'пост');
  const copyId = (await copyOf(ch, p.id))!;
  const c1 = await comment(b, g, copyId, 'первый');
  expect(c1).toMatchObject({ chatId: g, threadId: copyId, senderId: b.userId });
  const c2 = await comment(c, g, copyId, 'не подписчик канала', { replyToId: c1.id });   // в канале не состоит — можно
  expect(c2.replyToId).toBe(c1.id);
  await comment(b, g, copyId, 'ответ на шапку', { replyToId: copyId });
  await expect(comment(outsider, g, copyId)).rejects.toMatchObject({ code: 'not_member' });
  const plain = await send(b, g, 'просто в группе');
  await expect(comment(b, g, plain.id)).rejects.toMatchObject({ code: 'not_found' });            // не копия
  await expect(comment(b, g, copyId, 'мимо', { replyToId: plain.id })).rejects.toMatchObject({ code: 'not_found' });   // ответ вне треда
  await expect(comment(a, ch, p.id)).rejects.toMatchObject({ code: 'bad_frame' });              // тред — только в группе
  // комментарии — обычные сообщения группы: в её ленте
  expect((await history(b, g)).filter((m) => m.threadId === copyId).map((m) => m.body)).toEqual(['первый', 'не подписчик канала', 'ответ на шапку']);
});

test('message_threads: count, last and recent (commenter first, distinct, at most 3); one replies event per second window; deleting recounts', async () => {
  const { a, b, c, ch, g } = await linked();
  const p = await send(a, ch, 'пост');
  const copyId = (await copyOf(ch, p.id))!;
  // начать с начала секунды: пять комментариев — в одно окно (иначе окно закончится до drainJobs ниже)
  const [w0] = await sql`select extract(epoch from clock_timestamp()) as t`;
  await Bun.sleep((1 - (Number(w0.t) % 1)) * 1000 + 30);
  await comment(b, g, copyId, '1');
  await comment(c, g, copyId, '2');
  const x3 = await comment(b, g, copyId, '3');
  const x4 = await comment(b, g, copyId, '4');
  expect(await thread(ch, p.id)).toEqual({ count: 4, lastId: x4.id, recent: [b.userId, c.userId] });
  await comment(a, g, copyId, '5');
  const t5 = await thread(ch, p.id);
  expect(t5.recent).toEqual([a.userId, b.userId, c.userId]);
  // до конца окна событий нет; одно событие на окно с итоговыми значениями
  expect(Number((await sql`select count(*)::int as n from jobs where kind = 'replies.flush'`)[0].n)).toBeLessThanOrEqual(2);
  await drainJobs();
  expect(await chatEventsOf(ch, 'replies')).toEqual([]);
  await runNow();
  const evs = await chatEventsOf(ch, 'replies');
  expect(evs.length).toBeGreaterThanOrEqual(1);
  expect(evs.at(-1)).toEqual({ type: 'replies', chatId: ch, id: p.id, count: 5, lastId: t5.lastId, recent: [a.userId, b.userId, c.userId] });

  // два комментария в одну секунду — одна задача, одно событие
  await sql`delete from chat_updates where chat_id = ${ch} and type = 'replies'`;
  const [r0] = await sql`select extract(epoch from clock_timestamp()) as t`;
  await Bun.sleep((1 - (Number(r0.t) % 1)) * 1000 + 30);
  await comment(c, g, copyId, '6');
  await comment(c, g, copyId, '7');
  expect(Number((await sql`select count(*)::int as n from jobs where kind = 'replies.flush'`)[0].n)).toBe(1);
  await runNow();
  expect((await chatEventsOf(ch, 'replies')).length).toBe(1);

  // удаление комментария — пересчёт по сообщениям
  await deleteMessage(c.userId, g, (await history(c, g)).find((m) => m.body === '7').id);
  await deleteMessage(c.userId, g, (await history(c, g)).find((m) => m.body === '6').id);
  await deleteMessage(a.userId, g, (await history(a, g)).find((m) => m.body === '5').id);
  expect(await thread(ch, p.id)).toEqual({ count: 4, lastId: x4.id, recent: [b.userId, c.userId] });
  await runNow();
  expect((await chatEventsOf(ch, 'replies')).at(-1)).toMatchObject({ count: 4, lastId: x4.id, recent: [b.userId, c.userId] });
  expect(x3.id).toBeLessThan(x4.id);
});

test('thread page: header (the copy) and comments, before/after paging, history_from respected; not a member — not_member', async () => {
  const { a, b, c, ch, g } = await linked();
  const p = await send(a, ch, 'пост');
  const copyId = (await copyOf(ch, p.id))!;
  const ids: number[] = [];
  for (let i = 1; i <= 5; i++) ids.push((await comment(i % 2 ? b : c, g, copyId, `к${i}`)).id);
  await send(b, g, 'не в треде');
  const last = await ok(b, 'GET', `/chats/${g}/threads/${copyId}/messages?limit=2`);
  expect(last.header).toMatchObject({ id: copyId, origin: { chatId: ch, id: p.id }, body: 'пост' });
  expect(last.messages.map((m: any) => m.body)).toEqual(['к4', 'к5']);
  expect(last.hasMore).toBe(true);
  const older = await ok(b, 'GET', `/chats/${g}/threads/${copyId}/messages?limit=10&before=${ids[3]}`);
  expect(older.messages.map((m: any) => m.body)).toEqual(['к1', 'к2', 'к3']);
  expect(older.hasMore).toBe(false);
  const newer = await ok(b, 'GET', `/chats/${g}/threads/${copyId}/messages?limit=2&after=${ids[0]}`);
  expect(newer.messages.map((m: any) => m.body)).toEqual(['к2', 'к3']);
  expect(newer.hasMore).toBe(true);
  // вступил позже: видит только с history_from (шапку — всегда)
  await sql`update chat_members set history_from = ${ids[2]} where chat_id = ${g} and user_id = ${c.userId}`;
  const late = await ok(c, 'GET', `/chats/${g}/threads/${copyId}/messages?limit=50`);
  expect(late.header.id).toBe(copyId);
  expect(late.messages.map((m: any) => m.body)).toEqual(['к3', 'к4', 'к5']);
  const outsider = await login('Глеб');
  expect((await call(outsider, 'GET', `/chats/${g}/threads/${copyId}/messages`)).status).toBe(403);
  const plain = await send(b, g, 'обычное');
  expect((await call(b, 'GET', `/chats/${g}/threads/${plain.id}/messages`)).status).toBe(404);
});

test('thread read: PUT read → readThread to my own devices only; readMaxId in channel history; own comment reads the thread', async () => {
  const { a, b, c, ch, g } = await linked();
  const p = await send(a, ch, 'пост');
  const copyId = (await copyOf(ch, p.id))!;
  const k1 = await comment(c, g, copyId, 'раз');
  const k2 = await comment(c, g, copyId, 'два');
  // у автора комментария тред прочитан до своего
  expect((await journalOf(c.userId, 'readThread')).at(-1)).toEqual({ type: 'readThread', chatId: g, threadId: copyId, upToId: k2.id });
  expect(await ok(b, 'PUT', `/chats/${g}/threads/${copyId}/read`, { upToId: k1.id })).toEqual({ readMaxId: k1.id, changed: true });
  expect(await ok(b, 'PUT', `/chats/${g}/threads/${copyId}/read`, { upToId: copyId })).toEqual({ readMaxId: k1.id, changed: false });   // только растёт
  expect((await call(b, 'PUT', `/chats/${g}/threads/${copyId}/read`, { upToId: k2.id + 1000 })).status).toBe(404);
  expect(await journalOf(b.userId, 'readThread')).toEqual([{ type: 'readThread', chatId: g, threadId: copyId, upToId: k1.id }]);
  expect((await journalOf(a.userId, 'readThread'))).toEqual([]);
  expect(await chatEventsOf(g, 'readThread')).toEqual([]);   // не в журнал группы
  // история канала: кнопка с числом, последним и моей прочитанностью
  const pb = (await history(b, ch)).find((m) => m.id === p.id);
  expect(pb.replies).toEqual({ copyId, chatId: g, count: 2, lastId: k2.id, recent: [c.userId], readMaxId: k1.id });
  const pa = (await history(a, ch)).find((m) => m.id === p.id);
  expect(pa.replies).toEqual({ copyId, chatId: g, count: 2, lastId: k2.id, recent: [c.userId] });   // a тред не читал
  // журнал канала поля replies у newMessage не несёт
  expect((await chatEventsOf(ch, 'newMessage')).find((u: any) => u.message.id === p.id).message.replies).toBeUndefined();
});

test('relinking hides replies of the old threads; post deleted → copy deleted, the thread stays readable with a deleted header', async () => {
  const { a, b, ch, g } = await linked();
  const p = await send(a, ch, 'пост');
  const copyId = (await copyOf(ch, p.id))!;
  await comment(b, g, copyId, 'коммент');
  expect((await history(b, ch)).find((m) => m.id === p.id).replies).toMatchObject({ count: 1 });
  const g2 = await group(a, [b], 'Новое обсуждение');
  await setLinkedChat(a.userId, ch, g2);
  expect((await history(b, ch)).find((m) => m.id === p.id).replies).toBeUndefined();
  // старый тред живёт в старой группе
  expect((await ok(b, 'GET', `/chats/${g}/threads/${copyId}/messages`)).messages.length).toBe(1);
  // новые посты — в новую группу
  const p2 = await send(a, ch, 'второй');
  const copy2 = (await copyOf(ch, p2.id))!;
  expect((await history(b, g2)).some((m) => m.id === copy2)).toBe(true);
  await deleteMessage(a.userId, ch, p2.id);
  expect((await history(b, g2)).find((m) => m.id === copy2)).toMatchObject({ deleted: true });
  const t = await ok(b, 'GET', `/chats/${g2}/threads/${copy2}/messages`);
  expect(t.header).toMatchObject({ id: copy2, deleted: true, body: '' });
  await expect(comment(b, g2, copy2)).rejects.toMatchObject({ code: 'not_found' });   // в удалённый — нельзя
});

test('push for the copy skips channel subscribers (one push per post) and is titled with the channel', async () => {
  const { a, b, c, ch, g } = await linked();
  const { keys } = await pushBrowser();
  const sid = async (u: U) => Number((await sql`select id from sessions where user_id = ${u.userId} order by id desc limit 1`)[0].id);
  const ep = (n: number) => `https://push.invalid/ep/${n}`;
  await subscribe(b.userId, { endpoint: ep(2), keys }, await sid(b));   // b — и в канале, и в группе
  await subscribe(c.userId, { endpoint: ep(3), keys }, await sid(c));   // c — только в группе
  const p = await send(a, ch, 'новость');
  const copyId = (await copyOf(ch, p.id))!;
  const forCopy = await planPush({ chatId: g, id: copyId, senderId: a.userId, body: 'новость', post: true }, { excludeChatId: ch });
  expect(forCopy).toEqual([{ endpoint: ep(3), push: { chatId: g, id: copyId, title: 'Новости', body: 'новость' } }]);
  const forPost = await planPush({ chatId: ch, id: p.id, senderId: a.userId, body: 'новость', post: true });
  expect(forPost.map((x) => x.endpoint)).toEqual([ep(2)]);
  // обычное сообщение группы — как раньше, всем
  expect((await planPush({ chatId: g, id: copyId, senderId: a.userId, body: 'x' })).map((x) => x.endpoint).sort()).toEqual([ep(2), ep(3)]);
  // сами задачи, страницами по одной подписке: пост — b, копия — только c (b уже уведомлён как подписчик канала)
  await sql`delete from jobs where kind <> 'push.message'`;
  PUSH_PAGE.size = 1;
  try { for (let j; (j = await claim(1, 300, { only: ['push.message'] })).length;) await runJob(j[0]); } finally { PUSH_PAGE.size = 1000; }
  const delivers = await sql`select payload->>'endpoint' as e, (payload->>'chatId')::bigint as c from jobs where kind = 'push.deliver' order by e`;
  expect(delivers.map((d) => [d.e, Number(d.c)])).toEqual([[ep(2), ch], [ep(3), g]]);
});

test('album: posts sharing a group_id share one thread — the first copy is the root, comments count on every post', async () => {
  const { a, b, ch, g } = await linked();
  const groupId = crypto.randomUUID();
  const file = async (n: number) => ({ id: (await uploadFile(base, a.token, { name: `f${n}.pdf`, mime: 'application/pdf' }, 'pdf' + n) as { id: string }).id });
  const p1 = await send(a, ch, 'альбом', { attachment: await file(1), groupId });
  const p2 = await send(a, ch, '', { attachment: await file(2), groupId });
  const root = (await copyOf(ch, p1.id))!;
  expect(await copyOf(ch, p2.id)).toBe(root);   // один тред
  const [second] = await sql`select id, group_id from messages where origin->>'chatId' = ${String(ch)} and origin->>'id' = ${String(p2.id)}`;
  expect(Number(second.id)).not.toBe(root);     // своя копия — часть того же пузыря
  expect(second.group_id).toBe(groupId);
  await expect(comment(b, g, Number(second.id))).rejects.toMatchObject({ code: 'not_found' });   // не корень
  expect((await call(b, 'GET', `/chats/${g}/threads/${Number(second.id)}/messages`)).status).toBe(404);
  const k = await comment(b, g, root, 'к альбому');
  expect(await thread(ch, p1.id)).toEqual({ count: 1, lastId: k.id, recent: [b.userId] });
  expect(await thread(ch, p2.id)).toEqual({ count: 1, lastId: k.id, recent: [b.userId] });
  await runNow();
  const ev = (await chatEventsOf(ch, 'replies')) as { id: number; count: number }[];
  expect(ev.map((e) => [e.id, e.count]).sort()).toEqual([[p1.id, 1], [p2.id, 1]].sort());
  const h = await history(b, ch);
  expect(h.find((m) => m.id === p2.id).replies).toMatchObject({ copyId: root, count: 1 });
  // правка второго поста — правит его собственную копию
  await editMessage(a.userId, ch, p2.id, 'подпись');
  const [e2] = await opened(await sql`select * from messages where id = ${Number(second.id)}`);
  expect(e2.body).toBe('подпись');
  // комментарий удалён — пересчёт на обоих постах
  await deleteMessage(b.userId, g, k.id);
  expect(await thread(ch, p2.id)).toEqual({ count: 0, lastId: null, recent: [] });
});

test('after relinking, comments in the old group do not emit replies into the channel journal', async () => {
  const { a, b, ch, g } = await linked();
  const p = await send(a, ch, 'пост');
  const copyId = (await copyOf(ch, p.id))!;
  await comment(b, g, copyId, 'до');
  await runNow();
  const before = (await chatEventsOf(ch, 'replies')).length;
  expect(before).toBe(1);
  const g2 = await group(a, [b], 'Новое обсуждение');
  await setLinkedChat(a.userId, ch, g2);
  await comment(b, g, copyId, 'после перепривязки');   // старая группа: тред читается и пишется, кнопки у поста нет
  const k = await comment(b, g, copyId, 'ещё');
  await deleteMessage(b.userId, g, k.id);
  await runNow();
  expect((await chatEventsOf(ch, 'replies')).length).toBe(before);
  expect((await sql`select 1 from jobs where kind = 'replies.flush'`).length).toBe(0);
});

test('the author\'s copy is read for them only when everything before it in the group is read', async () => {
  const { a, b, ch, g } = await linked();
  const hi = await send(b, g, 'привет в группе');   // a его ещё не прочитала
  const p = await send(a, ch, 'пост');
  const copyId = (await copyOf(ch, p.id))!;
  const [m] = await sql`select last_read_id from chat_members where chat_id = ${g} and user_id = ${a.userId}`;
  expect(Number(m.last_read_id)).toBeLessThan(hi.id);   // чужое перед копией осталось непрочитанным
  expect((await ok(a, 'GET', '/chats?ids=' + g))[0].unread).toBeGreaterThanOrEqual(1);
  // всё прочитано — следующая копия прочитана автору сразу
  await markRead(a.userId, g, copyId);
  const p2 = await send(a, ch, 'пост 2');
  const copy2 = (await copyOf(ch, p2.id))!;
  const [m2] = await sql`select last_read_id from chat_members where chat_id = ${g} and user_id = ${a.userId}`;
  expect(Number(m2.last_read_id)).toBe(copy2);
});

// ---------- комментарии без вступления в группу обсуждения (гость треда) ----------

/** Канал a (подписчики b, d) с группой обсуждения (a, b); d в группе не состоит — гость; x — ни там, ни там. Пост с копией. */
async function guests() {
  const a = await login('Анна'), b = await login('Борис'), d = await login('Дина'), x = await login('Чужой');
  const ch = await channel(a, [b, d]);
  const g = await group(a, [b]);
  await setLinkedChat(a.userId, ch, g);
  const p = await send(a, ch, 'пост');
  return { a, b, d, x, ch, g, p, copyId: (await copyOf(ch, p.id))! };
}
async function connect(u: U): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?token=${u.token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}
const frame = (ws: WebSocket, f: Record<string, unknown>) => { ws.send(JSON.stringify(f)); return nextFrame(ws, (x) => (x.op === 'ack' || x.op === 'err') && x.reqId === f.reqId); };
const collect = (ws: WebSocket) => { const got: ServerFrame[] = []; ws.addEventListener('message', (e) => got.push(JSON.parse(String(e.data)))); return got; };

test('a channel subscriber outside the group reads the thread (all comments, guest info), comments and reads it — and stays a non-member', async () => {
  const { a, b, d, ch, g, copyId } = await guests();
  const k1 = await comment(b, g, copyId, 'от участника');
  const page = await ok(d, 'GET', `/chats/${g}/threads/${copyId}/messages?limit=50`);
  expect(page.header).toMatchObject({ id: copyId, origin: { chatId: ch } });
  expect(page.messages.map((m: any) => m.body)).toEqual(['от участника']);
  expect(page.guest).toEqual({ channelId: ch, title: 'Обсуждение', username: null, joinToSend: false, joinApproval: false, slowMode: 0 });
  expect((await ok(b, 'GET', `/chats/${g}/threads/${copyId}/messages`)).guest).toBeUndefined();   // участнику — без guest
  // комментирует, не вступая: обычное сообщение группы, счётчик треда, своя прочитанность треда
  const mine = await comment(d, g, copyId, 'от гостя', { replyToId: k1.id });
  expect(mine).toMatchObject({ chatId: g, threadId: copyId, senderId: d.userId, replyToId: k1.id });
  expect(await thread(ch, (await sql`select post_id from message_threads where copy_id = ${copyId}`)[0].post_id)).toMatchObject({ count: 2, recent: [d.userId, b.userId] });
  expect((await journalOf(d.userId, 'readThread')).at(-1)).toEqual({ type: 'readThread', chatId: g, threadId: copyId, upToId: mine.id });
  const k3 = await comment(b, g, copyId, 'ещё');
  expect(await ok(d, 'PUT', `/chats/${g}/threads/${copyId}/read`, { upToId: k3.id })).toEqual({ readMaxId: k3.id, changed: true });
  expect(Number((await sql`select read_max_id from thread_reads where user_id = ${d.userId} and chat_id = ${g} and thread_id = ${copyId}`)[0].read_max_id)).toBe(k3.id);
  // история канала: кнопка с моей прочитанностью; группа в список не попала, журнала группы и членства нет
  const post = (await history(d, ch)).find((m) => m.replies);
  expect(post.replies).toMatchObject({ copyId, chatId: g, count: 3, readMaxId: k3.id });
  expect((await ok(d, 'GET', '/chats')).map((c: any) => c.id)).not.toContain(g);
  expect((await sql`select 1 from chat_members where chat_id = ${g} and user_id = ${d.userId}`).length).toBe(0);
  expect((await journalOf(d.userId, 'membership')).some((u: any) => u.chatId === g)).toBe(false);
  expect((await call(d, 'GET', `/chats/${g}/messages?limit=10`)).status).toBe(403);   // лента группы — только участникам
  // профили комментаторов гостю видны (имя над комментарием); участник группы, не писавший в треды, — нет
  const quiet = await login('Тихий');
  await ok(a, 'POST', `/groups/${g}/members`, { userIds: [quiet.userId] });
  const seen = (await ok(d, 'GET', `/users?ids=${b.userId},${quiet.userId}`)).users.map((u: any) => u.id);
  expect(seen).toEqual([b.userId]);
  void a;
});

test('neither in the channel nor in the group → not_member everywhere; a copy from a channel the user left or relinked away → not_member', async () => {
  const { a, d, x, ch, g, copyId } = await guests();
  await expect(comment(x, g, copyId)).rejects.toMatchObject({ code: 'not_member' });
  expect((await call(x, 'GET', `/chats/${g}/threads/${copyId}/messages`)).status).toBe(403);
  expect((await call(x, 'PUT', `/chats/${g}/threads/${copyId}/read`, { upToId: copyId })).status).toBe(403);
  // обычное сообщение группы — не тред: гостем не прочитать
  const plain = await send(a, g, 'в группе');
  await expect(comment(d, g, plain.id)).rejects.toMatchObject({ code: 'not_member' });
  // вышел из канала — больше не гость
  await ok(d, 'DELETE', `/groups/${ch}/members/${d.userId}`);
  await expect(comment(d, g, copyId)).rejects.toMatchObject({ code: 'not_member' });
  expect((await call(d, 'GET', `/chats/${g}/threads/${copyId}/messages`)).status).toBe(403);
  // перепривязка: тред старой группы гостю закрыт (группа уже не обсуждение этого канала)
  const e = await login('Ева');
  await ok(a, 'POST', `/groups/${ch}/members`, { userIds: [e.userId] });
  expect((await ok(e, 'GET', `/chats/${g}/threads/${copyId}/messages`)).guest).toMatchObject({ channelId: ch });
  await setLinkedChat(a.userId, ch, await group(a, [e], 'Новое'));
  expect((await call(e, 'GET', `/chats/${g}/threads/${copyId}/messages`)).status).toBe(403);
  // исключённый из группы — не гость
  const f = await login('Фёдор');
  await ok(a, 'POST', `/groups/${ch}/members`, { userIds: [f.userId] });
  await setLinkedChat(a.userId, ch, g);
  await ok(a, 'POST', `/groups/${g}/members`, { userIds: [f.userId] });
  await ok(a, 'DELETE', `/groups/${g}/members/${f.userId}`);
  await sql`insert into chat_bans (chat_id, user_id, banned_by) values (${g}, ${f.userId}, ${a.userId}) on conflict do nothing`;
  await expect(comment(f, g, copyId)).rejects.toMatchObject({ code: 'not_member' });
});

test('join_to_send: set by group admins, round-trips in GroupInfo; guests read but cannot comment (forbidden join); join approval too; joining from the thread', async () => {
  const { a, b, d, ch, g, copyId } = await guests();
  expect((await ok(a, 'GET', '/chats?ids=' + g))[0].group.joinToSend).toBe(false);
  expect((await call(b, 'PUT', `/groups/${g}/settings`, { joinToSend: true })).status).toBe(403);   // не админ
  expect((await call(a, 'PUT', `/groups/${ch}/settings`, { joinToSend: true })).status).toBe(400);  // у канала такой настройки нет
  await ok(a, 'PUT', `/groups/${g}/settings`, { joinToSend: true });
  expect((await ok(b, 'GET', '/chats?ids=' + g))[0].group.joinToSend).toBe(true);
  expect((await chatEventsOf(g, 'groupUpdated')).at(-1)).toMatchObject({ group: { joinToSend: true } });
  expect((await ok(d, 'GET', `/chats/${g}/threads/${copyId}/messages`)).guest).toMatchObject({ joinToSend: true });
  await expect(comment(d, g, copyId)).rejects.toMatchObject({ code: 'forbidden', message: 'join' });
  await comment(b, g, copyId, 'участнику можно');
  await ok(a, 'PUT', `/groups/${g}/settings`, { joinToSend: false });
  await comment(d, g, copyId, 'снова можно');
  // одобрение вступающих — тоже сначала вступить (заявкой)
  await ok(a, 'PUT', `/groups/${g}/settings`, { joinApproval: true });
  expect((await ok(d, 'GET', `/chats/${g}/threads/${copyId}/messages`)).guest).toMatchObject({ joinToSend: false, joinApproval: true });
  await expect(comment(d, g, copyId)).rejects.toMatchObject({ code: 'forbidden' });
  expect(await ok(d, 'POST', `/groups/${g}/join`)).toEqual({ chatId: g, requested: true });
  await ok(a, 'PUT', `/groups/${g}/settings`, { joinApproval: false });   // выключили — заявка принята
  expect((await sql`select 1 from chat_members where chat_id = ${g} and user_id = ${d.userId}`).length).toBe(1);
  expect((await ok(d, 'GET', `/chats/${g}/threads/${copyId}/messages`)).guest).toBeUndefined();
  // вступить из треда может только подписчик канала этой группы
  const x = await login('Чужой');
  expect((await call(x, 'POST', `/groups/${g}/join`)).status).toBe(404);
  const e = await login('Ева');
  await ok(a, 'POST', `/groups/${ch}/members`, { userIds: [e.userId] });
  expect(await ok(e, 'POST', `/groups/${g}/join`)).toEqual({ chatId: g, requested: false });
});

test('watchThread: the guest socket gets threadPush with only this thread\'s events; after unwatch nothing; auth like reading', async () => {
  const { a, b, d, x, ch, g, copyId } = await guests();
  const wd = await connect(d), wb = await connect(b), wx = await connect(x);
  expect(await frame(wd, { op: 'watchThread', reqId: 'w1', chatId: g, threadId: copyId })).toMatchObject({ op: 'ack', result: { guest: true } });
  expect(await frame(wb, { op: 'watchThread', reqId: 'w2', chatId: g, threadId: copyId })).toMatchObject({ op: 'ack', result: { guest: false } });   // участнику — топик чата
  expect(await frame(wx, { op: 'watchThread', reqId: 'w3', chatId: g, threadId: copyId })).toMatchObject({ op: 'err', code: 'not_member' });
  const gotD = collect(wd), gotB = collect(wb);
  const pushed = nextFrame(wd, (f) => f.op === 'threadPush');
  const k = await comment(b, g, copyId, 'живой');
  expect(await pushed).toMatchObject({ op: 'threadPush', chatId: g, threadId: copyId, items: [{ type: 'newMessage', message: { id: k.id, body: 'живой', threadId: copyId } }] });
  // правка комментария и шапки (правка поста) — тоже; сообщение группы вне треда — нет
  await send(a, g, 'мимо треда');
  const edited = nextFrame(wd, (f) => f.op === 'threadPush' && f.items.some((u) => u.type === 'messageEdited'));
  await editMessage(b.userId, g, k.id, 'исправлен');
  expect(await edited).toMatchObject({ items: [{ type: 'messageEdited', chatId: g, id: k.id, body: 'исправлен' }] });
  const head = nextFrame(wd, (f) => f.op === 'threadPush' && f.items.some((u) => u.type === 'messageEdited' && u.id === copyId));
  await editMessage(a.userId, ch, (await sql`select post_id from message_threads where copy_id = ${copyId}`)[0].post_id, 'пост исправлен');
  await head;
  expect(gotD.some((f) => f.op === 'push' && (f as any).chatId === g)).toBe(false);   // журнала группы гость не получает (канала — да)
  expect(gotD.filter((f) => f.op === 'threadPush').flatMap((f: any) => f.items).some((u: any) => u.message?.body === 'мимо треда')).toBe(false);
  expect(gotB.some((f) => f.op === 'threadPush')).toBe(false);   // участник — своим push группы
  expect(gotB.some((f) => f.op === 'push' && (f as any).chatId === g)).toBe(true);
  // информация группы — гостю тоже («только участники» меняет поле ввода сразу)
  const upd = nextFrame(wd, (f) => f.op === 'threadPush' && f.items.some((u) => u.type === 'groupUpdated'));
  await ok(a, 'PUT', `/groups/${g}/settings`, { joinToSend: true });
  expect(await upd).toMatchObject({ threadId: copyId, items: [{ type: 'groupUpdated', chatId: g, group: { joinToSend: true } }] });
  // unwatch — больше ничего
  expect(await frame(wd, { op: 'unwatchThread', reqId: 'u1', chatId: g, threadId: copyId })).toMatchObject({ op: 'ack' });
  const n = gotD.length;
  const seen = nextFrame(wb, (f) => f.op === 'push' && f.items.some((i) => i.update.type === 'newMessage' && (i.update as any).message.body === 'после'));
  await comment(b, g, copyId, 'после');
  await seen;
  await Bun.sleep(100);
  expect(gotD.slice(n).some((f) => f.op === 'threadPush')).toBe(false);
  wd.close(); wb.close(); wx.close();
});

test('a guest opens files of comments in the thread', async () => {
  const { b, d, x, g, copyId } = await guests();
  const f = await uploadFile(base, b.token, { name: 'c.pdf', mime: 'application/pdf' }, 'pdf') as { id: string };
  await comment(b, g, copyId, 'файл', { attachment: { id: f.id } });
  const get = (u: U) => fetch(`${base}/files/${f.id}`, { headers: hdr(u), redirect: 'manual' });
  expect((await get(d)).status).toBe(302);
  expect((await get(x)).status).toBe(404);
});

test('a guest edits and deletes own comments and reacts in the thread; outside the thread — not_member', async () => {
  const { a, b, d, ch, g, copyId } = await guests();
  const mine = await comment(d, g, copyId, 'черновик');
  await editMessage(d.userId, g, mine.id, 'исправил');
  expect((await ok(d, 'GET', `/chats/${g}/threads/${copyId}/messages`)).messages.find((m: any) => m.id === mine.id)).toMatchObject({ body: 'исправил' });
  const other = await comment(b, g, copyId, 'чужой');
  await expect(editMessage(d.userId, g, other.id, 'нельзя')).rejects.toMatchObject({ code: 'forbidden' });
  expect((await reactMessage(d.userId, g, other.id, '👍')).reactions).toEqual([{ userId: d.userId, emoji: '👍' }]);
  await reactMessage(d.userId, g, copyId, '🔥');   // шапка треда — тоже
  await deleteMessage(d.userId, g, mine.id);
  expect(await thread(ch, (await sql`select post_id from message_threads where copy_id = ${copyId}`)[0].post_id)).toMatchObject({ count: 1 });
  const plain = await send(a, g, 'в группе');
  await expect(reactMessage(d.userId, g, plain.id, '👍')).rejects.toMatchObject({ code: 'not_member' });
  await expect(deleteMessage(d.userId, g, plain.id)).rejects.toMatchObject({ code: 'not_member' });
});
