import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { getChatMedia, getChatMediaCounts, getHistory } from '../src/domain/chats';
import { sendMessage } from '../src/domain/messages';
import { deleteMessage } from '../src/domain/messageOps';
import { expireStep } from '../src/domain/autoDelete';
import { deleteSavedDialog, listSavedDialogs, openSavedChat, SAVED_PIN_LIMIT, setSavedDialogPin } from '../src/domain/saved';
import { searchMessages } from '../src/domain/search';
import { createServer } from '../src/http';
import { journalOf, makeChat, makeUser, resetDb } from './helpers';
import { savedPeerRule, type Update } from '@relay/protocol';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

const send = (userId: number, chatId: number, body: string, extra: Record<string, unknown> = {}) =>
  sendMessage(userId, { chatId, clientId: crypto.randomUUID(), body, ...extra });
const fwd = (userId: number, saved: number, chatId: number, id: number, extra: Record<string, unknown> = {}) =>
  send(userId, saved, '', { forward: { chatId, id, ...extra } });
const peersOf = async (userId: number, saved: number) => (await listSavedDialogs(userId, saved)).dialogs.map((d) => d.peer);
const lastDialogEvent = async (userId: number, peer: string) => (await journalOf(userId, 'savedDialog') as Extract<Update, { type: 'savedDialog' }>[]).filter((e) => e.peer === peer).at(-1);

test('rule: note, copy without header, direct → person, group/channel → chat, foreign or gone → hidden', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const saved = await openSavedChat(a);
  const dm = await makeChat([a, b], 'direct');
  const group = await makeChat([a, b], 'group');
  const foreign = await makeChat([b, c], 'direct');
  const own = (await send(a, saved, 'заметка')).message;
  expect(own.savedPeer).toBe('me');
  const inDm = (await send(b, dm, 'от Бориса')).message;
  expect((await fwd(a, saved, dm, inDm.id)).message.savedPeer).toBe('u' + b);
  // своё из личного чата — тоже в подчат собеседника: как saved_from_peer
  const mine = (await send(a, dm, 'своё')).message;
  expect((await fwd(a, saved, dm, mine.id)).message.savedPeer).toBe('u' + b);
  const inGroup = (await send(b, group, 'в группе')).message;
  expect((await fwd(a, saved, group, inGroup.id)).message.savedPeer).toBe('c' + group);
  // скрытый отправитель: fwd_from нет — как своё, источник никак не сохраняется
  const hiddenCopy = (await fwd(a, saved, dm, inDm.id, { hideSender: true })).message;
  expect(hiddenCopy.savedPeer).toBe('me');
  expect(hiddenCopy.fwdFrom ?? null).toBeNull();
  // пересланное пересланного из чужой переписки: Борис переслал Анне своё из чата с Верой → источник — чужой личный чат
  const inForeign = (await send(c, foreign, 'от Веры')).message;
  const relayed = (await send(b, dm, '', { forward: { chatId: foreign, id: inForeign.id } })).message;
  expect((await fwd(a, saved, dm, relayed.id)).message.savedPeer).toBe('hidden');
  // переслано из самого «Избранного» — остаётся заметкой
  expect((await fwd(a, saved, saved, own.id)).message.savedPeer).toBe('me');
  // в протоколе то же правило, что на сервере
  expect(savedPeerRule(null, saved, null)).toBe('me');
  expect(savedPeerRule({ chatId: 999999 }, saved, null)).toBe('hidden');
  expect(savedPeerRule({ chatId: 999999 }, saved, { kind: 'group', gone: true })).toBe('hidden');
  expect(savedPeerRule({ chatId: 7 }, saved, { kind: 'channel' })).toBe('c7');
  // вне «Избранного» подчата нет
  expect(inDm.savedPeer).toBeUndefined();
  expect((await send(a, dm, 'x')).message.savedPeer).toBeUndefined();
  // чистая форма в базе: fwd_from ровно тот, что был, нового содержимого нет
  const [row] = await sql`select fwd_from, saved_peer from messages where id = ${hiddenCopy.id}`;
  expect(row.fwd_from).toBeNull();
});

test('migration rule backfills the same way as the insert path', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const saved = await openSavedChat(a);
  const dm = await makeChat([a, b], 'direct'), group = await makeChat([a, b], 'group'), foreign = await makeChat([b, c], 'direct');
  const m1 = await send(a, saved, 'заметка');
  const m2 = await fwd(a, saved, dm, (await send(b, dm, 'x')).message.id);
  const m3 = await fwd(a, saved, group, (await send(b, group, 'y')).message.id);
  const relayed = (await send(b, dm, '', { forward: { chatId: foreign, id: (await send(c, foreign, 'z')).message.id } })).message;
  const m4 = await fwd(a, saved, dm, relayed.id);
  const before = (await sql`select id, saved_peer from messages where chat_id = ${saved} order by id`).map((r) => r.saved_peer);
  await sql`update messages set saved_peer = null where chat_id = ${saved}`;
  await sql.file(new URL('../migrations/167_saved_dialogs.sql', import.meta.url).pathname).simple();
  const after = (await sql`select id, saved_peer from messages where chat_id = ${saved} order by id`).map((r) => r.saved_peer);
  expect(after).toEqual(before);
  expect(after).toEqual(['me', 'u' + b, 'c' + group, 'hidden']);
  void [m1, m2, m3, m4];
});

test('list: notes first, pinned next, by last message; counts, last, page cursor', async () => {
  const a = await makeUser('Анна');
  const saved = await openSavedChat(a);
  const others: number[] = [];
  const dms: number[] = [];
  for (const n of ['Б', 'В', 'Г']) { const u = await makeUser(n); others.push(u); dms.push(await makeChat([a, u], 'direct')); }
  const first = (await send(others[0], dms[0], 'раз')).message;
  await fwd(a, saved, dms[0], first.id);
  await send(a, saved, 'заметка');
  await fwd(a, saved, dms[1], (await send(others[1], dms[1], 'два')).message.id);
  const last = await fwd(a, saved, dms[2], (await send(others[2], dms[2], 'три')).message.id);
  let page = await listSavedDialogs(a, saved);
  expect(page.total).toBe(4);
  expect(page.messages).toBe(4);
  expect(page.dialogs.map((d) => d.peer)).toEqual(['me', 'u' + others[2], 'u' + others[1], 'u' + others[0]]);
  expect(page.dialogs[1].last?.id).toBe(last.message.id);
  expect(page.dialogs[1].title).toBe('Г');
  expect(page.dialogs[1].access).toBe(true);
  // закреплённый — выше по времени закрепления, не двигается новым сообщением в других
  await setSavedDialogPin(a, saved, 'u' + others[0], true);
  page = await listSavedDialogs(a, saved);
  expect(page.dialogs.map((d) => d.peer)).toEqual(['me', 'u' + others[0], 'u' + others[2], 'u' + others[1]]);
  expect(page.dialogs[1].pinnedAt).toBeGreaterThan(0);
  // страницы: limit 1 — заметки и закреплённые всегда на первой, остальные — по курсору
  const p1 = await listSavedDialogs(a, saved, { limit: 1 });
  expect(p1.dialogs.map((d) => d.peer)).toEqual(['me', 'u' + others[0], 'u' + others[2]]);
  const p2 = await listSavedDialogs(a, saved, { limit: 1, before: p1.next });
  expect(p2.dialogs.map((d) => d.peer)).toEqual(['u' + others[1]]);
  expect(p2.next).toBeNull();
});

test('title of a source the reader cannot read: only what fwd_from stored; left group, private channel, public channel', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const saved = await openSavedChat(a);
  const group = await makeChat([a, b], 'group');
  await sql`update chats set title = 'Тайная группа' where id = ${group}`;
  const m = (await send(b, group, 'привет')).message;
  await fwd(a, saved, group, m.id);
  let [d] = (await listSavedDialogs(a, saved)).dialogs;
  expect(d.title).toBe('Тайная группа');
  expect(d.access).toBe(true);
  expect(d.sourceChatId).toBe(group);
  await sql`update chats set title = 'Новое имя', photo = '{"id":"x"}' where id = ${group}`;
  [d] = (await listSavedDialogs(a, saved)).dialogs;
  expect(d.title).toBe('Новое имя');   // актуальное, пока участник
  // вышел: нового названия и фото не знает; показываем сохранённое в fwd_from (имя автора, как «Переслано от»), без пути к чату
  await sql`delete from chat_members where chat_id = ${group} and user_id = ${a}`;
  [d] = (await listSavedDialogs(a, saved)).dialogs;
  expect(d.title).toBe('Борис');
  expect(d.photo).toBeNull();
  expect(d.access).toBe(false);
  expect(d.sourceChatId).toBeUndefined();
  expect(JSON.stringify(d)).not.toContain('Новое имя');
  // публичный канал читает любой — название актуальное и источник открывается
  const ch = await makeChat([a, b], 'group');
  await sql`update chats set kind = 'channel', username = 'pubchan', title = 'Канал' where id = ${ch}`;
  await sql`update chat_members set role = 'owner', admin_rights = '{"post":true}' where chat_id = ${ch} and user_id = ${b}`;
  const pub = (await send(b, ch, 'публичный')).message;
  await fwd(a, saved, ch, pub.id);
  await sql`delete from chat_members where chat_id = ${ch} and user_id = ${a}`;
  await sql`update chats set title = 'Канал2' where id = ${ch}`;
  const row = (await listSavedDialogs(a, saved)).dialogs.find((x) => x.peer === 'c' + ch)!;
  expect(row.title).toBe('Канал2');
  expect(row.access).toBe(true);
  expect(row.kind).toBe('channel');
});

test('stranger has no access: list, pin, delete, history, media, search', async () => {
  const a = await makeUser('Анна'), x = await makeUser('Посторонний');
  const saved = await openSavedChat(a);
  await send(a, saved, 'секретная заметка');
  await expect(listSavedDialogs(x, saved)).rejects.toMatchObject({ code: 'not_member' });
  await expect(setSavedDialogPin(x, saved, 'me', true)).rejects.toMatchObject({ code: 'not_member' });
  await expect(deleteSavedDialog(x, saved, 'me', 999)).rejects.toMatchObject({ code: 'not_member' });
  await expect(getHistory(x, saved, null, 50, null, 'me')).rejects.toMatchObject({ code: 'not_member' });
  await expect(getChatMedia(x, saved, 'media', null, 40, 'me')).rejects.toMatchObject({ code: 'not_member' });
  await expect(getChatMediaCounts(x, saved, 'me')).rejects.toMatchObject({ code: 'not_member' });
  await expect(searchMessages(x, 'секретная', { chatId: saved, savedPeer: 'me' })).rejects.toMatchObject({ code: 'not_member' });
  expect((await sql`select count(*)::int as n from saved_dialog_pins`)[0].n).toBe(0);
  expect((await getHistory(a, saved, null, 50)).messages.length).toBe(1);
  // HTTP: тот же отказ и проверка значения
  const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
  const other = await login('Чужой');
  const res = await fetch(`${base}/chats/${saved}/saved-dialogs`, { headers: { cookie: `relay_session=${other.token}` } });
  expect(res.status).toBeGreaterThanOrEqual(400);
  const owner = await login('Владелец');
  const mine = (await (await fetch(`${base}/chats/saved`, { method: 'POST', headers: { cookie: `relay_session=${owner.token}` } })).json()) as { id: number };
  const bad = await fetch(`${base}/chats/${mine.id}/messages?savedPeer=${encodeURIComponent("x' or 1=1")}`, { headers: { cookie: `relay_session=${owner.token}` } });
  expect(bad.status).toBe(400);
  const ok = await fetch(`${base}/chats/${mine.id}/saved-dialogs`, { headers: { cookie: `relay_session=${owner.token}` } });
  expect(ok.status).toBe(200);
});

test('history, search and media filter by source and do not touch the common feed', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const saved = await openSavedChat(a);
  const dm = await makeChat([a, b], 'direct');
  const n1 = (await send(a, saved, 'первая заметка')).message;
  const f1 = (await fwd(a, saved, dm, (await send(b, dm, 'первая пересылка')).message.id)).message;
  const n2 = (await send(a, saved, 'вторая заметка')).message;
  const f2 = (await fwd(a, saved, dm, (await send(b, dm, 'вторая пересылка')).message.id)).message;
  const all = (await getHistory(a, saved, null, 50)).messages.map((m) => m.id);
  expect(all).toEqual([n1.id, f1.id, n2.id, f2.id]);
  expect((await getHistory(a, saved, null, 50, null, 'me')).messages.map((m) => m.id)).toEqual([n1.id, n2.id]);
  const page = await getHistory(a, saved, null, 1, null, 'u' + b);
  expect(page.messages.map((m) => m.id)).toEqual([f2.id]);
  expect(page.hasMore).toBe(true);
  expect((await getHistory(a, saved, f2.id, 10, null, 'u' + b)).messages.map((m) => m.id)).toEqual([f1.id]);
  const hits = await searchMessages(a, 'заметка', { chatId: saved, savedPeer: 'u' + b });
  expect(hits.hits.length).toBe(0);
  const hits2 = await searchMessages(a, 'пересылка', { chatId: saved, savedPeer: 'u' + b });
  expect(hits2.hits.map((h) => h.message.id).sort()).toEqual([f1.id, f2.id].sort());
  expect((await getChatMediaCounts(a, saved, 'me')).media).toBe(0);
  expect((await getChatMedia(a, saved, 'link', null, 40, 'me')).messages.length).toBe(0);
});

test('journal: new message, deletion, auto-delete recount; empty dialog disappears; one event per transaction', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const saved = await openSavedChat(a);
  const dm = await makeChat([a, b], 'direct');
  const f1 = (await fwd(a, saved, dm, (await send(b, dm, 'раз')).message.id)).message;
  let e = await lastDialogEvent(a, 'u' + b);
  expect(e).toMatchObject({ count: 1, lastId: f1.id, dialogs: 1, messages: 1, chatId: saved });
  const f2 = (await fwd(a, saved, dm, (await send(b, dm, 'два')).message.id)).message;
  e = await lastDialogEvent(a, 'u' + b);
  expect(e).toMatchObject({ count: 2, lastId: f2.id, dialogs: 1, messages: 2 });
  await deleteMessage(a, saved, f2.id);
  e = await lastDialogEvent(a, 'u' + b);
  expect(e).toMatchObject({ count: 1, lastId: f1.id, messages: 1 });
  // след стёртого — ни содержимого, ни подчата
  const [gone] = await sql`select saved_peer, body, content from messages where id = ${f2.id}`;
  expect(gone.saved_peer).toBeNull();
  // срок вышел: задача стирает и пересчитывает
  await sql`update messages set expires_at = now() - interval '1 second' where id = ${f1.id}`;
  await expireStep();
  e = await lastDialogEvent(a, 'u' + b);
  expect(e).toMatchObject({ count: 0, lastId: null, dialogs: 0, messages: 0 });
  expect((await listSavedDialogs(a, saved)).dialogs.length).toBe(0);
  // посторонний ничего не получает
  expect((await journalOf(b, 'savedDialog')).length).toBe(0);
});

test('pin: limit, unpin, not for an empty dialog, dropped with the last message', async () => {
  const a = await makeUser('Анна');
  const saved = await openSavedChat(a);
  const peers: string[] = [];
  for (let i = 0; i <= SAVED_PIN_LIMIT; i++) {
    const u = await makeUser('U' + i), dm = await makeChat([a, u], 'direct');
    await fwd(a, saved, dm, (await send(u, dm, 'м' + i)).message.id);
    peers.push('u' + u);
  }
  await expect(setSavedDialogPin(a, saved, 'u999999', true)).rejects.toMatchObject({ code: 'not_found' });
  for (let i = 0; i < SAVED_PIN_LIMIT; i++) expect((await setSavedDialogPin(a, saved, peers[i], true)).pinnedAt).toBeGreaterThan(0);
  expect((await setSavedDialogPin(a, saved, peers[0], true)).pinnedAt).toBeGreaterThan(0);   // повтор безвреден
  await expect(setSavedDialogPin(a, saved, peers[SAVED_PIN_LIMIT], true)).rejects.toMatchObject({ code: 'pin_limit' });
  expect(await setSavedDialogPin(a, saved, peers[0], false)).toEqual({ pinnedAt: null });
  expect((await lastDialogEvent(a, peers[0]))?.pinnedAt).toBeNull();
  // удалили подчат — закрепление снято
  const [row] = (await listSavedDialogs(a, saved)).dialogs.filter((d) => d.peer === peers[1]);
  await deleteSavedDialog(a, saved, peers[1], row.lastId);
  expect((await sql`select 1 from saved_dialog_pins where user_id = ${a} and peer = ${peers[1]}`).length).toBe(0);
  expect(await peersOf(a, saved)).not.toContain(peers[1]);
});

test('delete a dialog: real erase, content gone, keys path of erase, new message after upToId stays', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const saved = await openSavedChat(a);
  const dm = await makeChat([a, b], 'direct');
  const f1 = (await fwd(a, saved, dm, (await send(b, dm, 'раз')).message.id)).message;
  const f2 = (await fwd(a, saved, dm, (await send(b, dm, 'два')).message.id)).message;
  const note = (await send(a, saved, 'заметка')).message;
  const late = (await fwd(a, saved, dm, (await send(b, dm, 'позже')).message.id)).message;
  expect(await deleteSavedDialog(a, saved, 'u' + b, f2.id)).toEqual({ ok: true, erased: 2 });
  const rows = await sql`select id, deleted, body, content, attachment, saved_peer from messages where id = any(${[f1.id, f2.id]}::bigint[])`;
  for (const r of rows) { expect(r.deleted).toBe(true); expect(r.body).toBe(''); expect(r.content).toBeNull(); expect(r.attachment).toBeNull(); expect(r.saved_peer).toBeNull(); }
  expect((await getHistory(a, saved, null, 50)).messages.map((m) => m.id)).toEqual([note.id, late.id]);
  // messageDeleted в журнале — другие устройства и общая лента
  const j = await journalOf(a, 'messageDeleted') as Extract<Update, { type: 'messageDeleted' }>[];
  expect([...new Set(j.map((u) => u.id))].sort()).toEqual([f1.id, f2.id].sort());   // новые сообщения стёртых тоже читаются как удаление
  expect(await lastDialogEvent(a, 'u' + b)).toMatchObject({ count: 1, lastId: late.id });
  expect(await peersOf(a, saved)).toEqual(['me', 'u' + b]);
});
