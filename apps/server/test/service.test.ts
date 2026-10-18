import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { isServiceChat, postService, serviceChatId, systemUserId } from '../src/domain/service';
import { sendMessage } from '../src/domain/messages';
import { reactMessage } from '../src/domain/messageOps';
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

test('service message lands in the journal; the user cannot write or react there', async () => {
  const a = await makeUser('Анна');
  const m = await sql.begin((tx) => postService(tx, a, { type: 'new_login', body: 'Новый вход' }));
  expect(m).toMatchObject({ senderId: await systemUserId(), body: 'Новый вход', service: { type: 'new_login' } });
  const [u] = await sql`select type, payload from updates where user_id = ${a} order by seq desc limit 1`;
  expect(u.type).toBe('newMessage');
  expect(u.payload.message.service).toEqual({ type: 'new_login' });

  await expect(sendMessage(a, { chatId: m.chatId, clientId: crypto.randomUUID(), body: 'ответ' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(reactMessage(a, m.chatId, m.id, '👍')).rejects.toMatchObject({ code: 'forbidden' });
});
