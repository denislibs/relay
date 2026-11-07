import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { listChats, countChats, deleteDirectChat } from '../src/domain/chats';
import { setChatFlags } from '../src/domain/chatFlags';
import { topPeers } from '../src/domain/globalSearch';
import { sendMessage } from '../src/domain/messages';
import { editMessage, deleteMessage, reactMessage } from '../src/domain/messageOps';
import { pinMessage } from '../src/domain/pins';
import { planPush } from '../src/domain/push';
import { markRead } from '../src/domain/reads';
import { openSavedChat } from '../src/domain/saved';
import { searchPostgres } from '../src/domain/search';
import { createServer } from '../src/http';
import { handleFrame } from '../src/ws';
import { journalOf, makeChat, makeUser, resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

type U = { userId: number; token: string };
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const call = (u: U, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { cookie: `relay_session=${u.token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const send = (userId: number, chatId: number, body: string, extra: Record<string, unknown> = {}) =>
  sendMessage(userId, { chatId, clientId: crypto.randomUUID(), body, ...extra });

test('one per user: repeated and concurrent opens return the same chat; the only member is the user', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const ids = await Promise.all(Array.from({ length: 8 }, () => openSavedChat(a)));
  expect(new Set(ids).size).toBe(1);
  expect(await openSavedChat(a)).toBe(ids[0]);
  expect(await openSavedChat(b)).not.toBe(ids[0]);
  const members = await sql`select user_id from chat_members where chat_id = ${ids[0]}`;
  expect(members.map((m) => Number(m.user_id))).toEqual([a]);
  const [{ n }] = await sql`select count(*)::int as n from saved_chats where user_id = ${a}`;
  expect(n).toBe(1);
});

test('the list row: «Избранное», direct, no peer, no unread, no read mark from anyone; pinned and archive work', async () => {
  const a = await makeUser('Анна');
  const chat = await openSavedChat(a);
  const empty = (await listChats(a)).find((c) => c.id === chat)!;
  expect(empty).toMatchObject({ kind: 'direct', title: 'Избранное', saved: true, peer: null, unread: 0, last: null });
  const { message } = await send(a, chat, 'заметка');
  const row = (await listChats(a)).find((c) => c.id === chat)!;
  expect(row).toMatchObject({ unread: 0, peerReadUpTo: 0 });
  expect(row.last?.id).toBe(message.id);

  expect((await setChatFlags(a, chat, { pinned: true })).pinnedAt).not.toBeNull();
  expect((await setChatFlags(a, chat, { archived: true })).archived).toBe(true);
  expect((await setChatFlags(a, chat, { archived: false })).archived).toBe(false);
  // пометки «непрочитанное» в «Избранном» не бывает
  expect((await setChatFlags(a, chat, { unreadMark: true })).unreadMark).toBe(false);
  expect((await topPeers(a)).chatIds).not.toContain(chat);
});

test('everything of a usual chat works: replies, edit, delete, reactions, pins, read; the journal carries it to all devices', async () => {
  const a = await makeUser('Анна');
  const chat = await openSavedChat(a);
  const first = (await send(a, chat, 'первое')).message;
  const reply = (await send(a, chat, 'ответ', { replyToId: first.id })).message;
  expect(reply.replyToId).toBe(first.id);
  await editMessage(a, chat, first.id, 'правка');
  await reactMessage(a, chat, first.id, '👍');
  await pinMessage(a, chat, first.id);
  await markRead(a, chat, reply.id);
  expect(await journalOf(a, 'newMessage')).toHaveLength(2);
  await deleteMessage(a, chat, reply.id);

  expect(await journalOf(a, 'messageEdited')).toHaveLength(1);
  // журнал читает newMessage удалённого как messageDeleted (ссылка на строку), поэтому событий о нём может быть два
  expect(new Set((await journalOf(a, 'messageDeleted')).map((u) => (u as { id: number }).id))).toEqual(new Set([reply.id]));
  const row = (await listChats(a)).find((c) => c.id === chat)!;
  expect(row).toMatchObject({ unread: 0, unreadReactions: 0, unreadMentions: 0, pinned: [first.id] });
  // текст — зашифрован, как в любом чате
  const [stored] = await sql`select body, content from messages where id = ${first.id}`;
  expect(stored.body).not.toContain('правка');
  expect(stored.content).not.toBeNull();
  // поиск по чату и по всем чатам находит, название чата в выдаче — «Избранное»
  const hits = (await searchPostgres(a, 'правка')).hits;
  expect(hits.map((h) => h.message.id)).toEqual([first.id]);
  expect(hits[0].chatTitle).toBe('Избранное');
  expect((await searchPostgres(a, 'правка', { chatId: chat })).hits).toHaveLength(1);
});

test('no push and no typing to my own devices', async () => {
  const a = await makeUser('Анна');
  const chat = await openSavedChat(a);
  const [s] = await sql`insert into sessions (token_hash, user_id, expires_at) values (${crypto.randomUUID()}, ${a}, now() + interval '1 day') returning id`;
  await sql`insert into push_subscriptions (endpoint, user_id, session_id, p256dh, auth) values ('https://push.example/1', ${a}, ${s.id}, 'k', 'a')`;
  const { message } = await send(a, chat, 'себе');
  expect(await planPush(message)).toEqual([]);
  // «печатает»: другого участника нет — кадр никому не уходит и не падает
  expect(await handleFrame(a, { op: 'typing', chatId: chat })).toEqual([]);
});

test('privacy and blocks do not get in the way; forwarding from a person keeps «Переслано от»', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await openSavedChat(a);
  const direct = await makeChat([a, b]);
  const original = (await send(b, direct, 'от Бориса')).message;
  await sql`insert into blocks (owner_id, user_id) values (${a}, ${b}), (${b}, ${a})`;
  const fwd = (await send(a, chat, '', { forward: { chatId: direct, id: original.id } })).message;
  expect(fwd.fwdFrom).toMatchObject({ userId: b, name: 'Борис', chatId: direct, messageId: original.id });
  expect(fwd.body).toBe('от Бориса');
  expect((await send(a, chat, 'и своё')).message.chatId).toBe(chat);
});

test('deleting removes the history for real and hides the chat until it is opened again', async () => {
  const a = await makeUser('Анна');
  const chat = await openSavedChat(a);
  const pinned = (await send(a, chat, 'секрет')).message;
  await pinMessage(a, chat, pinned.id);
  const before = await countChats(a);
  await deleteDirectChat(a, chat, false);   // «только для меня» здесь не бывает: других участников нет
  expect((await listChats(a)).some((c) => c.id === chat)).toBe(false);
  expect(await countChats(a)).toBe(before - 1);
  expect(await journalOf(a, 'chatRemoved')).toEqual([{ type: 'chatRemoved', chatId: chat }]);
  // прошлое не открыть: версии ключа, которой зашифрована история, больше нет (shredChatHistory)
  expect((await sql`select 1 from keys.chat_keys where chat_id = ${chat} and version = 1`).length).toBe(0);

  expect(await openSavedChat(a)).toBe(chat);   // тот же чат, строка снова отдаётся (открыть, шапка), пустая
  const row = (await listChats(a)).find((c) => c.id === chat)!;
  expect(row).toMatchObject({ saved: true, last: null, pinned: [] });
  expect(await countChats(a)).toBe(before - 1);   // пустое — клиент в списке не показывает, в число диалогов не входит
  // удалили и не открывали, но написали с другого устройства — чат вернулся с новым сообщением
  await send(a, chat, 'новое');
  await deleteDirectChat(a, chat, true);
  await send(a, chat, 'ещё новое');
  expect((await listChats(a)).find((c) => c.id === chat)?.last?.body).toBe('ещё новое');
});

test('over HTTP: POST /chats/saved is idempotent; a stranger can neither read nor write someone else\'s chat', async () => {
  const a = await login('Анна'), x = await login('Чужой');
  const r1 = await call(a, 'POST', '/chats/saved');
  const chat = ((await r1.json()) as { id: number }).id;
  expect(((await (await call(a, 'POST', '/chats/saved')).json()) as { id: number }).id).toBe(chat);
  expect((await fetch(base + '/chats/saved', { method: 'POST' })).status).toBe(401);
  const { message } = await send(a.userId, chat, 'тайна');

  // у чужого — своё «Избранное», чужое он не видит ни в списке, ни по id
  const mine = ((await (await call(x, 'POST', '/chats/saved')).json()) as { id: number }).id;
  expect(mine).not.toBe(chat);
  expect(await (await call(x, 'GET', `/chats?ids=${chat}`)).json()).toEqual([]);
  for (const [method, path, body] of [
    ['GET', `/chats/${chat}/messages`],
    ['GET', `/chats/${chat}/media?tab=media`],
    ['POST', `/chats/${chat}/delete`, { forAll: true }],
    ['POST', `/chats/${chat}/pins`, { messageId: message.id }],
    ['PUT', `/chats/${chat}/theme`, { theme: null }],
  ] as [string, string, unknown?][]) {
    const res = await call(x, method, path, body);
    expect([path, res.status]).toEqual([path, 403]);
  }
  await expect(send(x.userId, chat, 'влез')).rejects.toMatchObject({ code: 'not_member' });
  await expect(reactMessage(x.userId, chat, message.id, '👍')).rejects.toMatchObject({ code: 'not_member' });
  await expect(editMessage(x.userId, chat, message.id, 'влез')).rejects.toMatchObject({ code: 'not_member' });
  await expect(markRead(x.userId, chat, message.id)).rejects.toMatchObject({ code: 'not_member' });
  await expect(send(x.userId, mine, '', { forward: { chatId: chat, id: message.id } })).rejects.toBeDefined();
  // в поиск чужого не попадает
  expect((await searchPostgres(x.userId, 'тайна')).hits).toEqual([]);
  // добавить в него человека нельзя: это не группа
  const add = await call(x, 'POST', `/groups/${chat}/members`, { members: [] });
  expect(add.status).toBeGreaterThanOrEqual(400);
  expect((await sql`select user_id from chat_members where chat_id = ${chat}`).map((m) => Number(m.user_id))).toEqual([a.userId]);
});

test('empty «Избранное» is not counted as a dialog until it has a message, a draft or a pin (as in Telegram)', async () => {
  const a = await makeUser('Анна');
  const base = await countChats(a);
  const chat = await openSavedChat(a);
  expect((await listChats(a)).find((c) => c.id === chat)).toMatchObject({ saved: true, last: null });   // строка для клиента есть
  expect(await countChats(a)).toBe(base);
  await setChatFlags(a, chat, { pinned: true });
  expect(await countChats(a)).toBe(base + 1);
  await setChatFlags(a, chat, { pinned: false });
  expect(await countChats(a)).toBe(base);
  const { message } = await send(a, chat, 'первая заметка');
  expect(await countChats(a)).toBe(base + 1);
  await deleteMessage(a, chat, message.id);
  expect(await countChats(a)).toBe(base);
});
