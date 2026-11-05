import { afterAll, beforeEach, expect, test } from 'bun:test';
import type { ServerFrame } from '@relay/protocol';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { handleFrame } from '../src/ws';
import { createChat, createGroup, listChats } from '../src/domain/chats';
import { sendMessage } from '../src/domain/messages';
import { deleteMessage, editMessage } from '../src/domain/messageOps';
import { pinMessage } from '../src/domain/pins';
import { markRead } from '../src/domain/reads';
import { planPush, subscribe } from '../src/domain/push';
import { canView, viewersOf } from '../src/domain/profile';
import { deleteGroup, setLinkedChat } from '../src/domain/groups';
import { appendTodo, toggleTodo } from '../src/domain/todo';
import { unarchiveByMessage } from '../src/domain/chatFlags';
import { PURGE } from '../src/domain/chatPurge';
import { DomainError } from '../src/domain/errors';
import '../src/jobs/kinds';
import { drainJobs } from '../src/jobs/worker';
import { chatEventsOf, journalOf, makeChat, makeUser, pushBrowser, resetDb, refs } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
// поддельный push-сервис: копит пути запросов
const pushed: string[] = [];
const pushSvc = Bun.serve({ port: 0, async fetch(req) { pushed.push(new URL(req.url).pathname); await req.arrayBuffer(); return new Response(null, { status: 201 }); } });
afterAll(() => { server.stop(true); pushSvc.stop(true); });
beforeEach(async () => { await resetDb(); pushed.length = 0; });

type U = { userId: number; token: string };
const login = async (name: string): Promise<U> => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const hdr = (u: U) => ({ cookie: `relay_session=${u.token}`, 'content-type': 'application/json' });
const call = (u: U, method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: hdr(u), body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async (u: U, method: string, path: string, body?: unknown) => {
  const r = await call(u, method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
const channel = async (owner: U, members: U[] = [], title = 'Новости') => (await ok(owner, 'POST', '/chats', { kind: 'channel', title, members: refs(owner.userId, members.map((m) => m.userId)) })).id as number;
const group = async (owner: U, members: U[], title = 'Обсуждение') => (await ok(owner, 'POST', '/chats', { title, members: refs(owner.userId, members.map((m) => m.userId)) })).id as number;
const post = (u: U, chatId: number, body = 'пост', extra: Record<string, unknown> = {}) => sendMessage(u.userId, { chatId, clientId: crypto.randomUUID(), body, ...extra });
const summary = async (u: U, id: number) => { const l = await ok(u, 'GET', `/chats?ids=${id}`); return (l.chats ?? l).find((x: any) => x.id === id); };
const membersCount = async (id: number) => Number((await sql`select members_count from chats where id = ${id}`)[0].members_count);
const realCount = async (id: number) => Number((await sql`select count(*)::int as n from chat_members where chat_id = ${id}`)[0].n);
const services = async (chatId: number) => (await sql`select service_type from messages where chat_id = ${chatId} and service_type is not null order by id`).map((r) => r.service_type);
const makeAdmin = (owner: U, chatId: number, target: U, rights: Record<string, boolean>) => ok(owner, 'PUT', `/groups/${chatId}/admins/${target.userId}`, { rights });

test('create: a channel with zero members (creator is the owner) and with subscribers; summary carries kind, rights and counts', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const empty = await channel(a);
  expect(await membersCount(empty)).toBe(1);
  const s0 = await summary(a, empty);
  expect(s0).toMatchObject({ kind: 'channel', group: { title: 'Новости', members: 1, ownerId: a.userId, signatures: false, linkedChatId: null }, me: { role: 'owner' } });
  expect(s0.me.admin).toEqual({ info: true, post: true, edit: true, delete: true, ban: true, invite: true, pin: false, addAdmins: true });   // pin — право группы, у канала его нет
  expect(s0.peerReadUpTo).toBe(0);

  const id = await channel(a, [b, c]);
  expect(await membersCount(id)).toBe(3);
  const sb = await summary(b, id);
  expect(sb).toMatchObject({ kind: 'channel', group: { members: 3 }, me: { role: 'member', admin: null } });
  expect(Object.entries(sb.me.rights).filter(([, v]) => v).map(([k]) => k)).toEqual(['react']);   // подписчик: только реакции
  // чат приходит подписчику через membership с seq журнала канала
  expect((await journalOf(b.userId, 'membership')).at(-1)).toMatchObject({ chatId: id });
  // группа без участников — как раньше нельзя; неизвестный вид — 400
  expect((await call(a, 'POST', '/chats', { title: 'Г', members: refs(a.userId, []) })).status).toBe(400);
  expect((await call(a, 'POST', '/chats', { kind: 'forum', title: 'Ф', members: refs(a.userId, [b.userId]) })).status).toBe(400);
  // about — сразу при создании
  const { chatId } = await createGroup(a.userId, { kind: 'channel', title: 'С описанием', about: '  про всё  ' });
  expect((await sql`select about, kind from chats where id = ${chatId}`)[0]).toMatchObject({ about: 'про всё', kind: 'channel' });
});

test('members_count is kept by the trigger on every path: createChat, createGroup, add, remove, leave, join by link', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера'), d = await login('Глеб');
  const direct = await createChat('direct', null, [a.userId, b.userId]);
  expect(await membersCount(direct)).toBe(2);
  const g = await group(a, [b]);
  expect(await membersCount(g)).toBe(2);
  const id = await channel(a, [b]);
  await ok(a, 'POST', `/groups/${id}/members`, { users: refs(a.userId, [c.userId]) });
  expect(await membersCount(id)).toBe(3);
  await ok(b, 'DELETE', `/groups/${id}/members/${b.userId}`);   // вышел сам
  expect(await membersCount(id)).toBe(2);
  await ok(a, 'DELETE', `/groups/${id}/members/${c.userId}`);   // удалён (бан)
  expect(await membersCount(id)).toBe(1);
  const { invites } = await ok(a, 'GET', `/groups/${id}/invites`);
  await ok(d, 'POST', `/join/+${invites.find((i: any) => i.primary).link}`);
  expect(await membersCount(id)).toBe(2);
  for (const x of [direct, g, id]) expect(await membersCount(x)).toBe(await realCount(x));
  expect((await summary(a, id)).group.members).toBe(2);
});

test('posting: subscribers are forbidden, an admin needs the post right; replies are refused in a channel', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await channel(a, [b, c]);
  await expect(post(b, id)).rejects.toMatchObject({ code: 'forbidden' });
  await makeAdmin(a, id, c, { info: true, pin: true });   // pin у канала не бывает — отбрасывается
  expect((await sql`select admin_rights from chat_members where chat_id = ${id} and user_id = ${c.userId}`)[0].admin_rights).toMatchObject({ info: true, pin: false, post: false });
  await expect(post(c, id)).rejects.toMatchObject({ code: 'forbidden' });
  await makeAdmin(a, id, c, { post: true });
  const { message } = await post(c, id, 'от админа');
  expect(message).toMatchObject({ senderId: 0, post: true, body: 'от админа' });
  await expect(post(a, id, 'ответ', { replyToId: message.id })).rejects.toMatchObject({ code: 'bad_frame' });
});

test('a post is anonymous: senderId 0 everywhere, postAuthor only with signatures on', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await channel(a, [b]);
  const first = (await post(a, id, 'без подписи')).message;
  expect(first).toMatchObject({ senderId: 0, post: true });
  expect(first.postAuthor).toBeUndefined();
  expect((await sql`select sender_id, post, post_author from messages where id = ${first.id}`)[0]).toMatchObject({ sender_id: a.userId, post: true, post_author: null });
  // подписи — настройка канала (право info); у группы такой нет
  expect((await call(b, 'PUT', `/groups/${id}/settings`, { signatures: true })).status).toBe(403);
  await ok(a, 'PUT', `/groups/${id}/settings`, { signatures: true });
  expect((await chatEventsOf(id, 'groupUpdated')).at(-1)).toMatchObject({ group: { signatures: true } });
  const second = (await post(a, id, 'с подписью')).message;
  expect(second).toMatchObject({ senderId: 0, post: true, postAuthor: 'Анна' });
  // журнал канала, история и строка списка — тот же вид
  const evs = (await chatEventsOf(id, 'newMessage')).map((u: any) => u.message).filter((m: any) => m.post && !m.service);
  expect(evs.map((m: any) => [m.senderId, m.postAuthor ?? null])).toEqual([[0, null], [0, 'Анна']]);
  const hist = await ok(b, 'GET', `/chats/${id}/messages`);
  expect(hist.messages.filter((m: any) => !m.service).map((m: any) => m.senderId)).toEqual([0, 0]);
  expect((await summary(b, id)).last).toMatchObject({ id: second.id, senderId: 0, post: true, postAuthor: 'Анна' });
  const g = await group(a, [b]);
  expect((await call(a, 'PUT', `/groups/${g}/settings`, { signatures: true })).status).toBe(400);
});

test('own post is not unread: the author’s last_read_id is raised and readOwn goes to the author’s journal', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await channel(a, [b]);
  const [ua, ub] = [(await summary(a, id)).unread, (await summary(b, id)).unread];   // «создал(а)» — непрочитанное у подписчика
  const { message } = await post(a, id);
  expect(Number((await sql`select last_read_id from chat_members where chat_id = ${id} and user_id = ${a.userId}`)[0].last_read_id)).toBe(message.id);
  expect((await journalOf(a.userId, 'readOwn')).at(-1)).toEqual({ type: 'readOwn', chatId: id, upToId: message.id });
  expect((await summary(a, id)).unread).toBe(ua);
  expect(ua).toBe(0);
  expect((await summary(b, id)).unread).toBe(ub + 1);
});

test('edit and delete by rights: own always, others’ with edit/delete; pin only with post', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера'), d = await login('Глеб');
  const id = await channel(a, [b, c, d]);
  await makeAdmin(a, id, c, { post: true });
  await makeAdmin(a, id, d, { edit: true, delete: true });
  const own = (await post(c, id, 'моё')).message;
  const owners = (await post(a, id, 'владельца')).message;
  await editMessage(c.userId, id, own.id, 'моё, исправлено');   // своё — всегда
  await expect(editMessage(c.userId, id, owners.id, 'чужое')).rejects.toMatchObject({ code: 'forbidden' });
  await expect(editMessage(b.userId, id, owners.id, 'подписчик')).rejects.toMatchObject({ code: 'forbidden' });
  await editMessage(d.userId, id, owners.id, 'правка админом');   // edit — и чужое
  expect((await chatEventsOf(id, 'messageEdited')).at(-1)).toMatchObject({ id: owners.id, body: 'правка админом' });
  await expect(deleteMessage(c.userId, id, owners.id)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(deleteMessage(b.userId, id, own.id)).rejects.toMatchObject({ code: 'forbidden' });
  await deleteMessage(d.userId, id, own.id);
  await deleteMessage(a.userId, id, owners.id);
  const third = (await post(a, id)).message;
  await expect(pinMessage(b.userId, id, third.id)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(pinMessage(d.userId, id, third.id)).rejects.toMatchObject({ code: 'forbidden' });   // без post
  expect(await pinMessage(c.userId, id, third.id)).toEqual({ ids: [third.id] });
});

test('join by invite and by @name: no service message, no groupUpdated, no members event; membership with seq; preview says subscribers', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await channel(a, [b]);
  await post(a, id);
  const { invites } = await ok(a, 'GET', `/groups/${id}/invites`);
  const link = invites.find((i: any) => i.primary).link;
  expect(await ok(c, 'GET', `/join/+${link}`)).toMatchObject({ chatId: id, kind: 'channel', members: 2, member: false });
  const before = { updated: (await chatEventsOf(id, 'groupUpdated')).length, members: (await chatEventsOf(id, 'members')).length };
  await ok(c, 'POST', `/join/+${link}`);
  expect(await services(id)).toEqual(['channel_created']);
  expect((await chatEventsOf(id, 'groupUpdated')).length).toBe(before.updated);
  expect((await chatEventsOf(id, 'members')).length).toBe(0);
  expect(before.members).toBe(0);
  const seq = Number((await sql`select seq from chat_seq where chat_id = ${id}`)[0].seq);
  expect((await journalOf(c.userId, 'membership')).at(-1)).toMatchObject({ chatId: id, seq, me: { role: 'member' } });
  expect(await membersCount(id)).toBe(3);
  // публичный канал: вступление по @имени тем же путём
  await ok(a, 'PUT', `/groups/${id}/username`, { username: 'relaynews' });
  const d = await login('Глеб');
  expect(await ok(d, 'POST', '/join/@relaynews')).toMatchObject({ chatId: id, requested: false });
  expect(await services(id)).toEqual(['channel_created']);
  // подписчики не видят друг друга: канал не общий чат
  expect(await canView(sql, c.userId, d.userId)).toBe(false);
  expect(await viewersOf(sql, c.userId)).not.toContain(d.userId);
  expect(await journalOf(c.userId, 'userUpdated')).toEqual([]);
});

test('members list is for admins only; subscribers get forbidden', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await channel(a, [b, c]);
  expect((await call(b, 'GET', `/groups/${id}/members`)).status).toBe(403);
  expect((await call(b, 'GET', `/chats/${id}/members`)).status).toBe(403);
  expect((await ok(a, 'GET', `/groups/${id}/members`)).members.map((m: any) => m.userId).sort()).toEqual([a.userId, b.userId, c.userId].sort());
  await makeAdmin(a, id, c, { post: true });
  expect((await ok(c, 'GET', `/chats/${id}/members`)).members.length).toBe(3);
});

test('reading a channel writes no readBy; readOwn still goes to the reader', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await channel(a, [b]);
  const { message } = await post(a, id);
  const before = (await journalOf(a.userId, 'readBy')).length;
  expect(await markRead(b.userId, id, message.id)).toEqual({ lastReadId: message.id, changed: true });
  expect((await journalOf(a.userId, 'readBy')).length).toBe(before);
  expect(before).toBe(0);
  expect((await journalOf(b.userId, 'readOwn')).at(-1)).toEqual({ type: 'readOwn', chatId: id, upToId: message.id });
});

test('typing in a channel: a subscriber is ignored, an admin with post is published to the chat topic as the channel (userId 0)', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const { chatId: id } = await createGroup(a, { kind: 'channel', title: 'К', memberIds: [b] });
  const got: [string, any][] = [];
  const publish = (topic: string, msg: string) => { got.push([topic, JSON.parse(msg)]); };
  expect(await handleFrame(b, { op: 'typing', chatId: id }, publish)).toEqual([]);
  expect(got).toEqual([]);
  await handleFrame(a, { op: 'typing', chatId: id }, publish);
  expect(got).toEqual([[`chat:${id}`, { op: 'typing', chatId: id, userId: 0 }]]);   // какой админ пишет — не раскрывается
  // в группе — как раньше, с автором
  const g = await makeChat([a, b], 'group');
  await handleFrame(a, { op: 'typing', chatId: g }, publish);
  expect(got.at(-1)).toEqual([`chat:${g}`, { op: 'typing', chatId: g, userId: a }]);
});

test('discussion group: linking sets both rows, turns hidden history off and keeps it off; a group linked elsewhere is refused; relink and unlink', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const ch = await channel(a, [b]);
  const g1 = await group(a, [b], 'Обсуждение 1'), g2 = await group(a, [b], 'Обсуждение 2');
  await ok(a, 'PUT', `/groups/${g1}/settings`, { historyHidden: true });
  // кандидаты: мои группы, где я админ с info, ни к чему не привязанные
  const bOwn = await group(b, [a], 'Чужая');
  expect((await ok(a, 'GET', `/groups/${ch}/discussion-candidates`)).groups.map((x: any) => x.id).sort()).toEqual([g1, g2].sort());
  expect((await call(b, 'GET', `/groups/${ch}/discussion-candidates`)).status).toBe(403);   // подписчик
  expect((await call(a, 'PUT', `/groups/${ch}/discussion`, { groupId: bOwn })).status).toBe(403);   // в чужой группе я не админ
  expect((await call(b, 'PUT', `/groups/${ch}/discussion`, { groupId: g1 })).status).toBe(403);     // не владелец канала

  await ok(a, 'PUT', `/groups/${ch}/discussion`, { groupId: g1 });
  const link = async (id: number) => { const [r] = await sql`select linked_chat_id, history_hidden from chats where id = ${id}`; return [r.linked_chat_id == null ? null : Number(r.linked_chat_id), r.history_hidden]; };
  expect(await link(ch)).toEqual([g1, false]);
  expect(await link(g1)).toEqual([ch, false]);
  expect((await chatEventsOf(ch, 'groupUpdated')).at(-1)).toMatchObject({ group: { linkedChatId: g1 } });
  expect((await chatEventsOf(g1, 'groupUpdated')).at(-1)).toMatchObject({ group: { linkedChatId: ch, historyHidden: false } });
  expect((await call(a, 'PUT', `/groups/${g1}/settings`, { historyHidden: true })).status).toBe(403);   // пока привязана — не включить
  expect((await ok(a, 'GET', `/groups/${ch}/discussion-candidates`)).groups.map((x: any) => x.id)).toEqual([g2]);

  // группа уже обсуждение другого канала — нельзя; одновременные попытки двух каналов на одну группу: ровно одна проходит
  const ch2 = await channel(a, [], 'Второй');
  expect((await call(a, 'PUT', `/groups/${ch2}/discussion`, { groupId: g1 })).status).toBe(403);
  const ch3 = await channel(a, [], 'Третий');
  const race = await Promise.allSettled([setLinkedChat(a.userId, ch2, g2), setLinkedChat(a.userId, ch3, g2)]);
  expect(race.filter((r) => r.status === 'fulfilled').length).toBe(1);
  expect((race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'forbidden' });
  const winner = race[0].status === 'fulfilled' ? ch2 : ch3;
  expect(await link(g2)).toEqual([winner, false]);

  // перепривязка: прежняя группа отвязывается; отвязка — обе строки
  await ok(a, 'PUT', `/groups/${winner}/discussion`, { groupId: null });
  await ok(a, 'PUT', `/groups/${ch}/discussion`, { groupId: g2 });
  expect(await link(g1)).toEqual([null, false]);
  expect(await link(ch)).toEqual([g2, false]);
  expect((await chatEventsOf(g1, 'groupUpdated')).at(-1)).toMatchObject({ group: { linkedChatId: null } });
  await ok(a, 'PUT', `/groups/${ch}/discussion`, { groupId: null });
  expect(await link(ch)).toEqual([null, false]);
  expect(await link(g2)).toEqual([null, false]);
  await ok(a, 'PUT', `/groups/${g1}/settings`, { historyHidden: true });   // отвязанной снова можно
});

test('delete is soft and the purge runs in pages: chat gone at once, chatRemoved to everyone page by page, rows and the chat row gone at the end', async () => {
  const prevPage = PURGE.page;
  PURGE.page = 2;
  try {
    const a = await login('Анна');
    const subs = await Promise.all(['Б', 'В', 'Г', 'Д', 'Е'].map((n) => login(n)));
    const id = await channel(a, subs);
    for (let i = 0; i < 4; i++) await post(a, id, `пост ${i}`);
    const { invites } = await ok(a, 'GET', `/groups/${id}/invites`);
    const link = invites.find((i: any) => i.primary).link;
    await drainJobs();
    expect((await call(subs[0], 'DELETE', `/groups/${id}`)).status).toBe(403);
    await ok(a, 'DELETE', `/groups/${id}`);
    expect((await sql`select deleted_at from chats where id = ${id}`)[0].deleted_at).not.toBeNull();
    // сразу «пропал»: операции — not_found, syncChat — chatGone, нет в списке, ссылка не открывается
    await expect(post(a, id)).rejects.toMatchObject({ code: 'not_found' });
    const gone = await handleFrame(subs[0].userId, { op: 'syncChat', reqId: 'r1', chatId: id, since: 0 });
    expect(gone).toEqual([{ op: 'chatGone', reqId: 'r1', chatId: id } satisfies ServerFrame]);
    expect((await listChats(subs[0].userId)).map((c) => c.id)).not.toContain(id);
    expect((await call(subs[1], 'GET', `/join/+${link}`)).status).toBe(404);
    expect((await call(subs[1], 'GET', `/chats/${id}/messages`)).status).toBe(404);
    // одна страница участников за раз
    await drainJobs(1);
    expect(await realCount(id)).toBe(4);
    const removed = async () => (await Promise.all([a, ...subs].map(async (u) => (await journalOf(u.userId, 'chatRemoved')).some((x: any) => x.chatId === id)))).filter(Boolean).length;
    expect(await removed()).toBe(2);
    await drainJobs();
    expect(await removed()).toBe(6);
    expect(await realCount(id)).toBe(0);
    expect((await sql`select count(*)::int as n from messages where chat_id = ${id}`)[0].n).toBe(0);
    expect((await sql`select 1 from chats where id = ${id}`).length).toBe(0);
    expect((await handleFrame(subs[0].userId, { op: 'syncChat', reqId: 'r2', chatId: id, since: 0 }))[0]).toMatchObject({ op: 'chatGone' });
  } finally {
    PURGE.page = prevPage;
  }
});

test('push for a channel: title is the channel, no sender name; author never notified; NotifyType channel defaults apply', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await channel(a, [b, c]);
  const { keys } = await pushBrowser();
  const sid = async (u: U) => Number((await sql`select id from sessions where user_id = ${u.userId} order by id desc limit 1`)[0].id);
  const ep = (n: number) => `http://localhost:${pushSvc.port}/ep/${n}`;
  await subscribe(a.userId, { endpoint: ep(1), keys }, await sid(a));
  await subscribe(b.userId, { endpoint: ep(2), keys }, await sid(b));
  await subscribe(c.userId, { endpoint: ep(3), keys }, await sid(c));
  // c выключил уведомления каналов (группы — включены): ему ничего
  await ok(c, 'PUT', '/settings/notify/channel', { muted: true });
  const { message } = await post(a, id, 'свежий пост');
  const plan = await planPush({ chatId: id, id: message.id, senderId: a.userId, body: 'свежий пост', post: true });
  expect(plan).toEqual([{ endpoint: ep(2), push: { chatId: id, id: message.id, title: 'Новости', body: 'свежий пост' } }]);
  // весь путь задачи: автор (у поста senderId 0) не получает своё же уведомление
  await drainJobs();
  expect(pushed).toEqual(['/ep/2']);
  // настройки каналов не задевают группы
  const g = await group(a, [c]);
  const gm = (await sendMessage(a.userId, { chatId: g, clientId: crypto.randomUUID(), body: 'в группе' })).message;
  expect((await planPush({ chatId: g, id: gm.id, senderId: a.userId, body: 'в группе' })).map((p) => p.push)).toEqual([{ chatId: g, id: gm.id, title: 'Обсуждение', body: 'Анна: в группе' }]);
});

test('forwarding a post hides the admin: fwdFrom is the channel (userId null, title), postAuthor kept; a forward of the forward keeps it', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await channel(a, [b], 'Новости');
  await ok(a, 'PUT', `/groups/${id}/settings`, { signatures: true });
  const p = (await post(a, id, 'новость')).message;
  const direct = await createChat('direct', null, [b.userId, c.userId]);
  const fwd = (await sendMessage(b.userId, { chatId: direct, clientId: crypto.randomUUID(), body: '', forward: { chatId: id, id: p.id } })).message;
  expect(fwd.fwdFrom).toEqual({ userId: null, name: 'Новости', chatId: id, messageId: p.id, at: p.createdAt, postAuthor: 'Анна' });
  expect(fwd).toMatchObject({ senderId: b.userId, body: 'новость' });
  expect(fwd.post).toBeUndefined();   // в личном чате это обычное сообщение пересылавшего
  expect(JSON.stringify(fwd)).not.toContain(`"userId":${a.userId}`);
  // пересылка пересланного — тот же заголовок канала
  const g = await group(c, [b]);
  const again = (await sendMessage(c.userId, { chatId: g, clientId: crypto.randomUUID(), body: '', forward: { chatId: direct, id: fwd.id } })).message;
  expect(again.fwdFrom).toEqual(fwd.fwdFrom);
  // без подписей — без postAuthor; не участник канала переслать не может
  await ok(a, 'PUT', `/groups/${id}/settings`, { signatures: false });
  const p2 = (await post(a, id, 'вторая')).message;
  const f2 = (await sendMessage(b.userId, { chatId: direct, clientId: crypto.randomUUID(), body: '', forward: { chatId: id, id: p2.id } })).message;
  expect(f2.fwdFrom).toEqual({ userId: null, name: 'Новости', chatId: id, messageId: p2.id, at: p2.createdAt });
  await expect(sendMessage(c.userId, { chatId: direct, clientId: crypto.randomUUID(), body: '', forward: { chatId: id, id: p2.id } })).rejects.toMatchObject({ code: 'not_member' });
  // обычное сообщение группы — как раньше, с автором
  const gm = (await sendMessage(b.userId, { chatId: g, clientId: crypto.randomUUID(), body: 'в группе' })).message;
  const f3 = (await sendMessage(c.userId, { chatId: direct, clientId: crypto.randomUUID(), body: '', forward: { chatId: g, id: gm.id } })).message;
  expect(f3.fwdFrom).toMatchObject({ userId: b.userId, name: 'Борис' });
});

test('service messages of a channel are from the channel: channel_created with the title, title change has senderId 0, not unread for the actor; no owner_changed', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await channel(a, [b], 'Новости');
  await ok(a, 'PATCH', `/groups/${id}`, { title: 'Свежие новости' });
  // от канала (senderId 0) — значит автору своё служебное поднимает last_read_id и readOwn (иначе его устройства сочтут его чужим)
  const lastSvc = Number((await sql`select max(id) as id from messages where chat_id = ${id}`)[0].id);
  expect(Number((await sql`select last_read_id from chat_members where chat_id = ${id} and user_id = ${a.userId}`)[0].last_read_id)).toBe(lastSvc);
  expect((await journalOf(a.userId, 'readOwn')).filter((u: any) => u.chatId === id).map((u: any) => u.upToId)).toEqual([lastSvc - 1, lastSvc]);
  expect(Number((await sql`select last_read_id from chat_members where chat_id = ${id} and user_id = ${b.userId}`)[0].last_read_id)).toBe(0);
  await ok(a, 'PUT', `/groups/${id}/admins/${b.userId}`, { rights: { post: true } });
  await ok(a, 'DELETE', `/groups/${id}/members/${a.userId}`);   // владелец вышел — права у админа; служебного owner_changed в канале нет
  const rows = await sql`select service_type, sender_id, post from messages where chat_id = ${id} and service_type is not null order by id`;
  expect(rows.map((r) => r.service_type)).toEqual(['channel_created', 'title_changed']);
  expect(rows.every((r) => r.post)).toBe(true);
  const hist = (await ok(b, 'GET', `/chats/${id}/messages`)).messages;
  expect(hist.map((m: any) => [m.service?.type, m.senderId])).toEqual([['channel_created', 0], ['title_changed', 0]]);
  expect(JSON.stringify(hist)).not.toContain(`"id":${b.userId},"name"`);   // новый владелец подписчикам не раскрыт
  expect(hist[0].body).toBe('Новости');
  const evs = (await chatEventsOf(id, 'newMessage')).map((u: any) => u.message);
  expect(evs.every((m: any) => m.senderId === 0 && m.post)).toBe(true);
  // в группе служебные — от автора, как раньше
  const g = await group(a, [b]);
  const [gs] = await sql`select service_type, post from messages where chat_id = ${g}`;
  expect(gs).toMatchObject({ service_type: 'group_created', post: false });
  await ok(a, 'PATCH', `/groups/${g}`, { title: 'Другое' });
  expect((await ok(b, 'GET', `/chats/${g}/messages`)).messages.at(-1)).toMatchObject({ senderId: a.userId, service: { type: 'title_changed' } });
});

test('checklists in a channel: only admins with post toggle/append; service lines are posts; who completed is hidden (by 0)', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await channel(a, [b, c]);
  await makeAdmin(a, id, c, { post: true });
  const todo = { title: 'План', items: [{ title: 'раз' }, { title: 'два' }], othersCanAppend: true, othersCanComplete: true };
  const list = (await post(a, id, 'План', { todo })).message;
  expect(list).toMatchObject({ kind: 'todo', senderId: 0, post: true });
  await expect(toggleTodo(b.userId, id, list.id, [1], [])).rejects.toMatchObject({ code: 'forbidden' });
  await expect(appendTodo(b.userId, id, list.id, ['три'])).rejects.toMatchObject({ code: 'forbidden' });
  expect(await toggleTodo(c.userId, id, list.id, [1], [])).toEqual({ changed: true });
  expect(await appendTodo(c.userId, id, list.id, ['три'])).toEqual({ ids: [3] });
  const lines = await sql`select service_type, post, sender_id from messages where chat_id = ${id} and service_type like 'todo_%' order by id`;
  expect(lines.map((r) => [r.service_type, r.post, Number(r.sender_id)])).toEqual([['todo_done', true, c.userId], ['todo_append', true, c.userId]]);
  // строки — от канала: отметившему не непрочитанные
  const lastLine = Number((await sql`select max(id) as id from messages where chat_id = ${id}`)[0].id);
  expect(Number((await sql`select last_read_id from chat_members where chat_id = ${id} and user_id = ${c.userId}`)[0].last_read_id)).toBe(lastLine);
  expect((await journalOf(c.userId, 'readOwn')).filter((u: any) => u.chatId === id).at(-1)).toMatchObject({ upToId: lastLine });
  const ev = (await chatEventsOf(id, 'todoUpdated')).at(-1) as any;
  expect(ev.todo.completions.map((x: any) => x.by)).toEqual([0]);
  const hist = (await ok(b, 'GET', `/chats/${id}/messages`)).messages;
  expect(hist.find((m: any) => m.id === list.id).todo.completions.map((x: any) => [x.id, x.by])).toEqual([[1, 0]]);
  expect(hist.filter((m: any) => m.service?.type?.startsWith('todo_')).map((m: any) => m.senderId)).toEqual([0, 0]);
  expect(JSON.stringify(hist)).not.toContain(`"by":${c.userId}`);
  // пересланный из канала чек-лист — тоже без отметивших
  const direct = await createChat('direct', null, [b.userId, c.userId]);
  const fwd = (await sendMessage(b.userId, { chatId: direct, clientId: crypto.randomUUID(), body: '', forward: { chatId: id, id: list.id } })).message;
  expect(fwd.todo!.completions.map((x) => x.by)).toEqual([0]);
  // группа — как раньше: отмечают участники, by — настоящий
  const g = await group(a, [b]);
  const gl = (await post(a, g, 'План', { todo })).message;
  await toggleTodo(b.userId, g, gl.id, [2], []);
  expect(((await chatEventsOf(g, 'todoUpdated')).at(-1) as any).todo.completions.map((x: any) => x.by)).toEqual([b.userId]);
  expect((await sql`select post from messages where chat_id = ${g} and service_type = 'todo_done'`)[0].post).toBe(false);
});

test('the owner leaving a channel: ownership goes to the oldest admin only (not an older subscriber); no admin — forbidden; groups unchanged', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await channel(a, [b]);   // b — давний подписчик
  const r = await call(a, 'DELETE', `/groups/${id}/members/${a.userId}`);
  expect(r.status).toBe(403);   // админа нет — сначала передать права
  expect(await realCount(id)).toBe(2);
  const d = await login('Глеб');
  await ok(a, 'POST', `/groups/${id}/members`, { users: refs(a.userId, [c.userId, d.userId]) });
  await makeAdmin(a, id, c, { post: true });
  await makeAdmin(a, id, d, { post: true });
  await ok(a, 'DELETE', `/groups/${id}/members/${a.userId}`);
  const roles = await sql`select user_id, role from chat_members where chat_id = ${id} order by user_id`;
  expect(roles.map((x) => [Number(x.user_id), x.role])).toEqual([[b.userId, 'member'], [c.userId, 'owner'], [d.userId, 'admin']]);
  // общая запись — без владельца; админам (и новому владельцу) он — личной записью; подписчику — нет
  expect((await chatEventsOf(id, 'groupUpdated')).at(-1)).toMatchObject({ group: { ownerId: null } });
  for (const u of [c, d]) expect((await journalOf(u.userId, 'groupUpdated')).at(-1)).toMatchObject({ chatId: id, group: { ownerId: c.userId } });
  expect((await journalOf(b.userId, 'groupUpdated')).filter((u: any) => u.chatId === id)).toEqual([]);
  // группа: владелец уходит — самый давний участник, если админов нет
  const g = await group(a, [b]);
  await ok(a, 'DELETE', `/groups/${g}/members/${a.userId}`);
  expect((await sql`select role from chat_members where chat_id = ${g} and user_id = ${b.userId}`)[0].role).toBe('owner');
});

test('deleting a linked chat and relinking at the same time do not deadlock (one ordered lock of both rows)', async () => {
  const a = await login('Анна'), b = await login('Борис');
  for (let i = 0; i < 5; i++) {
    const g = await group(a, [b], 'Обсуждение');   // группа раньше канала: id меньше
    const ch = await channel(a, [b]);
    await setLinkedChat(a.userId, ch, g);
    const res = await Promise.allSettled([deleteGroup(a.userId, ch), setLinkedChat(a.userId, ch, null), deleteGroup(a.userId, g)]);
    for (const x of res) if (x.status === 'rejected') expect(x.reason).toBeInstanceOf(DomainError);   // доменная ошибка (not_found…), не дедлок 40P01
    expect(res.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  }
});

test('a join request to a channel writes no groupUpdated: only joinRequests to approvers; approving neither', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await channel(a, [b]);
  await ok(a, 'PUT', `/groups/${id}/settings`, { joinApproval: true });
  const before = (await chatEventsOf(id, 'groupUpdated')).length;
  const { invites } = await ok(a, 'GET', `/groups/${id}/invites`);
  expect(await ok(c, 'POST', `/join/+${invites.find((i: any) => i.primary).link}`)).toMatchObject({ requested: true });
  expect((await journalOf(a.userId, 'joinRequests')).at(-1)).toEqual({ type: 'joinRequests', chatId: id, requests: 1 });
  expect(await journalOf(b.userId, 'joinRequests')).toEqual([]);
  await ok(a, 'POST', `/groups/${id}/requests/${c.userId}`, { approve: true });
  expect((await journalOf(a.userId, 'joinRequests')).at(-1)).toEqual({ type: 'joinRequests', chatId: id, requests: 0 });
  expect((await chatEventsOf(id, 'groupUpdated')).length).toBe(before);
  expect(await realCount(id)).toBe(3);
});

test('a soft-deleted chat is gone for reads, flags and profile visibility', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const g = await group(a, [b]);
  const m = (await sendMessage(a.userId, { chatId: g, clientId: crypto.randomUUID(), body: 'привет' })).message;
  await ok(b, 'PUT', `/chats/${g}/flags`, { archived: true });
  expect(await canView(sql, a.userId, b.userId)).toBe(true);
  await ok(a, 'DELETE', `/groups/${g}`);
  await expect(markRead(b.userId, g, m.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(unarchiveByMessage(b.userId, g, { messageId: m.id })).rejects.toMatchObject({ code: 'not_found' });
  expect((await call(b, 'PUT', `/chats/${g}/flags`, { pinned: true })).status).toBe(404);
  // общей была только удалённая группа — профили друг другу больше не видны
  expect(await canView(sql, a.userId, b.userId)).toBe(false);
  expect(await viewersOf(sql, b.userId)).not.toContain(a.userId);
});

test('channel owner is shown to admins only: subscriber summary and the shared groupUpdated carry ownerId null', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await channel(a, [b, c]);
  await makeAdmin(a, id, c, { post: true });
  expect((await summary(b, id)).group.ownerId).toBeNull();
  expect((await summary(c, id)).group.ownerId).toBe(a.userId);
  expect((await summary(a, id)).group.ownerId).toBe(a.userId);
  await ok(a, 'PATCH', `/groups/${id}`, { about: 'о канале' });
  expect((await chatEventsOf(id, 'groupUpdated')).at(-1)).toMatchObject({ group: { about: 'о канале', ownerId: null } });
  // группа — владелец виден всем
  const g = await group(a, [b]);
  expect((await summary(b, g)).group.ownerId).toBe(a.userId);
});
