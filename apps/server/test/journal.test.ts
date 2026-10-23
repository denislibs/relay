import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { appendUpdates, currentSeq, fanOut, getUpdates } from '../src/domain/journal';
import { makeUser, resetDb } from './helpers';

beforeEach(resetDb);

const ping = (chatId: number) => ({ type: 'readOwn' as const, chatId, upToId: 1 });

test('fanOut gives every user a gapless seq', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  await sql.begin((tx) => fanOut(tx, [a, b], ping(1)));
  await sql.begin((tx) => fanOut(tx, [a], ping(2)));
  expect(await currentSeq(a)).toBe(2);
  expect(await currentSeq(b)).toBe(1);
  const { items } = await getUpdates(a, 0);
  expect(items.map((i) => i.seq)).toEqual([1, 2]);
  expect(items[1].update).toEqual(ping(2));
});

test('getUpdates returns only what is after `since` and pages with `more`', async () => {
  const a = await makeUser();
  for (let i = 1; i <= 5; i++) await sql.begin((tx) => fanOut(tx, [a], ping(i)));
  const page = await getUpdates(a, 1, 2);
  expect(page.items.map((i) => i.seq)).toEqual([2, 3]);
  expect(page.more).toBe(true);
  expect(page.seq).toBe(5);
  expect((await getUpdates(a, 5)).items).toEqual([]);
});

test('getUpdates reports tooLong when the log was trimmed past `since`', async () => {
  const a = await makeUser();
  for (let i = 1; i <= 3; i++) await sql.begin((tx) => fanOut(tx, [a], ping(i)));
  await sql`delete from updates where user_id = ${a} and seq <= 2`;
  expect((await getUpdates(a, 0)).tooLong).toBe(true);
  expect((await getUpdates(a, 2)).tooLong).toBe(false);
});

test('appendUpdates writes different updates to different users in one call', async () => {
  const a = await makeUser(), b = await makeUser();
  await sql.begin((tx) => appendUpdates(tx, [{ userId: b, update: ping(9) }, { userId: a, update: ping(8) }]));
  expect((await getUpdates(a, 0)).items[0].update).toEqual(ping(8));
  expect((await getUpdates(b, 0)).items[0].update).toEqual(ping(9));
});

test('a rolled-back transaction leaves no seq gap', async () => {
  const a = await makeUser();
  await sql.begin((tx) => fanOut(tx, [a], ping(1)));
  await sql.begin(async (tx) => { await fanOut(tx, [a], ping(2)); throw new Error('boom'); }).catch(() => {});
  await sql.begin((tx) => fanOut(tx, [a], ping(3)));
  expect((await getUpdates(a, 0)).items.map((i) => i.seq)).toEqual([1, 2]);
});

test('a fully trimmed journal is tooLong too, never an empty page with more', async () => {
  const a = await makeUser();
  for (let i = 1; i <= 2; i++) await sql.begin((tx) => fanOut(tx, [a], ping(i)));
  await sql`delete from updates where user_id = ${a}`;
  expect(await getUpdates(a, 1)).toMatchObject({ tooLong: true, items: [] });
  expect((await getUpdates(a, 2)).tooLong).toBe(false); // догнал до конца — снимок не нужен
});

import { deleteMessage, editMessage } from '../src/domain/messageOps';
import { sendMessage } from '../src/domain/messages';
import { saveDraft } from '../src/domain/drafts';
import { makeChat } from './helpers';

const raw = async (userId: number) => (await sql`select type, payload from updates where user_id = ${userId} order by seq`).map((r) => r.payload as Record<string, unknown>);
const SECRET = 'пароль от сейфа 4242';

test('the journal keeps references, not texts: message, edit and draft are stored as ids only', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  const chat = await makeChat([a, b, c]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: SECRET });
  await editMessage(a, chat, message.id, SECRET + ' (новый)');
  await saveDraft(a, chat, SECRET + ' черновик');
  for (const u of [a, b, c]) expect(JSON.stringify(await raw(u))).not.toContain('сейфа');
  expect((await raw(b))[0]).toEqual({ type: 'newMessage', chatId: chat, id: message.id, ref: 1 });
});

test('sync gives the client the same events as before: full message, edit, draft — current state', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'привет' });
  const { editedAt } = await editMessage(a, chat, message.id, 'привет!');
  const { at } = await saveDraft(a, chat, 'пишу…');
  const ups = (await getUpdates(a, 0)).items.map((i) => i.update);
  expect(ups[0]).toEqual({ type: 'newMessage', message: { ...message, body: 'привет!', editedAt } });
  expect(ups[1]).toEqual({ type: 'messageEdited', chatId: chat, id: message.id, body: 'привет!', editedAt, entities: [] });
  expect(ups.at(-1)).toEqual({ type: 'draft', chatId: chat, text: 'пишу…', at: at! });
  await saveDraft(a, chat, '');
  const cleared = (await getUpdates(a, 0)).items.map((i) => i.update).filter((u) => u.type === 'draft');
  expect(cleared.map((u) => (u as { text: string }).text)).toEqual(['', '']);   // оба события черновика — текущее: черновика нет
});

test('a deleted message is not revealed by old journal entries; a vanished chat turns into messageDeleted', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: SECRET });
  await deleteMessage(a, chat, message.id);
  const ups = (await getUpdates(b, 0)).items.map((i) => i.update);
  expect(ups[0]).toMatchObject({ type: 'newMessage', message: { id: message.id, body: '', deleted: true } });
  expect(JSON.stringify(ups)).not.toContain('сейфа');
  await sql`delete from chats where id = ${chat}`;
  const page = await getUpdates(b, 0);
  expect(page.items[0].update).toEqual({ type: 'messageDeleted', chatId: chat, id: message.id });
  expect(page.more).toBe(false);   // ни одна запись не пропала: номера подряд, клиент не зациклится
  expect(page.items.map((i) => i.seq)).toEqual([1, 2]);
});

test('old entries with the full body (written before the change) are read as is', async () => {
  const a = await makeUser('a');
  const legacy = { type: 'newMessage', message: { id: 7, chatId: 1, senderId: a, clientId: 'x', kind: 'text', body: 'старое', replyToId: null, createdAt: new Date(0).toISOString() } };
  await sql`insert into user_seq (user_id, seq) values (${a}, 1)`;
  await sql`insert into updates (user_id, seq, type, payload) values (${a}, 1, 'newMessage', ${sql.json(legacy as never)})`;
  expect((await getUpdates(a, 0)).items).toEqual([{ seq: 1, update: legacy as never }]);
});

test('one fanOut to many users is one statement: contiguous seqs, in entry order, repeated user gets consecutive seqs', async () => {
  const ids: number[] = [];
  for (let i = 0; i < 50; i++) ids.push(await makeUser('u' + i));
  await sql.begin((tx) => fanOut(tx, ids, ping(1)));
  const seqs = await sql.begin((tx) => appendUpdates(tx, [
    { userId: ids[3], update: ping(2) }, { userId: ids[0], update: ping(3) }, { userId: ids[3], update: ping(4) }, { userId: ids[3], update: ping(5) },
  ]));
  expect(seqs).toEqual([2, 2, 3, 4]);   // в порядке entries: ids[3] получает 2,3,4, ids[0] — 2
  for (const id of ids) expect(await currentSeq(id)).toBe(id === ids[3] ? 4 : id === ids[0] ? 2 : 1);
  const { items } = await getUpdates(ids[3], 0);
  expect(items.map((i) => [i.seq, (i.update as { chatId: number }).chatId])).toEqual([[1, 1], [2, 2], [3, 4], [4, 5]]);
});

test('NOTIFY leaves after the commit, not inside it: a rolled-back fanOut pokes nobody, a committed one pokes once with the seqs', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const got: string[] = [];
  const l = await sql.listen('updates', (p) => { got.push(p); });
  await sql.begin(async (tx) => { await fanOut(tx, [a, b], ping(1)); throw new Error('rollback'); }).catch(() => {});
  await Bun.sleep(100);
  expect(got).toEqual([]);
  await sql.begin(async (tx) => {
    await fanOut(tx, [a, b], { type: 'newMessage', message: { id: 1, chatId: 1, senderId: a } as never });
    await appendUpdates(tx, [{ userId: a, update: ping(1) }]);   // у a две записи — ему только пинок
    expect(got).toEqual([]);   // до коммита ничего не ушло
  });
  await Bun.sleep(100);
  expect(got.length).toBe(1);
  const n = JSON.parse(got[0]) as { p: number[]; u: [number, number][]; e: { type: string } };
  expect(n.p).toEqual([a]);
  expect(n.u).toEqual([[b, 1]]);
  expect(n.e.type).toBe('newMessage');
  await l.unlisten();
});

import { notifyPayloads } from '../src/domain/journal';

test('notify payloads for thousands of recipients: several parts, each under 8000 bytes, every recipient exactly once', () => {
  const e = { type: 'newMessage' as const, message: { id: 7, chatId: 1, senderId: 1, body: 'ж'.repeat(1500) } as never };
  const written = Array.from({ length: 3000 }, (_, i) => ({ userId: 100000 + i, seq: 42, update: e }));
  written.push({ userId: 100000, seq: 43, update: { type: 'readOwn', chatId: 1, upToId: 1 } as never });   // две записи — пинок
  const parts = notifyPayloads(written);
  expect(parts.length).toBeGreaterThan(3);
  const seen = new Map<number, number>();
  for (const s of parts) {
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(8000);
    const n = JSON.parse(s) as { p: number[]; u: [number, number][]; e: unknown };
    expect(n.e).toEqual(e);
    for (const id of n.p) seen.set(id, (seen.get(id) ?? 0) + 1);
    for (const [id, seq] of n.u) { expect(seq).toBe(42); seen.set(id, (seen.get(id) ?? 0) + 1); }
    if (n.p.length) expect(n.p).toEqual([100000]);
  }
  expect(seen.size).toBe(3000);
  expect([...seen.values()].every((c) => c === 1)).toBe(true);
  // без inline — простые массивы, тоже частями
  const plain = notifyPayloads(Array.from({ length: 3000 }, (_, i) => ({ userId: 100000 + i, seq: 1, update: { type: 'readOwn', chatId: 1, upToId: 1 } as never })));
  expect(plain.length).toBeGreaterThan(1);
  expect(plain.flatMap((s) => JSON.parse(s) as number[]).length).toBe(3000);
  // длинное сообщение не влезает — всем пинок
  const big = notifyPayloads([{ userId: 1, seq: 1, update: { type: 'newMessage', message: { id: 1, chatId: 1, senderId: 2, body: 'я'.repeat(4096) } } as never }]);
  expect(big).toEqual(['[1]']);
});
