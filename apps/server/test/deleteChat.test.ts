import { beforeEach, expect, test } from 'bun:test';
import { deleteDirectChat, getHistory, listChats } from '../src/domain/chats';
import { getUpdates } from '../src/domain/journal';
import { sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const say = (from: number, chatId: number, body: string) => sendMessage(from, { chatId, clientId: crypto.randomUUID(), body });

test('delete just for me: my history and the chat go away, the peer keeps theirs; a new message brings the chat back', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  await say(a, chat, 'раз'); await say(b, chat, 'два');
  await deleteDirectChat(a, chat, false);
  expect((await getHistory(a, chat, null, 10)).messages).toEqual([]);
  expect((await getHistory(b, chat, null, 10)).messages.map((m) => m.body)).toEqual(['раз', 'два']);
  expect((await listChats(a)).some((c) => c.id === chat)).toBe(false);
  expect((await getUpdates(a, 0)).items.map((i) => i.update).at(-1)).toEqual({ type: 'chatRemoved', chatId: chat });
  await say(b, chat, 'три');
  const back = (await listChats(a)).find((c) => c.id === chat)!;
  expect(back).toMatchObject({ unread: 1, last: { body: 'три' } });
  expect((await getHistory(a, chat, null, 10)).messages.map((m) => m.body)).toEqual(['три']);
});

test('delete for both: neither sees the history; groups are refused', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const chat = await makeChat([a, b]);
  await say(a, chat, 'секрет');
  await deleteDirectChat(b, chat, true);
  expect((await getHistory(a, chat, null, 10)).messages).toEqual([]);
  expect((await getHistory(b, chat, null, 10)).messages).toEqual([]);
  const group = await makeChat([a, b, c]);
  await expect(deleteDirectChat(a, group, true)).rejects.toMatchObject({ code: 'bad_frame' });
});
