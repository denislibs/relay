import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { sendMessage } from '../src/domain/messages';
import { deleteMessage, editMessage } from '../src/domain/messageOps';
import { markRead } from '../src/domain/reads';
import { readThread } from '../src/domain/threads';
import { removeGroupMember, setGroupAdmin, setLinkedChat } from '../src/domain/groups';
import { listChats } from '../src/domain/chats';
import { planPush, subscribe } from '../src/domain/push';
import { MAX_MENTIONS } from '../src/domain/mentions';
import '../src/jobs/kinds';
import { handlers } from '../src/jobs/handlers';
import { journalOf, pushBrowser, resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

type U = { userId: number; token: string };
const login = async (name: string, username?: string): Promise<U> => {
  const u = (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
  if (username) await sql`update users set username = ${username} where id = ${u.userId}`;
  return u;
};
const hdr = (u: U) => ({ cookie: `relay_session=${u.token}`, 'content-type': 'application/json' });
const ok = async (u: U, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: hdr(u), body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
const group = async (owner: U, members: U[], title = 'Группа') => (await ok(owner, 'POST', '/chats', { title, memberIds: members.map((m) => m.userId) })).id as number;
const channel = async (owner: U, members: U[] = []) => (await ok(owner, 'POST', '/chats', { kind: 'channel', title: 'Новости', memberIds: members.map((m) => m.userId) })).id as number;
const send = (u: U, chatId: number, body: string, extra: Record<string, unknown> = {}) => sendMessage(u.userId, { chatId, clientId: crypto.randomUUID(), body, ...extra }).then((r) => r.message);
const mentionsOf = async (u: U, chatId?: number) => (await sql`
  select message_id, thread_id from message_mentions where user_id = ${u.userId} ${chatId != null ? sql`and chat_id = ${chatId}` : sql``} order by message_id`)
  .map((r) => ({ id: Number(r.message_id), threadId: r.thread_id == null ? null : Number(r.thread_id) }));
const unreadMentions = async (u: U, chatId: number) => (await listChats(u.userId, { ids: [chatId] }))[0]?.unreadMentions;

test('by @username (case-insensitive) and by reply; not the author, not a blocker, not a non-member; journal entry hydrates to the message', async () => {
  const a = await login('Анна', 'anna_a'), b = await login('Борис', 'boris_b'), c = await login('Вера', 'vera_v'), d = await login('Глеб', 'gleb_g');
  const out = await login('Чужой', 'stranger');
  const g = await group(a, [b, c, d]);
  await sql`insert into blocks (owner_id, user_id) values (${d.userId}, ${a.userId})`;   // d заблокировал a
  const m = await send(a, g, 'привет @BORIS_B, @anna_a, @gleb_g и @stranger');
  expect(await mentionsOf(b)).toEqual([{ id: m.id, threadId: null }]);
  expect(await mentionsOf(a)).toEqual([]);     // себя не упоминаем
  expect(await mentionsOf(d)).toEqual([]);     // заблокировавший — нет
  expect(await mentionsOf(out)).toEqual([]);   // не участник — нет
  // ответ упоминает автора исходного
  const r = await send(b, g, 'ответ без имени', { replyToId: (await send(c, g, 'вопрос')).id });
  expect(await mentionsOf(c)).toEqual([{ id: r.id, threadId: null }]);
  const [j] = await journalOf(b.userId, 'mention');
  expect(j).toMatchObject({ type: 'mention', message: { id: m.id, chatId: g, body: 'привет @BORIS_B, @anna_a, @gleb_g и @stranger' } });
  expect((j as { threadId?: number }).threadId).toBeUndefined();
  expect(await unreadMentions(b, g)).toBe(1);
  // удалено — упоминание пропало, запись журнала читается как удаление
  await deleteMessage(a.userId, g, m.id);
  expect(await mentionsOf(b)).toEqual([]);
  expect(await unreadMentions(b, g)).toBe(0);
  expect((await journalOf(b.userId)).filter((u) => u.type === 'mention' || (u.type === 'messageDeleted' && u.id === m.id)).map((u) => u.type)).toEqual(['messageDeleted']);
});

test('not inside code, pre or link; at most MAX_MENTIONS recipients; a forward mentions nobody', async () => {
  const a = await login('Анна', 'anna_a'), b = await login('Борис', 'boris_b');
  const many: U[] = [];
  for (let i = 0; i < MAX_MENTIONS + 3; i++) many.push(await login('u' + i, 'user_' + String(i).padStart(2, '0')));
  const g = await group(a, [b, ...many]);
  const text = 'код @boris_b';
  await send(a, g, text, { entities: [{ type: 'code', offset: 4, length: 8 }] });
  await send(a, g, text, { entities: [{ type: 'pre', offset: 4, length: 8 }] });
  await send(a, g, text, { entities: [{ type: 'link', offset: 4, length: 8, url: 'https://example.com' }] });
  await send(a, g, 'medium.com/@boris_b');
  expect(await mentionsOf(b)).toEqual([]);
  const all = await send(a, g, many.map((_, i) => '@user_' + String(i).padStart(2, '0')).join(' '));
  const [{ n }] = await sql`select count(*)::int as n from message_mentions where chat_id = ${g} and message_id = ${all.id}`;
  expect(n).toBe(MAX_MENTIONS);
  expect(await mentionsOf(many[0])).toEqual([{ id: all.id, threadId: null }]);   // первые по порядку в тексте
  expect(await mentionsOf(many[MAX_MENTIONS + 2])).toEqual([]);
  // пересланное с @именем никого не упоминает
  const src = await send(b, g, 'для @anna_a');
  await sql`delete from message_mentions`;
  await send(b, g, '', { forward: { chatId: g, id: src.id } });
  expect(await mentionsOf(a)).toEqual([]);
});

test('edit adds new mentions only (removed ones stay); not for a reader who already read the place', async () => {
  const a = await login('Анна', 'anna_a'), b = await login('Борис', 'boris_b'), c = await login('Вера', 'vera_v');
  const g = await group(a, [b, c]);
  const m = await send(a, g, 'для @boris_b');
  await markRead(c.userId, g, m.id);   // c прочитала это место раньше, чем её упомянули правкой
  await editMessage(a.userId, g, m.id, 'для @vera_v');
  expect(await mentionsOf(b)).toEqual([{ id: m.id, threadId: null }]);   // убранное остаётся
  expect(await mentionsOf(c)).toEqual([]);
  const m2 = await send(a, g, 'просто текст');
  await editMessage(a.userId, g, m2.id, 'теперь @vera_v');
  expect(await mentionsOf(c)).toEqual([{ id: m2.id, threadId: null }]);
  await editMessage(a.userId, g, m2.id, 'снова @vera_v');   // повтор — без второй записи
  expect((await journalOf(c.userId, 'mention')).length).toBe(1);
});

test('cleanup: markRead clears main-feed mentions only, readThread — that thread only; leaving clears the chat', async () => {
  const a = await login('Анна', 'anna_a'), b = await login('Борис', 'boris_b');
  const ch = await channel(a, [b]);
  const g = await group(a, [b]);
  await setLinkedChat(a.userId, ch, g);
  const post = await send(a, ch, 'пост');
  const copyId = Number((await sql`select copy_id from message_threads where chat_id = ${ch} and post_id = ${post.id}`)[0].copy_id);
  const main = await send(a, g, 'в ленте @boris_b');
  const inThread = await send(a, g, 'в треде @boris_b', { threadId: copyId });
  expect(await mentionsOf(b, g)).toEqual([{ id: main.id, threadId: null }, { id: inThread.id, threadId: copyId }]);
  expect((await journalOf(b.userId, 'mention')).find((u) => u.type === 'mention' && u.message.id === inThread.id)).toMatchObject({ threadId: copyId, message: { threadId: copyId } });
  expect(await unreadMentions(b, g)).toBe(2);
  await markRead(b.userId, g, inThread.id);   // основная лента дочитана дальше комментария — тред не прочитан
  expect(await mentionsOf(b, g)).toEqual([{ id: inThread.id, threadId: copyId }]);
  const second = await send(a, g, 'ещё @boris_b', { threadId: copyId });
  await readThread(b.userId, g, copyId, inThread.id);
  expect(await mentionsOf(b, g)).toEqual([{ id: second.id, threadId: copyId }]);
  expect(await unreadMentions(b, g)).toBe(1);
  await removeGroupMember(b.userId, g, b.userId);   // вышел — строк не осталось
  expect(await mentionsOf(b, g)).toEqual([]);
});

test('channel: a post mentions only admins with post; its copy in the discussion group creates none', async () => {
  const a = await login('Анна', 'anna_a'), b = await login('Борис', 'boris_b'), c = await login('Вера', 'vera_v'), d = await login('Глеб', 'gleb_g');
  const ch = await channel(a, [b, c, d]);
  const g = await group(a, [b, c, d]);
  await setLinkedChat(a.userId, ch, g);
  await setGroupAdmin(a.userId, ch, c.userId, { rights: { post: true } });
  await setGroupAdmin(a.userId, ch, d.userId, { rights: { edit: true } });
  const post = await send(a, ch, '@boris_b @vera_v @gleb_g');
  expect(await mentionsOf(b)).toEqual([]);   // подписчик
  expect(await mentionsOf(d)).toEqual([]);   // админ без post
  expect(await mentionsOf(c)).toEqual([{ id: post.id, threadId: null }]);
  expect(await mentionsOf(c, g)).toEqual([]);   // копия — без упоминаний
});

test('push.mention pierces the chat mute and the subscription muted list; push.message skips the mentioned user', async () => {
  const a = await login('Анна', 'anna_a'), b = await login('Борис', 'boris_b'), c = await login('Вера', 'vera_v');
  const g = await group(a, [b, c], 'Команда');
  const { keys } = await pushBrowser();
  const sid = async (u: U) => Number((await sql`select id from sessions where user_id = ${u.userId} order by id desc limit 1`)[0].id);
  const ep = (n: number) => `https://push.invalid/ep/${n}`;
  await subscribe(b.userId, { endpoint: ep(2), keys, muted: [g] }, await sid(b));
  await subscribe(c.userId, { endpoint: ep(3), keys }, await sid(c));
  await sql`update chat_members set mute_until = 'infinity' where chat_id = ${g} and user_id = ${b.userId}`;
  const m = await send(a, g, 'срочно @boris_b @vera_v');
  // обычный push — никому из упомянутых (им push.mention)
  expect(await planPush({ chatId: g, id: m.id, senderId: a.userId, body: m.body })).toEqual([]);
  expect(await planPush({ chatId: g, id: m.id, senderId: a.userId, body: m.body }, { mentionOf: b.userId })).toEqual([
    { endpoint: ep(2), push: { chatId: g, id: m.id, title: 'Команда', body: 'Анна: срочно @boris_b @vera_v', mention: true } },
  ]);
  // задачи: push.mention на каждого адресата — доставки на обе подписки (сквозь mute)
  const jobs = await sql`select kind, payload from jobs where kind = 'push.mention' order by id`;
  expect(jobs.map((j) => Number((j.payload as { userId: number }).userId)).sort()).toEqual([b.userId, c.userId].sort());
  // обработчик push.mention: доставки на обе подписки (b — сквозь mute чата и список muted подписки)
  const run = async (p: unknown) => handlers['push.mention'](p, {} as never);
  for (const j of jobs) await run(j.payload);
  const delivers = await sql`select payload from jobs where kind = 'push.deliver'`;
  expect(delivers.map((d) => (d.payload as { endpoint: string }).endpoint).sort()).toEqual([ep(2), ep(3)]);
  // прочитал до отправки push — уведомления нет
  await sql`delete from jobs`;
  const m2 = await send(a, g, 'ещё @vera_v');
  await markRead(c.userId, g, m2.id);
  for (const j of await sql`select payload from jobs where kind = 'push.mention'`) await run(j.payload);
  expect((await sql`select 1 from jobs where kind = 'push.deliver'`).length).toBe(0);
});
