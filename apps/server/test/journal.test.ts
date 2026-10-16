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
