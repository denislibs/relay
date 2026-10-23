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
  // sendMessage ещё пишет в личные журналы (переводится в следующем коммите) — здесь журнал чата заполняем сами
  await sql.begin(async (tx) => { for (const id of sent) await chatEvent(tx, g, { type: 'newMessage', message: { id, chatId: g } as never }, 'group'); });
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
