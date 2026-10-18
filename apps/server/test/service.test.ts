import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { isServiceChat, serviceChatId, systemUserId } from '../src/domain/service';
import { makeUser, resetDb } from './helpers';

beforeEach(resetDb);

test('system user exists and survives a reset; the service chat is created once per user', async () => {
  const sys = await systemUserId();
  const [u] = await sql`select name, system from users where id = ${sys}`;
  expect(u).toMatchObject({ name: 'Relay', system: true });

  const a = await makeUser('Анна');
  const chat = await serviceChatId(sql, a);
  expect(await serviceChatId(sql, a)).toBe(chat);
  const members = (await sql`select user_id from chat_members where chat_id = ${chat} order by user_id`).map((r) => Number(r.user_id));
  expect(members.sort()).toEqual([a, sys].sort());
  expect(await isServiceChat(sql, chat)).toBe(true);
});
