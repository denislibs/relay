import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { listChats } from '../src/domain/chats';
import { deleteMessage } from '../src/domain/messageOps';
import { pinMessage, unpinMessage } from '../src/domain/pins';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

const put = async (chatId: number, sender: number, body = 'x') =>
  Number((await sql`insert into messages (chat_id, sender_id, client_id, kind, body) values (${chatId}, ${sender}, ${crypto.randomUUID()}, 'text', ${body}) returning id`)[0].id);
const pinsUpdates = async (userId: number) =>
  (await sql`select type, payload from updates where user_id = ${userId} and type = 'pins' order by seq`).map((r) => ({ ...(r.payload as object), type: r.type as string }));

test('pin and unpin: everyone in the chat gets the new list, newest first; the chat snapshot carries it', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Чужой');
  const chat = await makeChat([a, b]);
  const m1 = await put(chat, a), m2 = await put(chat, b);
  expect(await pinMessage(a, chat, m1)).toEqual({ ids: [m1] });
  expect(await pinMessage(b, chat, m2)).toEqual({ ids: [m2, m1] });
  expect(await pinMessage(b, chat, m2)).toEqual({ ids: [m2, m1] });        // повтор — без нового события
  expect((await pinsUpdates(b)).map((u) => (u as { ids: number[] }).ids)).toEqual([[m1], [m2, m1]]);
  expect((await listChats(a)).find((x) => x.id === chat)?.pinned).toEqual([m2, m1]);
  await expect(pinMessage(c, chat, m1)).rejects.toMatchObject({ code: 'not_member' });
  expect(await unpinMessage(a, chat, m2)).toEqual({ ids: [m1] });
  expect(await unpinMessage(a, chat, null)).toEqual({ ids: [] });
  expect((await pinsUpdates(a)).at(-1)).toMatchObject({ type: 'pins', chatId: chat, ids: [] });
});

test('deleting a pinned message unpins it; a deleted message cannot be pinned', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const m1 = await put(chat, a), m2 = await put(chat, a);
  await pinMessage(a, chat, m1); await pinMessage(a, chat, m2);
  await deleteMessage(a, chat, m2);
  expect((await listChats(b)).find((x) => x.id === chat)?.pinned).toEqual([m1]);
  expect((await pinsUpdates(b)).at(-1)).toMatchObject({ ids: [m1] });
  await expect(pinMessage(a, chat, m2)).rejects.toMatchObject({ code: 'not_found' });
});
