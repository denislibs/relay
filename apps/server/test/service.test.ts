import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { isServiceChat, postService, serviceChatId, systemUserId } from '../src/domain/service';
import { sendMessage } from '../src/domain/messages';
import { editMessage, reactMessage } from '../src/domain/messageOps';
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

  // писать в «Relay» можно (как в Telegram — ответа просто не будет), править — только свои
  const mine = await sendMessage(a, { chatId: m.chatId, clientId: crypto.randomUUID(), body: 'заметка себе' });
  expect(mine.message.body).toBe('заметка себе');
  await editMessage(a, m.chatId, mine.message.id, 'заметка себе (правка)');
  await expect(editMessage(a, m.chatId, m.id, 'правка')).rejects.toBeDefined();
  await expect(reactMessage(a, m.chatId, m.id, '👍')).rejects.toMatchObject({ code: 'forbidden' });
});

test('the system user cannot be blocked or added as a contact (forbidden)', async () => {
  const { addContact, blockUser } = await import('../src/domain/contacts');
  const sys = await systemUserId();
  const a = await makeUser('Анна');
  await sql.begin((tx) => postService(tx, a, { type: 'new_login', body: 'Новый вход' }));   // общий чат — «Relay» виден
  await expect(blockUser(a, sys)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(addContact(a, { userId: sys, firstName: 'Relay' })).rejects.toMatchObject({ code: 'forbidden' });
  expect((await sql`select count(*)::int as n from blocks where owner_id = ${a}`)[0].n).toBe(0);
  expect((await sql`select count(*)::int as n from contacts where owner_id = ${a}`)[0].n).toBe(0);
});

test('110_service.sql runs again harmlessly: one system user, pending code sign-ins stay unconfirmed, new sessions default to confirmed', async () => {
  const { createSession } = await import('../src/auth');
  const a = await makeUser('Анна');
  await createSession(a, undefined, { confirmed: false });
  const text = await Bun.file(new URL('../migrations/110_service.sql', import.meta.url)).text();
  await sql.begin((tx) => tx.unsafe(text));
  await sql.begin((tx) => tx.unsafe(text));
  expect((await sql`select count(*)::int as n from users where system`)[0].n).toBe(1);
  expect((await sql`select confirmed_at from sessions where user_id = ${a}`)[0].confirmed_at).toBeNull();
  const [d] = await sql`insert into sessions (token_hash, user_id, expires_at) values (${crypto.randomUUID()}, ${a}, now() + interval '1 day') returning confirmed_at`;
  expect(d.confirmed_at).not.toBeNull();
});
