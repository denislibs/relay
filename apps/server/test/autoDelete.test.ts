import { afterAll, beforeEach, expect, test } from 'bun:test';
import { parseClientFrame } from '@relay/protocol';
import { sql } from '../src/db';
import { keyVersionOf, open } from '../src/crypto/aead';
import { chatKey, currentChatKey, expiryBucket, resetChatKeyCache } from '../src/crypto/chatKeys';
import { destroyExpiredKeys, expireStep, setAutoDelete } from '../src/domain/autoDelete';
import { createGroup, deleteDirectChat, getChatMedia, getChatMediaCounts, getHistory, getMessagesByIds, listChats, messageAtDate } from '../src/domain/chats';
import { blockUser } from '../src/domain/contacts';
import { fileFor } from '../src/domain/files';
import { setLinkedChat } from '../src/domain/groups';
import { getUpdates } from '../src/domain/journal';
import { deleteMessage, editMessage, reactMessage } from '../src/domain/messageOps';
import { sendMessage } from '../src/domain/messages';
import { pinMessage, pinnedIds } from '../src/domain/pins';
import { openSavedChat } from '../src/domain/saved';
import { publishScheduled, scheduleMessage } from '../src/domain/scheduled';
import { searchPostgres } from '../src/domain/search';
import { postService } from '../src/domain/service';
import { createServer } from '../src/http';
import { assertTransportSecure } from '../src/tls';
import { drainJobs } from '../src/jobs/worker';
import '../src/jobs/kinds';
import { chatEventsOf, journalOf, makeChat, makeUser, opened, resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => { server.stop(true); });
beforeEach(async () => { await resetDb(); process.env.DEV_LOGIN = '1'; });

const DAY = 86400;
const send = (u: number, chatId: number, body: string, extra: Record<string, unknown> = {}) =>
  sendMessage(u, { chatId, clientId: crypto.randomUUID(), body, ...extra }).then((r) => r.message);
/** Срок вышел секунду назад, задача ещё не приходила. */
const lapse = (...ids: number[]) => sql`update messages set expires_at = now() - interval '1 second' where id = any(${ids}::bigint[])`;
const row = async (id: number) => (await sql`select * from messages where id = ${id}`)[0];
async function photo(owner: number): Promise<string> {
  const [r] = await sql`insert into attachments (owner_id, mime, name, size, status, kind, width, height)
    values (${owner}, 'image/jpeg', 'cat.jpg', 10, 'ready', 'photo', 800, 600) returning id`;
  return r.id as string;
}
async function pair() {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  return { a, b, chat: await makeChat([a, b]) };
}

test('direct: either side sets it; both get the service message and chatAutoDelete; the list carries it; a repeat changes nothing', async () => {
  const { a, b, chat } = await pair();
  expect(await setAutoDelete(b, chat, DAY)).toEqual({ autoDeleteSec: DAY });
  for (const u of [a, b]) {
    expect(await journalOf(u, 'chatAutoDelete')).toEqual([{ type: 'chatAutoDelete', chatId: chat, sec: DAY }]);
    const [msg] = (await journalOf(u, 'newMessage')).map((x) => (x as { message: Record<string, unknown> }).message);
    expect(msg).toMatchObject({ senderId: b, service: { type: 'auto_delete_changed', data: { sec: DAY } } });
    expect((await listChats(u))[0].autoDeleteSec).toBe(DAY);
  }
  await setAutoDelete(a, chat, DAY);
  expect(await journalOf(a, 'chatAutoDelete')).toHaveLength(1);
  await setAutoDelete(a, chat, null);
  expect((await journalOf(b, 'chatAutoDelete')).at(-1)).toEqual({ type: 'chatAutoDelete', chatId: chat, sec: null });
  const [last] = await sql`select service_type, service_data from messages where chat_id = ${chat} order by id desc limit 1`;
  expect([last.service_type, last.service_data]).toEqual(['auto_delete_changed', null]);
});

test('rights: stranger, blocked, service chat, group member and channel subscriber cannot; admin and Saved can', async () => {
  const { a, b, chat } = await pair();
  const s = await makeUser('Чужой');
  await expect(setAutoDelete(s, chat, DAY)).rejects.toMatchObject({ code: 'not_member' });
  await sql.begin((tx) => postService(tx, a, { type: 'scheduled_failed', body: 'служебное' }));
  const [svc] = await sql`select c.id from chats c join chat_members m on m.chat_id = c.id and m.user_id = ${a} join chat_members o on o.chat_id = c.id join users u on u.id = o.user_id and u.system where c.kind = 'direct'`;
  await expect(setAutoDelete(a, Number(svc.id), DAY)).rejects.toMatchObject({ code: 'forbidden' });
  await blockUser(b, a);
  await expect(setAutoDelete(a, chat, DAY)).rejects.toMatchObject({ code: 'blocked' });

  const saved = await openSavedChat(a);
  await setAutoDelete(a, saved, DAY);
  expect((await send(a, saved, 'заметка')).expiresAt).toBeGreaterThan(Date.now());
  await expect(setAutoDelete(b, saved, DAY)).rejects.toMatchObject({ code: 'not_member' });

  for (const kind of ['group', 'channel'] as const) {
    const c = await makeUser('Участник');
    const id = (await sql`select id from chats where id = ${(await createGroup(a, { kind, title: 'Сообщество', memberIds: [c] })).chatId}`)[0].id;
    await expect(setAutoDelete(c, Number(id), DAY)).rejects.toMatchObject({ code: 'forbidden' });
    await setAutoDelete(a, Number(id), DAY);
    expect((await chatEventsOf(Number(id), 'chatAutoDelete'))).toEqual([{ type: 'chatAutoDelete', chatId: Number(id), sec: DAY }]);
    await sql`update chat_members set role = 'admin', admin_rights = ${sql.json({ changeInfo: false } as never)} where chat_id = ${id} and user_id = ${c}`;
    await expect(setAutoDelete(c, Number(id), null)).rejects.toMatchObject({ code: 'forbidden' });
    await sql`update chat_members set admin_rights = ${sql.json({ changeInfo: true, info: true } as never)} where chat_id = ${id} and user_id = ${c}`;
    await setAutoDelete(c, Number(id), null);
  }
});

test('the range: an hour to a year; seconds only under DEV_LOGIN — no back door in production', async () => {
  const { a, chat } = await pair();
  for (const bad of [0, -1, 3600.5, '3600', {}, undefined, 365 * DAY + 1]) await expect(setAutoDelete(a, chat, bad)).rejects.toMatchObject({ code: 'bad_frame' });
  process.env.DEV_LOGIN = '0';
  for (const short of [1, 5, 3599]) await expect(setAutoDelete(a, chat, short)).rejects.toMatchObject({ code: 'bad_frame' });
  expect(await setAutoDelete(a, chat, 3600)).toEqual({ autoDeleteSec: 3600 });
  expect(await setAutoDelete(a, chat, 365 * DAY)).toEqual({ autoDeleteSec: 365 * DAY });
  delete process.env.DEV_LOGIN;
  await expect(setAutoDelete(a, chat, 5)).rejects.toMatchObject({ code: 'bad_frame' });
  process.env.DEV_LOGIN = '1';
  expect(await setAutoDelete(a, chat, 5)).toEqual({ autoDeleteSec: 5 });
  await expect(setAutoDelete(a, chat, 0.5)).rejects.toMatchObject({ code: 'bad_frame' });
  // и production с DEV_LOGIN не стартует вовсе
  expect(() => assertTransportSecure({ NODE_ENV: 'production', DEV_LOGIN: '1' })).toThrow('DEV_LOGIN=1 is not allowed in production');
});

test('HTTP: the route answers the setting, a stranger gets an error', async () => {
  const { a, chat } = await pair();
  const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
  const out = await login('Посторонний');
  const put = (token: string, id: number, sec: unknown) => fetch(`${base}/chats/${id}/auto-delete`, { method: 'PUT', headers: { cookie: `relay_session=${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sec }) });
  const r = await put(out.token, chat, DAY);
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect((await row((await send(a, chat, 'x')).id)).expires_at).toBeNull();
  const mine = await login('Свой');
  const own = await openSavedChat(mine.userId);
  const ok = await put(mine.token, own, DAY);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ autoDeleteSec: DAY });
});

test('the server sets the term at publishing: only new messages, a client value is ignored, an edit does not move it, turning off keeps it', async () => {
  const { a, b, chat } = await pair();
  const before = await send(a, chat, 'до включения');
  expect(before.expiresAt).toBeUndefined();
  await setAutoDelete(a, chat, DAY);
  // клиент подсунул свой срок: ни кадр, ни sendMessage его не принимают
  const frame = parseClientFrame(JSON.stringify({ op: 'send', reqId: 'r', chatId: chat, clientId: crypto.randomUUID(), body: 'x', expiresAt: 1, expires_at: 1, ttl: 1 }));
  expect(frame).not.toHaveProperty('expiresAt');
  const t0 = Date.now();
  const m = await send(b, chat, 'со сроком', { expiresAt: 1, expires_at: new Date(0) });
  expect(m.expiresAt!).toBeGreaterThanOrEqual(t0 + DAY * 1000 - 5000);
  expect(m.expiresAt!).toBeLessThanOrEqual(Date.now() + DAY * 1000 + 5000);
  expect((await row(before.id)).expires_at).toBeNull();

  const was = (await row(m.id)).expires_at as Date;
  await editMessage(b, chat, m.id, 'поправил');
  expect(+((await row(m.id)).expires_at as Date)).toBe(+was);
  expect((await getHistory(a, chat, null, 50)).messages.find((x) => x.id === m.id)?.body).toBe('поправил');

  await setAutoDelete(a, chat, 7 * DAY);
  expect(+((await row(m.id)).expires_at as Date)).toBe(+was);   // смена срока — только новым
  await setAutoDelete(a, chat, null);
  expect(+((await row(m.id)).expires_at as Date)).toBe(+was);
  expect((await send(a, chat, 'после выключения')).expiresAt).toBeUndefined();
});

test('service messages get no term and survive the job; a post-less chat still has its history of changes', async () => {
  const { a, chat } = await pair();
  await setAutoDelete(a, chat, DAY);
  const [svc] = await sql`select id, expires_at from messages where chat_id = ${chat} and service_type = 'auto_delete_changed'`;
  expect(svc.expires_at).toBeNull();
  const m = await send(a, chat, 'обычное');
  await lapse(m.id);
  await expireStep();
  const { messages } = await getHistory(a, chat, null, 50);
  expect(messages.map((x) => x.id)).toEqual([Number(svc.id)]);
  expect((await listChats(a))[0].last?.id).toBe(Number(svc.id));
});

test('cut-off before the job: history, by ids, date jump, list preview and unread, search, media, files, forward, reply, edit, reaction, pin and sync', async () => {
  const { a, b, chat } = await pair();
  const other = await makeChat([a, await makeUser('Вера')]);
  const keep = await send(a, chat, 'слово остаётся');
  const fileId = await photo(a);
  await setAutoDelete(a, chat, DAY);
  const m = await send(a, chat, 'слово исчезает', { attachment: { id: fileId } });
  expect(await fileFor(b, fileId)).not.toBeNull();
  expect((await listChats(b)).find((c) => c.id === chat)!.unread).toBe(3);   // обычное, служебное и новое
  await lapse(m.id);
  // строка ещё на месте: задача не приходила
  expect((await row(m.id)).deleted).toBe(false);

  const ids = (await getHistory(b, chat, null, 50)).messages.map((x) => x.id);
  expect(ids).toContain(keep.id);
  expect(ids).not.toContain(m.id);
  expect((await getHistory(b, chat, null, 50, keep.id)).messages.map((x) => x.id)).not.toContain(m.id);
  expect(await getMessagesByIds(b, chat, [m.id])).toEqual([]);
  expect((await searchPostgres(b, 'исчезает', { chatId: chat })).hits).toEqual([]);
  expect((await searchPostgres(b, 'слово', { chatId: chat })).hits.map((h) => h.message.id)).toEqual([keep.id]);
  expect((await getChatMedia(b, chat, 'media', null)).messages).toEqual([]);
  expect((await getChatMediaCounts(b, chat)).media).toBe(0);
  const list = (await listChats(b)).find((c) => c.id === chat)!;
  expect(list.last?.id).not.toBe(m.id);
  expect(list.unread).toBe(2);   // keep (не прочитано) и служебное: вышедшее не считается
  expect((await messageAtDate(b, chat, new Date(Date.parse(new Date().toISOString()) + 3600_000).toISOString())).id).not.toBe(m.id);

  // файл закрыт всем, и отправившему тоже
  expect(await fileFor(b, fileId)).toBeNull();
  expect(await fileFor(a, fileId)).toBeNull();

  await expect(send(a, other, '', { forward: { chatId: chat, id: m.id } })).rejects.toMatchObject({ code: 'not_found' });
  await expect(send(b, chat, 'ответ', { replyToId: m.id })).rejects.toMatchObject({ code: 'not_found' });
  await expect(editMessage(a, chat, m.id, 'нельзя')).rejects.toMatchObject({ code: 'not_found' });
  await expect(reactMessage(b, chat, m.id, '👍')).rejects.toMatchObject({ code: 'not_found' });
  await expect(deleteMessage(a, chat, m.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(pinMessage(a, chat, m.id)).rejects.toMatchObject({ code: 'not_found' });

  // догоняющее устройство: ссылка журнала на вышедшее отдаётся как удаление, без текста
  const { items: updates } = await getUpdates(b, 0);
  const about = updates.filter((e) => JSON.stringify(e.update).includes('исчезает'));
  expect(about).toEqual([]);
  expect(updates.some((e) => e.update.type === 'messageDeleted' && (e.update as { id: number }).id === m.id)).toBe(true);
});

test('the job erases like «delete for all»: journal, pins, reactions, mentions, search; a repeat does nothing', async () => {
  const { a, b, chat } = await pair();
  await setAutoDelete(a, chat, DAY);
  const m = await send(a, chat, 'закреплённое');
  await reactMessage(b, chat, m.id, '👍');
  await pinMessage(a, chat, m.id);
  await sql`delete from jobs where kind = 'search.sync'`;
  await lapse(m.id);
  expect(await expireStep()).toEqual({ erased: 1, more: false });

  const r = await row(m.id);
  expect(r).toMatchObject({ deleted: true, content: null, attachment: null, body: '' });
  expect(await sql`select 1 from reactions where message_id = ${m.id}`).toHaveLength(0);
  expect(await sql`select 1 from unread_reactions where message_id = ${m.id}`).toHaveLength(0);
  expect(await pinnedIds(sql, chat)).toEqual([]);
  for (const u of [a, b]) {
    // в сырой записи журнала — ровно одно событие (при выдаче ссылка newMessage тоже станет удалением)
    expect(await sql`select 1 from updates where user_id = ${u} and payload->>'type' = 'messageDeleted' and (payload->>'id')::bigint = ${m.id}`).toHaveLength(1);
    expect((await journalOf(u, 'pins')).at(-1)).toEqual({ type: 'pins', chatId: chat, ids: [] });
  }
  expect((await sql`select payload from jobs where kind = 'search.sync'`).map((j) => Number((j.payload as { id: number }).id))).toContain(m.id);

  // повтор задачи: стёртое в выборку не попадает, журнал не растёт
  const n = (await journalOf(a)).length;
  expect(await expireStep()).toEqual({ erased: 0, more: false });
  expect(await journalOf(a)).toHaveLength(n);
  // параллельное удаление рукой уже стёртого — как обычно
  await expect(deleteMessage(a, chat, m.id)).rejects.toMatchObject({ code: 'not_found' });
});

test('packs: the job takes a batch and says there is more; through the queue it reschedules itself and finishes', async () => {
  const { a, chat } = await pair();
  await setAutoDelete(a, chat, DAY);
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) ids.push((await send(a, chat, 'm' + i)).id);
  await lapse(...ids);
  expect(await expireStep(2)).toEqual({ erased: 2, more: true });
  expect(await expireStep(2)).toEqual({ erased: 2, more: true });
  expect(await expireStep(2)).toEqual({ erased: 1, more: false });
  const m = await send(a, chat, 'через очередь');
  await lapse(m.id);
  await sql`insert into jobs (kind, payload, dedupe_key) values ('messages.expire', '{}', 'messages.expire')`;
  await drainJobs();
  expect((await row(m.id)).deleted).toBe(true);
  const [j] = await sql`select run_at > now() as later from jobs where kind = 'messages.expire'`;
  expect(j?.later).toBe(true);   // периодическая: перенесена вперёд, не умерла
});

test('a file: no other references — record, file key and object go at once; a forwarded copy keeps it alive', async () => {
  const { a, b, chat } = await pair();
  const other = await makeChat([a, await makeUser('Вера')]);
  await setAutoDelete(a, chat, DAY);

  const lone = await photo(a);
  await sql`insert into keys.attachment_keys (attachment_id, wrapped, kek_id) values (${lone}, '\\x00', 'test')`;
  const m1 = await send(a, chat, '', { attachment: { id: lone } });
  await sql`delete from jobs where kind = 'attachment.purge'`;
  await lapse(m1.id);
  await expireStep();
  expect(await sql`select 1 from attachments where id = ${lone}`).toHaveLength(0);
  expect(await sql`select 1 from keys.attachment_keys where attachment_id = ${lone}`).toHaveLength(0);
  expect((await sql`select payload from jobs where kind = 'attachment.purge'`)[0].payload).toMatchObject({ keys: expect.arrayContaining([lone]) });
  expect(await fileFor(a, lone)).toBeNull();

  const shared = await photo(a);
  const m2 = await send(a, chat, '', { attachment: { id: shared } });
  const copy = await send(a, other, '', { forward: { chatId: chat, id: m2.id } });
  expect(copy.expiresAt).toBeUndefined();   // в том чате автоудаления нет
  await lapse(m2.id);
  await expireStep();
  expect((await row(m2.id)).deleted).toBe(true);
  expect(await sql`select 1 from attachments where id = ${shared}`).toHaveLength(1);
  // участник чата с копией файл видит, собеседник из чата с вышедшим — нет
  expect(await fileFor(a, shared)).not.toBeNull();
  expect(await fileFor(b, shared)).toBeNull();
});

test('forwarding: the copy lives by the rules of its chat, both ways', async () => {
  const { a, chat } = await pair();
  const short = await makeChat([a, await makeUser('Вера')]);
  await setAutoDelete(a, short, 3600);
  const plain = await send(a, chat, 'вечное');
  const copy = await send(a, short, '', { forward: { chatId: chat, id: plain.id } });
  expect(copy.expiresAt).toBeGreaterThan(Date.now());
  expect(copy.expiresAt!).toBeLessThanOrEqual(Date.now() + 3601_000);
  expect((await row(plain.id)).expires_at).toBeNull();
  await lapse(copy.id);
  await expireStep();
  expect((await row(plain.id)).deleted).toBe(false);
});

test('a scheduled message takes the setting at the moment it goes out', async () => {
  const { a, chat } = await pair();
  const clientId = crypto.randomUUID(), at = Date.now() + 60_000;
  await scheduleMessage(a, { chatId: chat, clientId, body: 'отложенное', scheduleAt: at });
  await setAutoDelete(a, chat, DAY);
  await sql`update scheduled_messages set send_at = now() - interval '1 second' where client_id = ${clientId}`;
  await publishScheduled(a, clientId);
  const [m] = await sql`select expires_at from messages where client_id = ${clientId}`;
  expect(new Date(m.expires_at as string).getTime()).toBeGreaterThan(Date.now() + DAY * 1000 - 5000);
  // и наоборот: включено при постановке, выключено к моменту публикации — срока нет
  const second = crypto.randomUUID();
  await scheduleMessage(a, { chatId: chat, clientId: second, body: 'ещё', scheduleAt: at });
  await setAutoDelete(a, chat, null);
  await sql`update scheduled_messages set send_at = now() - interval '1 second' where client_id = ${second}`;
  await publishScheduled(a, second);
  expect((await sql`select expires_at from messages where client_id = ${second}`)[0].expires_at).toBeNull();
});

test('crypto: a term message is sealed by a bucket key; the key dies after the bucket and old ciphers cannot be opened from a backup', async () => {
  const { a, b, chat } = await pair();
  const plainMsg = await send(a, chat, 'обычное');
  await setAutoDelete(a, chat, 3600);
  const m = await send(a, chat, 'секрет');
  const sealed = new Uint8Array((await row(m.id)).content as Uint8Array);
  const version = keyVersionOf(sealed);
  expect(version).toBeGreaterThanOrEqual(2 ** 30);
  expect((await currentChatKey(chat)).version).toBe(1);   // обычная версия чата срочной не подменяется
  const [k] = await sql`select expires_at from keys.chat_keys where chat_id = ${chat} and version = ${version}`;
  expect(new Date(k.expires_at as string).getTime()).toBe(expiryBucket(m.expiresAt!));
  expect(k.expires_at).not.toBeNull();

  // правка запечатывает тем же срочным ключом
  await editMessage(a, chat, m.id, 'секрет 2');
  const edited = new Uint8Array((await row(m.id)).content as Uint8Array);
  expect(keyVersionOf(edited)).toBe(version);
  const aad = `messages|${chat}|${m.clientId}|content`;
  const backup = edited;   // это лежит в бэкапе данных
  expect(await open(await chatKey(chat, version), backup, aad)).toContain('секрет 2');
  // второе сообщение того же дня — тот же ключ: не по ключу на сообщение
  const m2 = await send(b, chat, 'тот же день');
  if (expiryBucket(m2.expiresAt!) === expiryBucket(m.expiresAt!)) expect(keyVersionOf(new Uint8Array((await row(m2.id)).content as Uint8Array))).toBe(version);

  // корзина не прошла — ключ жив, пусть и все сообщения вышли
  await lapse(m.id, m2.id);
  await expireStep();
  expect(await destroyExpiredKeys()).toBe(0);
  // корзина прошла, но живое со сроком в её пределах ещё есть — тоже жив
  await sql`update keys.chat_keys set expires_at = now() - interval '2 minutes' where chat_id = ${chat} and version = ${version}`;
  const stuck = await send(a, chat, 'ещё не стёрто');
  await sql`update messages set expires_at = now() - interval '3 minutes' where id = ${stuck.id}`;
  expect(await destroyExpiredKeys()).toBe(0);
  await expireStep();
  expect(await destroyExpiredKeys()).toBeGreaterThanOrEqual(1);
  resetChatKeyCache();
  await expect(chatKey(chat, version)).rejects.toMatchObject({ code: 'no_key' });

  // обычное сообщение чата живёт дальше, новое со сроком создаёт новую корзину с новым номером
  expect((await getHistory(a, chat, null, 50)).messages.map((x) => x.body)).toContain('обычное');
  expect(plainMsg.id).toBeGreaterThan(0);
  const fresh = await send(a, chat, 'новое');
  expect(keyVersionOf(new Uint8Array((await row(fresh.id)).content as Uint8Array))).toBeGreaterThan(version);
});

test('«delete for both» destroys term keys too; messages keep working afterwards', async () => {
  const { a, b, chat } = await pair();
  await setAutoDelete(a, chat, 3600);
  await send(a, chat, 'раз');
  await deleteDirectChat(a, chat, true);
  const versions = (await sql`select version, expires_at from keys.chat_keys where chat_id = ${chat}`);
  expect(versions.every((v) => v.expires_at == null)).toBe(true);
  expect(versions).toHaveLength(1);
  resetChatKeyCache();
  const m = await send(b, chat, 'заново');
  expect(m.expiresAt).toBeGreaterThan(Date.now());
  expect((await getHistory(a, chat, null, 5)).messages.map((x) => x.body)).toContain('заново');
});

test('a channel post and its discussion copy go together; the copy takes the term of the post, comments the term of the group', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const made = async (kind: 'channel' | 'group') => (await createGroup(a, { kind, title: kind, memberIds: [b] })).chatId;
  const channel = await made('channel'), group = await made('group');
  await setLinkedChat(a, channel, group);
  await setAutoDelete(a, channel, DAY);
  await setAutoDelete(a, group, 3600);
  const post = await send(a, channel, 'пост');
  expect(post.expiresAt).toBeGreaterThan(Date.now());
  const [copy] = await sql`select id, expires_at from messages where chat_id = ${group} and origin is not null order by id desc limit 1`;
  expect(new Date(copy.expires_at as string).getTime()).toBe(post.expiresAt!);
  const comment = await send(b, group, 'коммент', { threadId: Number(copy.id) });
  expect(comment.expiresAt!).toBeLessThanOrEqual(Date.now() + 3601_000);

  // комментарий вышел — счётчик треда пересчитан, копия и пост живы
  await lapse(comment.id);
  await expireStep();
  const [t] = await sql`select count from message_threads where chat_id = ${channel} and post_id = ${post.id}`;
  expect(Number(t.count)).toBe(0);
  expect((await row(Number(copy.id))).deleted).toBe(false);

  await lapse(post.id, Number(copy.id));
  expect((await expireStep()).erased).toBeGreaterThanOrEqual(1);
  expect((await row(post.id)).deleted).toBe(true);
  expect((await row(Number(copy.id))).deleted).toBe(true);
  // один раз, хотя в выборке были и пост, и копия
  expect(await sql`select 1 from chat_updates where chat_id = ${group} and payload->>'type' = 'messageDeleted' and (payload->>'id')::bigint = ${Number(copy.id)}`).toHaveLength(1);
});

test('content is sealed: the text of a term message is not open in the row', async () => {
  const { a, chat } = await pair();
  await setAutoDelete(a, chat, 3600);
  const m = await send(a, chat, 'секретное');
  const [r] = await opened(await sql`select * from messages where id = ${m.id}`);
  expect(r.body).toBe('секретное');
  const raw = await row(m.id);
  expect(raw.body).toBe('');
  expect(Buffer.from(raw.content as Uint8Array).includes(Buffer.from('секретное'))).toBe(false);
});
