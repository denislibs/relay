import { beforeEach, expect, test } from 'bun:test';
import { listChats } from '../src/domain/chats';
import { saveDraft } from '../src/domain/drafts';
import { getUpdates } from '../src/domain/journal';
import { sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

test('drafts: saved to own journal, identical text writes nothing, cleared by sending, part of the snapshot', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);

  expect((await saveDraft(a, chat, 'недописанное')).changed).toBe(true);
  expect((await saveDraft(a, chat, 'недописанное')).changed).toBe(false);          // тот же текст — без записи
  let page = await getUpdates(a, 0);
  expect(page.items.map((i) => i.update)).toEqual([expect.objectContaining({ type: 'draft', chatId: chat, text: 'недописанное' })]);
  expect((await getUpdates(b, 0)).items).toEqual([]);                               // чужим не видно
  expect((await listChats(a))[0].draft).toMatchObject({ text: 'недописанное' });

  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'недописанное' });
  page = await getUpdates(a, 0);
  expect(page.items.map((i) => i.update.type)).toEqual(['draft', 'newMessage', 'draft']);
  expect((page.items.at(-1)!.update as { text: string }).text).toBe('');
  expect((await listChats(a))[0].draft).toBeNull();
});
