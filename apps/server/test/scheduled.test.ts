import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { deleteDirectChat, getChatMediaCounts, getHistory, listChats } from '../src/domain/chats';
import { blockUser, unblockUser } from '../src/domain/contacts';
import { parseClientFrame } from '@relay/protocol';
import { sendMessage } from '../src/domain/messages';
import { planPush, subscribe } from '../src/domain/push';
import { searchPostgres } from '../src/domain/search';
import { openSavedChat } from '../src/domain/saved';
import { deleteScheduled, editScheduled, listScheduled, publishScheduled, scheduleMessage, sweepScheduled } from '../src/domain/scheduled';
import { collectGarbage } from '../src/domain/storageGc';
import { createServer } from '../src/http';
import { getUpdates } from '../src/domain/journal';
import { drainJobs } from '../src/jobs/worker';
import '../src/jobs/kinds';
import { handleFrame } from '../src/ws';
import { journalOf, makeChat, makeUser, pushBrowser, resetDb, uploadFile } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

const subscribed = async (userId: number) => {
  const [r] = await sql`insert into sessions (token_hash, user_id, expires_at) values (${crypto.randomUUID()}, ${userId}, now() + interval '30 days') returning id`;
  await subscribe(userId, { endpoint: `https://push.test/${userId}`, keys: (await pushBrowser()).keys }, Number(r.id));
};
const SECRET = 'секретный-текст-отложенного';
const soon = (ms = 60_000) => Date.now() + ms;
const plan = (userId: number, chatId: number, extra: Record<string, unknown> = {}) =>
  scheduleMessage(userId, { chatId, clientId: crypto.randomUUID(), body: SECRET, scheduleAt: soon(), ...extra }) as Promise<{ item: { clientId: string; sendAt: number; rev: number; body: string; failed?: string; attachment?: { id: string } } }>;
/** Подошло время: в базе — прошлое (задача поставлена на будущее и сама не сработает). */
const due = async (clientId: string) => {
  await sql`update scheduled_messages set send_at = now() - interval '1 second' where client_id = ${clientId}`;
  await sql`update jobs set run_at = now() where kind = 'scheduled.send' and payload->>'clientId' = ${clientId}`;
};
const texts = async (userId: number, chatId: number) => (await getHistory(userId, chatId, null, 100)).messages.map((m) => m.body);
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

test('encryption: no open text in the table, jobs or the journal; the owner reads it back', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  const { item } = await plan(a, chat, { entities: [{ type: 'bold', offset: 0, length: 5 }] });
  expect(item.body).toBe(SECRET);
  const [row] = await sql`select * from scheduled_messages where client_id = ${item.clientId}`;
  expect(Buffer.from(row.content as Uint8Array).includes(Buffer.from(SECRET))).toBe(false);
  const blob = async (table: 'jobs' | 'updates') => JSON.stringify(await sql`select * from ${sql(table)}`);
  expect(await blob('jobs')).not.toContain(SECRET);
  expect(await blob('updates')).not.toContain(SECRET);
  // журнал отдаёт уже открытое, по ссылке
  const scheduled = await journalOf(a, 'scheduled');
  expect(scheduled.length).toBe(1);
  expect((await listScheduled(a)).items[0]).toMatchObject({ clientId: item.clientId, body: SECRET, chatId: chat });
});

test('others in the chat never see it: journal, history, list, search and the HTTP API', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  const { item } = await plan(a, chat);
  expect(await journalOf(b)).toEqual([]);
  expect((await listScheduled(b)).items).toEqual([]);
  expect(await texts(a, chat)).toEqual([]);
  expect(await texts(b, chat)).toEqual([]);
  expect((await searchPostgres(a, 'секретный')).hits).toEqual([]);
  expect((await sql`select count(*)::int as n from messages where chat_id = ${chat}`)[0].n).toBe(0);
  // индекс поиска и push о нём ничего не знают до публикации
  expect((await sql`select kind from jobs order by id`).map((j) => j.kind)).toEqual(['scheduled.send']);
  expect((await getChatMediaCounts(a, chat)).media).toBe(0);
  expect((await listChats(b)).find((c) => c.id === chat)?.unread ?? 0).toBe(0);
  // чужая строка не находится: ни правка, ни отправка, ни удаление
  expect(await code(editScheduled(b, chat, item.clientId, { body: 'взлом' }))).toBe('not_found');
  expect(await code(editScheduled(b, chat, item.clientId, { send: true }))).toBe('not_found');
  await deleteScheduled(b, chat, item.clientId);
  expect((await listScheduled(a)).items.length).toBe(1);
});

test('a chat that is not mine: refused at scheduling time', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера'), chat = await makeChat([a, b]);
  expect(await code(plan(c, chat))).toBe('not_member');
  const [{ n }] = await sql`select count(*)::int as n from scheduled_messages`;
  expect(n).toBe(0);
});

test('time: the past and more than a year ahead are refused, on create and on edit', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  expect(await code(plan(a, chat, { scheduleAt: Date.now() - 1000 }))).toBe('schedule_past');
  expect(await code(plan(a, chat, { scheduleAt: Date.now() + 367 * 86400_000 }))).toBe('schedule_far');
  const { item } = await plan(a, chat);
  expect(await code(editScheduled(a, chat, item.clientId, { sendAt: Date.now() - 1000 }))).toBe('schedule_past');
  expect(await code(editScheduled(a, chat, item.clientId, { sendAt: Date.now() + 367 * 86400_000 }))).toBe('schedule_far');
});

test('limit: 100 per chat per user; another person and another chat have their own', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]), other = await makeChat([a, await makeUser('Вера')]);
  await sql`insert into scheduled_messages (user_id, client_id, chat_id, kind, send_at, content)
            select ${a}, gen_random_uuid(), ${chat}, 'text', now() + interval '1 hour', '\\x00'::bytea from generate_series(1, 100)`;
  expect(await code(plan(a, chat))).toBe('schedule_limit');
  expect(await code(plan(b, chat))).toBe(null);
  expect(await code(plan(a, other))).toBe(null);
});

test('publication: normal id and date, gone from the list, removal in the journal; a repeated job makes no duplicate', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  const { item } = await plan(a, chat, { silent: false });
  // рано — задача ничего не делает
  await publishScheduled(a, item.clientId);
  expect(await texts(a, chat)).toEqual([]);
  await due(item.clientId);
  await drainJobs();
  expect(await texts(b, chat)).toEqual([SECRET]);
  expect((await listScheduled(a)).items).toEqual([]);
  const [m] = (await getHistory(a, chat, null, 100)).messages;
  expect(m.clientId).toBe(item.clientId);
  expect(Date.now() - Date.parse(m.createdAt)).toBeLessThan(10_000);
  expect((await journalOf(a, 'scheduledRemoved')).length).toBeGreaterThan(0);
  await publishScheduled(a, item.clientId);   // повтор задачи
  expect((await sql`select count(*)::int as n from messages where chat_id = ${chat}`)[0].n).toBe(1);
});

test('two workers at once publish one message', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  const { item } = await plan(a, chat);
  await due(item.clientId);
  await Promise.all(Array.from({ length: 5 }, () => publishScheduled(a, item.clientId)));
  expect((await sql`select count(*)::int as n from messages where chat_id = ${chat}`)[0].n).toBe(1);
});

test('restart: the job is in Postgres; a dead job is picked up by the sweep', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  const { item } = await plan(a, chat);
  await due(item.clientId);
  await sql`delete from jobs where kind = 'scheduled.send'`;
  await sql`update scheduled_messages set send_at = now() - interval '2 minutes' where client_id = ${item.clientId}`;
  expect(await sweepScheduled()).toBe(1);
  await drainJobs();
  expect(await texts(b, chat)).toEqual([SECRET]);
});

test('resending the frame does not plan twice; after publication it answers published', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  const clientId = crypto.randomUUID();
  const frame = { op: 'send' as const, reqId: 'r', clientId, chatId: chat, body: SECRET, entities: [], replyToId: null, attachment: null, groupId: null, forward: null, scheduleAt: soon() };
  const [x] = await handleFrame(a, frame), [y] = await handleFrame(a, frame);
  expect(x).toMatchObject({ op: 'ack', result: { clientId, item: { clientId } } });
  expect(y).toMatchObject({ op: 'ack', result: { clientId, item: { clientId } } });
  expect((await listScheduled(a)).items.length).toBe(1);
  await due(clientId);
  await drainJobs();
  const [z] = await handleFrame(a, frame);
  expect(z).toMatchObject({ op: 'ack', result: { clientId, published: true } });
  expect((await listScheduled(a)).items).toEqual([]);
});

test('edit: time moves the job (the old one does nothing), text is re-sealed, rev grows', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  const { item } = await plan(a, chat);
  const later = soon(3600_000);
  const r = await editScheduled(a, chat, item.clientId, { sendAt: later, body: 'другой', entities: [] });
  expect(r.item).toMatchObject({ body: 'другой', rev: 2 });
  expect(Math.abs(r.item!.sendAt - later)).toBeLessThan(2);
  await sql`update jobs set run_at = now() where kind = 'scheduled.send' and run_at < now() + interval '30 minutes'`;
  await drainJobs();
  expect(await texts(a, chat)).toEqual([]);
  expect((await listScheduled(a)).items.length).toBe(1);
});

test('send now: goes at once, the job after it does nothing', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  const { item } = await plan(a, chat);
  expect(await editScheduled(a, chat, item.clientId, { send: true })).toEqual({ sent: true });
  await drainJobs();
  expect(await texts(b, chat)).toEqual([SECRET]);
});

test('delete: nothing is published', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  const { item } = await plan(a, chat);
  await due(item.clientId);
  await deleteScheduled(a, chat, item.clientId);
  await drainJobs();
  expect(await texts(a, chat)).toEqual([]);
});

const relayMessages = async (userId: number) => {
  const [svc] = await sql`select chat_id from service_chats where user_id = ${userId}`;
  return svc ? (await getHistory(userId, Number(svc.chat_id), null, 100)).messages.filter((m) => m.service?.type === 'scheduled_failed').map((m) => m.body) : [];
};

test('kicked out of a group: not sent, the row is gone, the author is told by «Relay»', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера'), chat = await makeChat([a, b, c]);
  const { item } = await plan(a, chat);
  await sql`delete from chat_members where chat_id = ${chat} and user_id = ${a}`;
  await due(item.clientId);
  await drainJobs();
  expect(await texts(b, chat)).toEqual([]);
  expect((await listScheduled(a)).items).toEqual([]);
  const said = await relayMessages(a);
  expect(said.length).toBe(1);
  expect(said[0]).toContain('не отправлено');
  expect(said[0]).not.toContain(SECRET);
});

test('blocked by the peer: not sent, the row stays with an error and can still be deleted', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  const { item } = await plan(a, chat);
  await blockUser(b, a);
  await due(item.clientId);
  await drainJobs();
  expect(await texts(b, chat)).toEqual([]);
  expect((await listScheduled(a)).items[0]).toMatchObject({ clientId: item.clientId, failed: 'blocked', body: SECRET });
  expect((await relayMessages(a)).length).toBe(1);
  await drainJobs();   // повтор не шлёт второй сигнал
  expect((await relayMessages(a)).length).toBe(1);
  await deleteScheduled(a, chat, item.clientId);
  expect((await listScheduled(a)).items).toEqual([]);
});

test('the chat deleted for both: the peer loses the row (its key is destroyed) and is told; the one who deleted is not', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  await plan(a, chat); await plan(b, chat);
  await deleteDirectChat(a, chat, true);
  expect((await listScheduled(a)).items).toEqual([]);
  expect((await listScheduled(b)).items).toEqual([]);
  expect((await relayMessages(b)).length).toBe(1);
  expect((await relayMessages(a)).length).toBe(0);
});

test('reply target deleted meanwhile: goes without the quote', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  const { message } = await sendMessage(b, { chatId: chat, clientId: crypto.randomUUID(), body: 'вопрос' });
  const { item } = await plan(a, chat, { replyToId: message.id });
  await sql`update messages set deleted = true where id = ${message.id}`;
  await due(item.clientId);
  await drainJobs();
  const m = (await getHistory(b, chat, null, 100)).messages.find((x) => x.body === SECRET)!;
  expect(m.replyToId).toBe(null);
});

test('stickers, polls and the like: only what the menu offers can be scheduled', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  for (const extra of [{ poll: { question: 'q' } }, { todo: { title: 't' } }, { dice: { emoji: '🎲' } }, { blocks: [] }, { geo: { lat: 1, lng: 1 } }, { threadId: 5 }]) {
    expect(await code(plan(a, chat, extra))).toBe('bad_frame');
  }
});

test('a file: the owner\'s only, kept from the garbage collector while it waits, published with its caption', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await makeChat([a.userId, b.userId]);
  const up = await uploadFile(base, a.token, { name: 'photo.png', mime: 'image/png', w: 1, h: 1 }, 'x') as { id: string };
  expect(await code(plan(b.userId, chat, { attachment: { id: up.id } }))).toBe('not_found');
  const { item } = await plan(a.userId, chat, { attachment: { id: up.id }, body: 'подпись' });
  expect(item.attachment?.id).toBe(up.id);
  await sql`update attachments set created_at = now() - interval '100 days' where id = ${up.id}`;
  expect((await collectGarbage({ graceMs: 1000 })).deleted).toBe(0);
  await due(item.clientId);
  await drainJobs();
  const [m] = (await getHistory(b.userId, chat, null, 100)).messages;
  expect(m.attachment?.id).toBe(up.id);
  expect(m.body).toBe('подпись');
});

test('an album is published in order, one bubble', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await makeChat([a.userId, b.userId]);
  const groupId = crypto.randomUUID();
  const ids: string[] = [];
  for (const n of [1, 2, 3]) {
    const up = await uploadFile(base, a.token, { name: `${n}.png`, mime: 'image/png', w: 1, h: 1 }, 'x') as { id: string };
    ids.push(up.id);
    const { item } = await plan(a.userId, chat, { attachment: { id: up.id }, groupId, body: '' });
    await due(item.clientId);
  }
  await drainJobs();
  const list = (await getHistory(b.userId, chat, null, 100)).messages;
  expect(list.map((m) => m.attachment?.id)).toEqual(ids);
  expect(new Set(list.map((m) => m.groupId))).toEqual(new Set([groupId]));
});

test('silent: journal and unread as usual, no push, also in a scheduled one', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  await subscribed(b);
  const loud = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'громко' });
  expect((await planPush({ ...loud.message, senderId: a })).length).toBe(1);
  const quiet = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'тихо', silent: true });
  expect(quiet.message.silent).toBe(true);
  expect(await planPush({ ...quiet.message, senderId: a })).toEqual([]);
  // журнал и непрочитанные — как обычно
  expect((await journalOf(b, 'newMessage')).length).toBe(2);
  const [{ n }] = await sql`select count(*)::int as n from messages where chat_id = ${chat} and id > 0`;
  expect(n).toBe(2);
  const { item } = await plan(a, chat, { silent: true });
  await due(item.clientId);
  await drainJobs();
  const m = (await getHistory(b, chat, null, 100)).messages.at(-1)!;
  expect(m.silent).toBe(true);
  expect(await planPush({ ...m, senderId: a })).toEqual([]);
  const updates = await getUpdates(b, 0);
  expect(updates.items.some((u) => u.update.type === 'newMessage' && u.update.message.silent === true)).toBe(true);
});

test('reminder to «Избранное»: the author gets the push, unless it is silent; an ordinary own note does not notify', async () => {
  const a = await makeUser('Анна');
  const saved = await openSavedChat(a);
  await subscribed(a);
  const note = await sendMessage(a, { chatId: saved, clientId: crypto.randomUUID(), body: 'заметка' });
  expect(await planPush({ ...note.message, senderId: a })).toEqual([]);
  const { item } = await plan(a, saved);
  await due(item.clientId);
  await drainJobs();
  const m = (await getHistory(a, saved, null, 100)).messages.at(-1)!;
  expect(m.reminder).toBe(true);
  const targets = await planPush({ ...m, senderId: a });
  expect(targets.length).toBe(1);
  expect(targets[0].push).toMatchObject({ title: 'Напоминание', chatId: saved });
  const quiet = await plan(a, saved, { silent: true });
  await due(quiet.item.clientId);
  await drainJobs();
  const q = (await getHistory(a, saved, null, 100)).messages.at(-1)!;
  expect(q.reminder).toBeFalsy();
  expect(await planPush({ ...q, senderId: a })).toEqual([]);
});

test('the client cannot mark its own message as a reminder; a failed row edited in text does not resend itself', async () => {
  const f = parseClientFrame(JSON.stringify({ op: 'send', reqId: 'r', clientId: crypto.randomUUID(), chatId: 1, body: 'x', silent: true, reminder: true, scheduleAt: 5 })) as Record<string, unknown>;
  expect(f.silent).toBe(true);
  expect(f.scheduleAt).toBe(5);
  expect('reminder' in f).toBe(false);
  const a = await makeUser('Анна'), b = await makeUser('Борис'), chat = await makeChat([a, b]);
  const { item } = await plan(a, chat);
  await blockUser(b, a);
  await due(item.clientId);
  await drainJobs();
  await unblockUser(b, a);
  const r = await editScheduled(a, chat, item.clientId, { body: 'поправил' });
  expect(r.item).toMatchObject({ failed: 'blocked', body: 'поправил' });
  await drainJobs();
  expect(await texts(b, chat)).toEqual([]);
  await editScheduled(a, chat, item.clientId, { send: true });
  expect(await texts(b, chat)).toEqual(['поправил']);
});

test('HTTP: list, edit and delete are only mine; a foreign chat answers the same as a missing row', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await makeChat([a.userId, b.userId]);
  const { item } = await plan(a.userId, chat);
  const call = (u: { token: string }, method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { cookie: `relay_session=${u.token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  expect(((await (await call(a, 'GET', '/chats/scheduled')).json()) as { items: unknown[] }).items.length).toBe(1);
  expect(((await (await call(b, 'GET', '/chats/scheduled')).json()) as { items: unknown[] }).items.length).toBe(0);
  expect((await call(b, 'PATCH', `/chats/${chat}/scheduled/${item.clientId}`, { body: 'взлом' })).status).toBe(404);
  expect((await call(a, 'PATCH', `/chats/${chat}/scheduled/${item.clientId}`, { sendAt: 1 })).status).toBe(400);
  expect((await call(a, 'PATCH', `/chats/${chat}/scheduled/${item.clientId}`, { body: 'новый' })).status).toBe(200);
  expect((await call(b, 'DELETE', `/chats/${chat}/scheduled/${item.clientId}`)).status).toBe(200);
  expect((await listScheduled(a.userId)).items[0].body).toBe('новый');
});

const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
