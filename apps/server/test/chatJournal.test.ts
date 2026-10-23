import { beforeEach, expect, test } from 'bun:test';
import type { Update } from '@relay/protocol';
import { sql } from '../src/db';
import { chatSeqOf, chatSeqsSince, getChatUpdates } from '../src/domain/chatJournal';
import { appendUpdates, chatEvent, currentSeq, flushJournals, getUpdates, membershipEvent } from '../src/domain/journal';
import { sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

const pins = (chatId: number, ids: number[]): Update => ({ type: 'pins', chatId, ids });
const rows = (chatId: number) => sql`select seq, type from chat_updates where chat_id = ${chatId} order by seq`;

test('events of one transaction get consecutive seqs in one chat_seq bump; nothing lands in personal journals', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  const g = await makeChat([a, b, c]);
  await sql.begin(async (tx) => {
    await chatEvent(tx, g, pins(g, [1]), 'group');
    await chatEvent(tx, g, pins(g, [2]));                 // kind по чату
    await chatEvent(tx, g, pins(g, [3]), 'group');
    expect((await tx`select count(*)::int as n from chat_updates`)[0].n).toBe(0);   // пишется при коммите
  });
  expect((await rows(g)).map((r) => [Number(r.seq), r.type])).toEqual([[1, 'pins'], [2, 'pins'], [3, 'pins']]);
  expect(await chatSeqOf(g)).toBe(3);
  for (const u of [a, b, c]) expect(await currentSeq(u)).toBe(0);
});

test('rollback leaves no gap and sends no NOTIFY; a committed transaction sends one chat NOTIFY with all events', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const g = await makeChat([a, b, await makeUser('c')]);
  const got: string[] = [];
  const l = await sql.listen('chat_updates', (p) => { got.push(p); });
  await sql.begin(async (tx) => { await chatEvent(tx, g, pins(g, [1]), 'group'); throw new Error('rollback'); }).catch(() => {});
  await Bun.sleep(100);
  expect(got).toEqual([]);
  expect(await chatSeqOf(g)).toBe(0);
  await sql.begin(async (tx) => { await chatEvent(tx, g, pins(g, [1]), 'group'); await chatEvent(tx, g, pins(g, [2]), 'group'); });
  await Bun.sleep(100);
  expect(got.length).toBe(1);
  expect(JSON.parse(got[0])).toEqual({ c: g, f: 0, t: 2, e: [pins(g, [1]), pins(g, [2])] });
  await l.unlisten();
});

test('two chats in one transaction are both written; a direct chat goes to the personal journals as before', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const g1 = await makeChat([a, b, await makeUser('c')]), g2 = await makeChat([a, b, await makeUser('d')]), d = await makeChat([a, b]);
  await sql.begin(async (tx) => {
    await chatEvent(tx, g2, pins(g2, [1]), 'group');
    await chatEvent(tx, g1, pins(g1, [1]), 'group');
    await chatEvent(tx, d, pins(d, [1]), 'direct');
  });
  expect(await chatSeqOf(g1)).toBe(1);
  expect(await chatSeqOf(g2)).toBe(1);
  expect(await chatSeqOf(d)).toBe(0);
  expect((await getUpdates(a, 0)).items.map((i) => i.update)).toEqual([pins(d, [1])]);
  expect((await getUpdates(b, 0)).items.map((i) => i.update)).toEqual([pins(d, [1])]);
});

test('getChatUpdates: pages with more, hides messages before history_from, tooLong when the log was trimmed', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const g = await makeChat([a, b, await makeUser('c')]);
  const sent: number[] = [];
  for (let i = 0; i < 5; i++) sent.push((await sendMessage(a, { chatId: g, clientId: crypto.randomUUID(), body: 'm' + i })).message.id);
  const p1 = await getChatUpdates(b, g, 0, 2);
  expect(p1.items.map((i) => i.seq)).toEqual([1, 2]);
  expect(p1.more).toBe(true);
  expect(p1.items[0].update.type).toBe('newMessage');
  const p2 = await getChatUpdates(b, g, 2, 10);
  expect(p2.items.map((i) => i.seq)).toEqual([3, 4, 5]);
  expect(p2.more).toBe(false);
  // вступил при скрытой истории: первые три сообщения — как удалённые
  await sql`update chat_members set history_from = ${sent[3]} where chat_id = ${g} and user_id = ${b}`;
  const hidden = await getChatUpdates(b, g, 0, 10);
  expect(hidden.items.map((i) => i.update.type)).toEqual(['messageDeleted', 'messageDeleted', 'messageDeleted', 'newMessage', 'newMessage']);
  // чужой — not_member
  await expect(getChatUpdates(await makeUser('x'), g, 0)).rejects.toMatchObject({ code: 'not_member' });
  // журнал подрезан дальше since — tooLong
  await sql`delete from chat_updates where chat_id = ${g} and seq <= 3`;
  expect((await getChatUpdates(b, g, 1)).tooLong).toBe(true);
  expect((await getChatUpdates(b, g, 3)).tooLong).toBe(false);
});

test('membershipEvent carries the chat seq as of the commit, after the events of the same transaction', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const g = await makeChat([a, b]);
  await sql`update chats set kind = 'group' where id = ${g}`;
  await sql.begin(async (tx) => {
    membershipEvent(tx, b, g, { role: 'member', admin: null, rank: null, rights: {} as never, restricted: false });
    await chatEvent(tx, g, pins(g, [1]), 'group');
    await chatEvent(tx, g, pins(g, [2]), 'group');
  });
  const m = (await getUpdates(b, 0)).items[0].update as { type: string; seq?: number };
  expect(m.type).toBe('membership');
  expect(m.seq).toBe(2);
});

test('selfSeq-style readers: an explicit flush inside the transaction makes the seq visible; chatEvent after it is refused', async () => {
  const a = await makeUser('a');
  const g = await makeChat([a, await makeUser('b'), await makeUser('c')]);
  await sql.begin(async (tx) => {
    await appendUpdates(tx, [{ userId: a, update: { type: 'myStickers' } }]);
    await flushJournals(tx);
    expect((await tx`select seq from user_seq where user_id = ${a}`)[0].seq).toBe(1);
    await appendUpdates(tx, [{ userId: a, update: { type: 'myStickers' } }]);   // допишется хуком перед коммитом
    await expect(chatEvent(tx, g, pins(g, [1]), 'group')).rejects.toThrow(/lock order/);
  });
  expect(await currentSeq(a)).toBe(2);
});

test('chatEvent outside a transaction throws', async () => {
  const a = await makeUser('a');
  const g = await makeChat([a, await makeUser('b'), await makeUser('c')]);
  await expect(chatEvent(sql as never, g, pins(g, [1]), 'group')).rejects.toThrow(/not a transaction/);
});

test('chatSeqsSince lists only groups changed after since, with the db clock as now', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const g1 = await makeChat([a, b, await makeUser('c')]), g2 = await makeChat([a, b, await makeUser('d')]);
  await makeChat([a, b]);   // личный — никогда
  await sql.begin((tx) => chatEvent(tx, g1, pins(g1, [1]), 'group'));
  const first = await chatSeqsSince(a, 0);
  expect(first.items.sort()).toEqual([[g1, 1], [g2, 0]].sort());
  // g1 менялся давно (дальше запаса в 5 с), g2 — только что: since = now первого ответа возвращает только g2
  await sql`update chat_seq set updated_at = updated_at - interval '1 minute' where chat_id = ${g1}`;
  await sql.begin((tx) => chatEvent(tx, g2, pins(g2, [1]), 'group'));
  const later = await chatSeqsSince(a, first.now);
  expect(later.items).toEqual([[g2, 1]]);
  expect(later.now).toBeGreaterThanOrEqual(first.now);
});

import { markRead } from '../src/domain/reads';
import { setChatFlags, unarchiveByMessage } from '../src/domain/chatFlags';
import { setChatNotify } from '../src/domain/chatNotify';
import { listChats } from '../src/domain/chats';

const sendTo = (u: number, chat: number, body = 'm') => sendMessage(u, { chatId: chat, clientId: crypto.randomUUID(), body }).then((r) => r.message.id);

test('readBy in a group goes only to the authors of the messages just read; readOwn stays personal', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c'), d = await makeUser('d');
  const g = await makeChat([a, b, c, d]);
  await sendTo(a, g); const m2 = await sendTo(a, g); await sendTo(c, g); const last = await sendTo(a, g);
  await markRead(b, g, m2);
  const by = async (u: number) => (await getUpdates(u, 0)).items.map((i) => i.update).filter((x) => x.type === 'readBy');
  expect((await by(a)).map((x) => (x as { upToId: number }).upToId)).toEqual([m2]);
  expect(await by(c)).toEqual([]);   // её сообщение дальше границы прочтения
  expect(await by(d)).toEqual([]);   // не автор — ничего
  expect((await getUpdates(b, 0)).items.map((i) => i.update.type)).toContain('readOwn');
  await markRead(b, g, last);
  expect((await by(c)).map((x) => (x as { upToId: number }).upToId)).toEqual([last]);
  // в списке у автора peerReadUpTo группы — «кто-то дочитал до»
  expect((await listChats(a, { ids: [g] }))[0].peerReadUpTo).toBe(last);
});

test('group unarchive is a conditional operation: newer foreign message lifts the archive, older/own/muted do not; re-archive moves the boundary', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const g = await makeChat([a, b, await makeUser('c')]);
  const old = await sendTo(b, g);
  await setChatFlags(a, g, { pinned: true });
  const archived = await setChatFlags(a, g, { archived: true });
  expect(archived).toMatchObject({ archived: true, pinnedAt: null, archivedAtId: old });
  // сообщение в группу само архив не снимает (сервер не пишет каждому участнику)
  const fresh = await sendTo(b, g);
  expect((await listChats(a, { ids: [g] }))[0].archived).toBe(true);
  // старое — нет; своё — нет; свежее чужое — да, с chatFlags в личный журнал
  expect(await unarchiveByMessage(a, g, { messageId: old })).toMatchObject({ changed: false, archived: true });
  const own = await sendTo(a, g);
  expect(await unarchiveByMessage(a, g, { messageId: own })).toMatchObject({ changed: false, archived: true });
  const lifted = await unarchiveByMessage(a, g, { messageId: fresh });
  expect(lifted).toMatchObject({ changed: true, archived: false, pinnedAt: null, archivedAtId: old });
  expect((await getUpdates(a, 0)).items.map((i) => i.update).filter((x) => x.type === 'chatFlags').at(-1)).toMatchObject({ chatId: g, archived: false, archivedAtId: old });
  // повтор того же сообщения после ручной повторной архивации — граница сдвинулась, архив остаётся
  const again = await setChatFlags(a, g, { archived: true });
  expect(again.archivedAtId).toBe(own);
  expect(await unarchiveByMessage(a, g, { messageId: fresh })).toMatchObject({ changed: false, archived: true });
  // повторная запись archived = true поверх архивного тоже двигает границу
  const newer = await sendTo(b, g);
  expect((await setChatFlags(a, g, { archived: true })).archivedAtId).toBe(newer);
  // заглушённый — остаётся
  const next = await sendTo(b, g);
  await setChatNotify(a, g, { muteUntil: 0 });
  expect(await unarchiveByMessage(a, g, { messageId: next })).toMatchObject({ changed: false, archived: true });
  await expect(unarchiveByMessage(a, g, { messageId: 'x' })).rejects.toMatchObject({ code: 'bad_frame' });
  await expect(unarchiveByMessage(await makeUser('z'), g, { messageId: next })).rejects.toMatchObject({ code: 'not_member' });
});
