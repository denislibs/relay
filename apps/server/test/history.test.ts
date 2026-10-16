import { beforeEach, expect, test } from 'bun:test';
import { getHistory, listChats } from '../src/domain/chats';
import { sendMessage } from '../src/domain/messages';
import { markRead } from '../src/domain/reads';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const send = (u: number, chat: number, body: string) => sendMessage(u, { chatId: chat, clientId: crypto.randomUUID(), body }).then((r) => r.message.id);

test('chat list: newest first, last message and unread from others only', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  const ab = await makeChat([a, b]), ac = await makeChat([a, c]);
  await send(b, ab, 'b1');
  await send(b, ab, 'b2');
  await send(a, ab, 'мой');
  await send(c, ac, 'c1');
  const list = await listChats(a);
  expect(list.map((x) => x.id)).toEqual([ac, ab]);
  expect(list[0]).toMatchObject({ unread: 1, last: { body: 'c1' } });
  expect(list[1]).toMatchObject({ unread: 2, last: { body: 'мой' } });
});

test('unread drops after markRead', async () => {
  const a = await makeUser(), b = await makeUser();
  const ab = await makeChat([a, b]);
  const m = await send(b, ab, 'x');
  await markRead(a, ab, m);
  expect((await listChats(a))[0]).toMatchObject({ unread: 0, lastReadId: m });
});

test('history pages backwards and returns ascending ids', async () => {
  const a = await makeUser(), b = await makeUser();
  const ab = await makeChat([a, b]);
  const ids: number[] = [];
  for (let i = 1; i <= 5; i++) ids.push(await send(a, ab, String(i)));
  const page1 = await getHistory(b, ab, null, 2);
  expect(page1.messages.map((m) => m.id)).toEqual([ids[3], ids[4]]);
  expect(page1.hasMore).toBe(true);
  const page2 = await getHistory(b, ab, ids[3], 10);
  expect(page2.messages.map((m) => m.id)).toEqual([ids[0], ids[1], ids[2]]);
  expect(page2.hasMore).toBe(false);
});

test('history is members only', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const ab = await makeChat([a, b]);
  await expect(getHistory(c, ab, null, 10)).rejects.toMatchObject({ code: 'not_member' });
});
