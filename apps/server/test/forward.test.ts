import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { blockUser } from '../src/domain/contacts';
import { fileFor } from '../src/domain/files';
import { sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const cid = () => crypto.randomUUID();

/** Готовое вложение-фото у владельца — как после загрузки. */
async function photo(owner: number): Promise<string> {
  const [r] = await sql`insert into attachments (owner_id, mime, name, size, status, kind, width, height)
    values (${owner}, 'image/jpeg', 'cat.jpg', 10, 'ready', 'photo', 800, 600) returning id`;
  return r.id as string;
}

test('forward copies text and formatting, remembers the original author, no reply link', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  const { message: src } = await sendMessage(a, { chatId: ab, clientId: cid(), body: 'привет **всем**', entities: [{ type: 'bold', offset: 7, length: 5 }] });
  const { message } = await sendMessage(b, { chatId: bc, clientId: cid(), body: '', forward: { chatId: ab, id: src.id } });
  expect(message).toMatchObject({ chatId: bc, senderId: b, kind: 'text', body: src.body, replyToId: null, fwdFrom: { userId: a, name: 'Анна', chatId: ab, messageId: src.id } });
  expect(message.entities).toEqual(src.entities);
});

test('forwarding a forward keeps the first author; hiding the sender drops the header', async () => {
  const a = await makeUser('Анна'), b = await makeUser(), c = await makeUser(), d = await makeUser();
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]), cd = await makeChat([c, d]);
  const { message: src } = await sendMessage(a, { chatId: ab, clientId: cid(), body: 'исходное' });
  const { message: f1 } = await sendMessage(b, { chatId: bc, clientId: cid(), body: '', forward: { chatId: ab, id: src.id } });
  const { message: f2 } = await sendMessage(c, { chatId: cd, clientId: cid(), body: '', forward: { chatId: bc, id: f1.id } });
  expect(f2.fwdFrom).toMatchObject({ userId: a, messageId: src.id, chatId: ab });
  const { message: hidden } = await sendMessage(c, { chatId: cd, clientId: cid(), body: '', forward: { chatId: bc, id: f1.id, hideSender: true } });
  expect(hidden.fwdFrom ?? null).toBeNull();
  expect(hidden.body).toBe('исходное');
});

test('media: the same file reaches the new chat without re-upload; caption can be hidden', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  const id = await photo(a);
  const { message: src } = await sendMessage(a, { chatId: ab, clientId: cid(), body: 'котик', attachment: { id } });
  expect(await fileFor(c, id)).toBeNull();   // пока не переслали — чужой файл недоступен
  const groupId = crypto.randomUUID();
  const { message } = await sendMessage(b, { chatId: bc, clientId: cid(), body: '', groupId, forward: { chatId: ab, id: src.id } });
  expect(message).toMatchObject({ kind: 'photo', body: 'котик', groupId, attachment: { id } });
  expect(await fileFor(c, id)).not.toBeNull();
  const { message: bare } = await sendMessage(b, { chatId: bc, clientId: cid(), body: '', forward: { chatId: ab, id: src.id, hideCaption: true } });
  expect(bare.body).toBe('');
  expect(bare.attachment).toMatchObject({ id });
});

test('cannot forward from a chat you are not in, a deleted or service message', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  const { message: src } = await sendMessage(a, { chatId: ab, clientId: cid(), body: 'тайна' });
  await expect(sendMessage(c, { chatId: bc, clientId: cid(), body: '', forward: { chatId: ab, id: src.id } })).rejects.toMatchObject({ code: 'not_member' });
  await sql`update messages set deleted = true where id = ${src.id}`;
  await expect(sendMessage(b, { chatId: bc, clientId: cid(), body: '', forward: { chatId: ab, id: src.id } })).rejects.toMatchObject({ code: 'not_found' });
  const [svc] = await sql`insert into messages (chat_id, sender_id, client_id, kind, body, service_type) values (${ab}, ${a}, ${cid()}, 'text', '', 'chat_created') returning id`;
  await expect(sendMessage(b, { chatId: bc, clientId: cid(), body: '', forward: { chatId: ab, id: svc.id as number } })).rejects.toMatchObject({ code: 'not_found' });
});

test('forward into a chat where you are blocked is refused, like a normal send', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  const { message: src } = await sendMessage(a, { chatId: ab, clientId: cid(), body: 'x' });
  await blockUser(c, b);
  await expect(sendMessage(b, { chatId: bc, clientId: cid(), body: '', forward: { chatId: ab, id: src.id } })).rejects.toBeDefined();
});

test('repeating a forward clientId returns the same copy', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  const { message: src } = await sendMessage(a, { chatId: ab, clientId: cid(), body: 'раз' });
  const clientId = cid();
  const first = await sendMessage(b, { chatId: bc, clientId, body: '', forward: { chatId: ab, id: src.id } });
  const again = await sendMessage(b, { chatId: bc, clientId, body: '', forward: { chatId: ab, id: src.id } });
  expect(again.duplicate).toBe(true);
  expect(again.message.id).toBe(first.message.id);
});

test('a track from my profile music can be sent by id even if someone else uploaded it; a stranger\'s file cannot', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const bc = await makeChat([b, c]);
  const [att] = await sql`insert into attachments (owner_id, mime, name, size, status, kind, duration) values (${a}, 'audio/mpeg', 'song.mp3', 10, 'ready', 'audio', 120) returning id`;
  await expect(sendMessage(b, { chatId: bc, clientId: cid(), body: '', attachment: { id: att.id as string } })).rejects.toMatchObject({ code: 'not_found' });
  await sql`insert into profile_music (user_id, attachment_id, title, duration) values (${b}, ${att.id}, 'song', 120)`;
  const { message } = await sendMessage(b, { chatId: bc, clientId: cid(), body: '', attachment: { id: att.id as string } });
  expect(message).toMatchObject({ kind: 'audio', attachment: { id: att.id } });
});
