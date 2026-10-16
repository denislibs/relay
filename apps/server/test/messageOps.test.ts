import { beforeEach, expect, test } from 'bun:test';
import { getHistory } from '../src/domain/chats';
import { getUpdates } from '../src/domain/journal';
import { deleteMessage, editMessage, reactMessage } from '../src/domain/messageOps';
import { sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

test('edit, react, delete: journal events for every member, rules enforced, history reflects it', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'опечатка' });

  await expect(editMessage(b, chat, message.id, 'чужое')).rejects.toMatchObject({ code: 'forbidden' });
  const { editedAt } = await editMessage(a, chat, message.id, 'исправлено');
  expect(editedAt).toBeTruthy();

  await reactMessage(b, chat, message.id, '👍');
  await reactMessage(a, chat, message.id, '❤️');
  await reactMessage(b, chat, message.id, '🔥');                     // одна реакция от человека — заменяется
  await expect(reactMessage(a, chat, message.id, 'abc')).rejects.toMatchObject({ code: 'bad_frame' });
  let [h] = (await getHistory(a, chat, null, 10)).messages;
  expect(h).toMatchObject({ body: 'исправлено', deleted: false });
  expect(h.reactions).toEqual([{ userId: a, emoji: '❤️' }, { userId: b, emoji: '🔥' }]);

  await deleteMessage(a, chat, message.id);
  [h] = (await getHistory(b, chat, null, 10)).messages;
  expect(h).toMatchObject({ body: '', deleted: true, reactions: [] });
  await expect(reactMessage(b, chat, message.id, '👍')).rejects.toMatchObject({ code: 'not_found' });

  const types = (await getUpdates(b, 0)).items.map((i) => i.update.type);
  expect(types).toEqual(['newMessage', 'messageEdited', 'reactions', 'reactions', 'reactions', 'messageDeleted']);
});
