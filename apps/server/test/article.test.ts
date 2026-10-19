import { beforeEach, expect, test } from 'bun:test';
import { editMessage } from '../src/domain/messageOps';
import { sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const cid = () => crypto.randomUUID();
const article = [
  { type: 'h', level: 1, text: 'План' },
  { type: 'p', text: 'важно', entities: [{ type: 'bold', offset: 0, length: 5 }] },
  { type: 'ul', items: [[{ type: 'p', text: 'раз' }], [{ type: 'p', text: 'два' }]] },
  { type: 'quote', blocks: [{ type: 'p', text: 'цитата' }] },
  { type: 'code', text: 'x()', lang: 'js' },
  { type: 'hr' },
];

test('an article keeps its blocks; body is its plain text (server-computed); no link preview', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: cid(), body: 'что угодно https://example.com', blocks: article });
  expect(message.blocks?.map((x) => x.type)).toEqual(['h', 'p', 'ul', 'quote', 'code', 'hr']);
  expect(message.body).toBe('План\nважно\n• раз\n• два\nцитата\nx()\n———');
  expect(message.link ?? null).toBeNull();
});

test('invalid blocks or an article with an attachment are refused; an article is not editable as text', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  await expect(sendMessage(a, { chatId: chat, clientId: cid(), body: '', blocks: [{ type: 'iframe', src: 'x' }] })).rejects.toMatchObject({ code: 'bad_frame' });
  await expect(sendMessage(a, { chatId: chat, clientId: cid(), body: '', blocks: article, attachment: { id: crypto.randomUUID() } })).rejects.toMatchObject({ code: 'bad_frame' });
  const { message } = await sendMessage(a, { chatId: chat, clientId: cid(), body: '', blocks: article });
  await expect(editMessage(a, chat, message.id, 'новый текст')).rejects.toMatchObject({ code: 'bad_frame' });
});

test('forwarding an article copies its blocks', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  const { message: src } = await sendMessage(a, { chatId: ab, clientId: cid(), body: '', blocks: article });
  const { message } = await sendMessage(b, { chatId: bc, clientId: cid(), body: '', forward: { chatId: ab, id: src.id } });
  expect(message.blocks).toEqual(src.blocks);
  expect(message.body).toBe(src.body);
});
