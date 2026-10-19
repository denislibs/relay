import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { listChats } from '../src/domain/chats';
import { setChatNotify } from '../src/domain/chatNotify';
import { getUpdates } from '../src/domain/journal';
import { planPush, subscribe } from '../src/domain/push';
import { makeChat, makeUser, pushBrowser, resetDb } from './helpers';

beforeEach(resetDb);

async function sessionFor(userId: number): Promise<number> {
  const [r] = await sql`insert into sessions (token_hash, user_id, expires_at) values (${crypto.randomUUID()}, ${userId}, now() + interval '30 days') returning id`;
  return Number(r.id);
}
const msg = (chatId: number, senderId: number) => ({ chatId, id: 1, senderId, body: 'привет' });

test('chat mute: journal of own devices only, snapshot, push skipped while muted and resumes after', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  await subscribe(b, { endpoint: 'https://push.test/b', keys: (await pushBrowser()).keys }, await sessionFor(b));
  expect(await planPush(msg(chat, a))).toHaveLength(1);

  const until = Date.now() + 8 * 3600_000;
  expect(await setChatNotify(b, chat, { muteUntil: until })).toEqual({ muteUntil: until });
  expect((await getUpdates(b, 0)).items.map((i) => i.update)).toEqual([{ type: 'chatNotify', chatId: chat, muteUntil: until }]);
  expect((await getUpdates(a, 0)).items).toEqual([]);                    // другим участникам — ничего
  expect((await listChats(b))[0].muteUntil).toBe(until);
  expect((await listChats(a))[0].muteUntil).toBeNull();
  expect(await planPush(msg(chat, a))).toEqual([]);

  // прошло 8 часов: срок оказался в прошлом
  await sql`update chat_members set mute_until = now() - interval '1 second' where chat_id = ${chat} and user_id = ${b}`;
  expect(await planPush(msg(chat, a))).toHaveLength(1);
  expect((await listChats(b))[0].muteUntil).toBeNull();

  // навсегда: 0 ↔ 'infinity'
  await setChatNotify(b, chat, { muteUntil: 0 });
  expect((await listChats(b))[0].muteUntil).toBe(0);
  expect(await planPush(msg(chat, a))).toEqual([]);

  // null включает
  await setChatNotify(b, chat, { muteUntil: null });
  expect((await listChats(b))[0].muteUntil).toBeNull();
  expect(await planPush(msg(chat, a))).toHaveLength(1);
  expect((await getUpdates(b, 0)).items.map((i) => (i.update as { muteUntil: number | null }).muteUntil)).toEqual([until, 0, null]);
});

test('chat mute: old per-subscription muted list still works; validation and membership', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const chat = await makeChat([a, b]);
  await subscribe(b, { endpoint: 'https://push.test/b2', keys: (await pushBrowser()).keys, muted: [chat] }, await sessionFor(b));
  expect(await planPush(msg(chat, a))).toEqual([]);

  for (const bad of [undefined, '5', 1.5, -1, NaN, Infinity, {}, true])
    await expect(setChatNotify(a, chat, { muteUntil: bad })).rejects.toMatchObject({ code: 'bad_frame' });
  await expect(setChatNotify(a, chat, null)).rejects.toMatchObject({ code: 'bad_frame' });
  await expect(setChatNotify(c, chat, { muteUntil: null })).rejects.toMatchObject({ code: 'not_member' });
  expect((await getUpdates(a, 0)).items).toEqual([]);
});
