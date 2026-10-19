import { beforeEach, expect, test } from 'bun:test';
import { createChat, deleteDirectChat, getHistory, listChats, listChatsPage } from '../src/domain/chats';
import { sendMessage } from '../src/domain/messages';
import { markRead } from '../src/domain/reads';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const send = (u: number, chat: number, body: string) => sendMessage(u, { chatId: chat, clientId: crypto.randomUUID(), body }).then((r) => r.message.id);

test('chat list: newest first, last message and unread from others only', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  const ab = await makeChat([a, b]), ac = await makeChat([a, c]);
  await send(b, ab, 'b1');
  await send(b, ab, 'b2');
  await send(a, ab, 'мой');
  await send(c, ac, 'c1');
  const list = await listChats(a);
  expect(list.map((x) => x.id)).toEqual([ac, ab]);
  expect(list[0]).toMatchObject({ unread: 1, last: { body: 'c1' } });
  expect(list[1]).toMatchObject({ unread: 2, last: { body: 'мой' } });
});

test('unread drops after markRead', async () => {
  const a = await makeUser(), b = await makeUser();
  const ab = await makeChat([a, b]);
  const m = await send(b, ab, 'x');
  await markRead(a, ab, m);
  expect((await listChats(a))[0]).toMatchObject({ unread: 0, lastReadId: m });
});

test('history pages backwards and returns ascending ids', async () => {
  const a = await makeUser(), b = await makeUser();
  const ab = await makeChat([a, b]);
  const ids: number[] = [];
  for (let i = 1; i <= 5; i++) ids.push(await send(a, ab, String(i)));
  const page1 = await getHistory(b, ab, null, 2);
  expect(page1.messages.map((m) => m.id)).toEqual([ids[3], ids[4]]);
  expect(page1.hasMore).toBe(true);
  const page2 = await getHistory(b, ab, ids[3], 10);
  expect(page2.messages.map((m) => m.id)).toEqual([ids[0], ids[1], ids[2]]);
  expect(page2.hasMore).toBe(false);
});

test('history pages forward with after: ascending, hasMore, members only, hidden history stays hidden', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const ab = await makeChat([a, b]);
  const ids: number[] = [];
  for (let i = 1; i <= 5; i++) ids.push(await send(a, ab, String(i)));
  const up1 = await getHistory(b, ab, null, 2, ids[0]);
  expect(up1.messages.map((m) => m.id)).toEqual([ids[1], ids[2]]);
  expect(up1.hasMore).toBe(true);
  const up2 = await getHistory(b, ab, null, 10, ids[2]);
  expect(up2.messages.map((m) => m.id)).toEqual([ids[3], ids[4]]);
  expect(up2.hasMore).toBe(false);
  await expect(getHistory(c, ab, null, 10, ids[0])).rejects.toMatchObject({ code: 'not_member' });
  // «удалить чат у себя»: старое не возвращается и при листании вперёд
  await deleteDirectChat(b, ab, false);
  const fresh = await send(a, ab, 'после');
  expect((await getHistory(b, ab, null, 10, 1)).messages.map((m) => m.id)).toEqual([fresh]);
});

test('history is members only', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const ab = await makeChat([a, b]);
  await expect(getHistory(c, ab, null, 10)).rejects.toMatchObject({ code: 'not_member' });
});

test('direct chats carry the peer so the client can show a name', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const ab = await makeChat([a, b]);
  expect((await listChats(a))[0]).toMatchObject({ id: ab, peer: { id: b, name: 'Борис' } });
  expect((await listChats(b))[0]).toMatchObject({ peer: { id: a, name: 'Анна' } });
});

test('chat list carries how far the others have read my messages', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const m = (await sendMessage(a, { chatId: ab, clientId: crypto.randomUUID(), body: 'x' })).message.id;
  expect((await listChats(a))[0].peerReadUpTo).toBe(0);
  await markRead(b, ab, m);
  expect((await listChats(a))[0].peerReadUpTo).toBe(m);
});

test('dialogs come in pages by last activity with a cursor; filters by ids and unread', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    const id = await createChat('direct', null, [a, b]);
    ids.push(id);
    await sendMessage(b, { chatId: id, clientId: crypto.randomUUID(), body: 'm' + i });   // позже созданный — свежее
  }
  const p1 = await listChatsPage(a, 2);
  expect(p1.chats.map((c) => c.id)).toEqual([ids[4], ids[3]]);
  const p2 = await listChatsPage(a, 2, p1.next!);
  expect(p2.chats.map((c) => c.id)).toEqual([ids[2], ids[1]]);
  const p3 = await listChatsPage(a, 2, p2.next!);
  expect(p3.chats.map((c) => c.id)).toEqual([ids[0]]);
  expect(p3.next).toBeNull();
  expect((await listChats(a, { ids: [ids[1], ids[3]] })).map((c) => c.id).sort()).toEqual([ids[1], ids[3]].sort());
  await markRead(a, ids[2], (await listChats(a, { ids: [ids[2]] }))[0].last!.id);
  expect((await listChats(a, { unreadOnly: true })).map((c) => c.id)).not.toContain(ids[2]);
  expect((await listChats(a, { unreadOnly: true })).length).toBe(4);
});
