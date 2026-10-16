import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { getUpdates } from '../src/domain/journal';
import { sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const cid = () => crypto.randomUUID();

test('send stores the message and writes newMessage to every member', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const { message, duplicate } = await sendMessage(a, { chatId: chat, clientId: cid(), body: 'привет' });
  expect(duplicate).toBe(false);
  expect(message).toMatchObject({ chatId: chat, senderId: a, body: 'привет', kind: 'text', replyToId: null });
  for (const u of [a, b]) {
    const { items } = await getUpdates(u, 0);
    expect(items).toEqual([{ seq: 1, update: { type: 'newMessage', message } }]);
  }
});

test('repeating a clientId returns the same message and writes nothing new', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const clientId = cid();
  const first = await sendMessage(a, { chatId: chat, clientId, body: 'раз' });
  const again = await sendMessage(a, { chatId: chat, clientId, body: 'раз' });
  expect(again.duplicate).toBe(true);
  expect(again.message.id).toBe(first.message.id);
  expect((await getUpdates(b, 0)).items).toHaveLength(1);
  const [{ n }] = await sql`select count(*)::int as n from messages`;
  expect(n).toBe(1);
});

test('non-members cannot send', async () => {
  const a = await makeUser(), b = await makeUser(), stranger = await makeUser();
  const chat = await makeChat([a, b]);
  await expect(sendMessage(stranger, { chatId: chat, clientId: cid(), body: 'x' })).rejects.toMatchObject({ code: 'not_member' });
});

test('empty and too long bodies are rejected', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  await expect(sendMessage(a, { chatId: chat, clientId: cid(), body: '   ' })).rejects.toMatchObject({ code: 'bad_frame' });
  await expect(sendMessage(a, { chatId: chat, clientId: cid(), body: 'x'.repeat(4097) })).rejects.toMatchObject({ code: 'too_long' });
});

test('replyToId must point to a message in the same chat', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]), other = await makeChat([a, b]);
  const { message } = await sendMessage(a, { chatId: other, clientId: cid(), body: 'там' });
  await expect(sendMessage(a, { chatId: chat, clientId: cid(), body: 'ответ', replyToId: message.id })).rejects.toMatchObject({ code: 'not_found' });
});
