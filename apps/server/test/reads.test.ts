import { beforeEach, expect, test } from 'bun:test';
import { getUpdates } from '../src/domain/journal';
import { sendMessage } from '../src/domain/messages';
import { markRead } from '../src/domain/reads';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const send = (u: number, chat: number, body: string) => sendMessage(u, { chatId: chat, clientId: crypto.randomUUID(), body }).then((r) => r.message.id);

test('read moves the pointer and tells own devices and the sender', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const m1 = await send(a, chat, 'раз');
  expect(await markRead(b, chat, m1)).toEqual({ lastReadId: m1, changed: true });
  const own = (await getUpdates(b, 1)).items.map((i) => i.update);
  expect(own).toEqual([{ type: 'readOwn', chatId: chat, upToId: m1 }]);
  const toSender = (await getUpdates(a, 1)).items.map((i) => i.update);
  expect(toSender).toEqual([{ type: 'readBy', chatId: chat, userId: b, upToId: m1 }]);
});

test('the pointer never moves back and repeated reads write nothing', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const m1 = await send(a, chat, '1'), m2 = await send(a, chat, '2');
  await markRead(b, chat, m2);
  expect(await markRead(b, chat, m1)).toEqual({ lastReadId: m2, changed: false });
  expect(await markRead(b, chat, m2)).toEqual({ lastReadId: m2, changed: false });
  expect((await getUpdates(a, 0)).items.filter((i) => i.update.type === 'readBy')).toHaveLength(1);
});

test('cannot read past the newest message', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const m1 = await send(a, chat, '1');
  await expect(markRead(b, chat, m1 + 1000)).rejects.toMatchObject({ code: 'not_found' });
});

test('strangers cannot mark read', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const chat = await makeChat([a, b]);
  const m1 = await send(a, chat, '1');
  await expect(markRead(c, chat, m1)).rejects.toMatchObject({ code: 'not_member' });
});
