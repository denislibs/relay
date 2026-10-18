import { beforeEach, expect, test } from 'bun:test';
import { normalizeEntities, parseClientFrame } from '@relay/protocol';
import { getHistory, listChats } from '../src/domain/chats';
import { saveDraft } from '../src/domain/drafts';
import { getUpdates } from '../src/domain/journal';
import { editMessage } from '../src/domain/messageOps';
import { sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

test('normalizeEntities keeps only known, in-range, safe entities and merges one type', () => {
  expect(normalizeEntities('hello world', [
    { type: 'bold', offset: 0, length: 3 }, { type: 'bold', offset: 2, length: 3 },   // склеиваются
    { type: 'italic', offset: 6, length: 99 },                                         // обрезается по тексту
    { type: 'evil', offset: 0, length: 1 }, { type: 'bold', offset: 1.5, length: 1 }, { type: 'code', offset: 20, length: 2 },
    { type: 'link', offset: 0, length: 5, url: 'javascript:alert(1)' }, { type: 'link', offset: 6, length: 5, url: 'https://ok.example' },
    null, 'x', { type: 'bold', offset: -5, length: 3 },
  ])).toEqual([
    { type: 'bold', offset: 0, length: 5 },
    { type: 'italic', offset: 6, length: 5 }, { type: 'link', offset: 6, length: 5, url: 'https://ok.example' },
  ]);
  expect(normalizeEntities('x', 'nope')).toEqual([]);
  expect(normalizeEntities('a'.repeat(500), Array.from({ length: 300 }, (_, i) => ({ type: i % 2 ? 'bold' : 'italic', offset: i, length: 1 }))).length).toBeLessThanOrEqual(100);
  // кадр с мусорным оформлением не отвергается: мусор просто отбрасывается
  const f = parseClientFrame(JSON.stringify({ op: 'send', reqId: 'r', clientId: crypto.randomUUID(), chatId: 1, body: 'hi', entities: [{ type: 'bold', offset: 0, length: 2 }, { type: 'x' }] }));
  expect(f).toMatchObject({ op: 'send', entities: [{ type: 'bold', offset: 0, length: 2 }] });
});

test('formatted messages: trimmed with their entities, stored, edited through the journal, gone on delete', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: '  жирный и ссылка ', entities: [
    { type: 'bold', offset: 2, length: 6 }, { type: 'link', offset: 11, length: 6, url: 'https://relay.example' },
  ] });
  expect(message).toMatchObject({ body: 'жирный и ссылка', entities: [{ type: 'bold', offset: 0, length: 6 }, { type: 'link', offset: 9, length: 6, url: 'https://relay.example' }] });
  let [h] = (await getHistory(b, chat, null, 10)).messages;
  expect(h.entities).toEqual(message.entities);

  await editMessage(a, chat, message.id, 'теперь курсив', [{ type: 'italic', offset: 7, length: 6 }]);
  const edited = (await getUpdates(b, 0)).items.map((i) => i.update).find((u) => u.type === 'messageEdited');
  expect(edited).toMatchObject({ body: 'теперь курсив', entities: [{ type: 'italic', offset: 7, length: 6 }] });
  [h] = (await getHistory(a, chat, null, 10)).messages;
  expect(h.entities).toEqual([{ type: 'italic', offset: 7, length: 6 }]);

  await editMessage(a, chat, message.id, 'просто текст');
  [h] = (await getHistory(a, chat, null, 10)).messages;
  expect(h.entities).toBeUndefined();
});

test('drafts keep formatting; same text with other formatting is a change', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  expect((await saveDraft(a, chat, 'черновик')).changed).toBe(true);
  expect((await saveDraft(a, chat, 'черновик', [{ type: 'bold', offset: 0, length: 8 }])).changed).toBe(true);
  expect((await saveDraft(a, chat, 'черновик', [{ type: 'bold', offset: 0, length: 8 }])).changed).toBe(false);
  expect((await listChats(a))[0].draft).toMatchObject({ text: 'черновик', entities: [{ type: 'bold', offset: 0, length: 8 }] });
  const last = (await getUpdates(a, 0)).items.at(-1)!.update;
  expect(last).toMatchObject({ type: 'draft', entities: [{ type: 'bold', offset: 0, length: 8 }] });
});
