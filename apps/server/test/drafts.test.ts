import { beforeEach, expect, test } from 'bun:test';
import { listChats } from '../src/domain/chats';
import { draftHash } from '@relay/protocol';
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

test('a send clears only the draft it took (draftHash): a draft typed after an offline send survives; null leaves it', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const draftOf = async () => (await listChats(a))[0].draft?.text ?? null;
  // отправка без сети забрала черновик «было», а до сервера раньше неё дошёл новый — «новое»
  await saveDraft(a, chat, 'было');
  await saveDraft(a, chat, 'новое');
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'было', draftHash: await draftHash('было') });
  expect(await draftOf()).toBe('новое');
  const types = (await getUpdates(a, 0)).items.map((i) => i.update.type);
  expect(types.filter((t) => t === 'draft')).toHaveLength(2);   // стирания в журнале нет
  // стикер, чек-лист, пересылка без подписи — черновик не трогают
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'стикер', draftHash: null });
  expect(await draftOf()).toBe('новое');
  // забрала тот же текст — стирается и у всех устройств
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'новое', draftHash: await draftHash('новое') });
  expect(await draftOf()).toBeNull();
  const last = (await getUpdates(a, 0)).items.at(-1)!.update as { type: string; text?: string };
  expect(last).toMatchObject({ type: 'draft', text: '' });
});
