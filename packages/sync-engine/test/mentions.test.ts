import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sql } from '../../../apps/server/src/db';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { markRead } from '../../../apps/server/src/domain/reads';
import { openDb } from '../src/idb';
import { Store } from '../src/store';
import { Engine } from '../src/engine';
import { msg } from './fixtures';
import { resetDb, startTestServer, watchInto } from './helpers';

const ME = 1, PEER = 2;
const store = async () => Store.open(await openDb('mentions-' + crypto.randomUUID()), ME);
const group = (s: Store, id: number) => s.applyChats([{ id, kind: 'group', title: 'Группа', lastReadId: 0, unread: 0, last: null }]);
const keys = (s: Store) => s.notifications.map((n) => [n.key, n.mention]);

test('mention: +1 and the id queue (sorted, unique); a mention of an already read place is ignored; nextMention is the oldest', async () => {
  const s = await store();
  group(s, 7);
  s.applyUpdate({ type: 'mention', message: msg({ id: 20, chatId: 7, senderId: PEER }) });
  s.applyUpdate({ type: 'mention', message: msg({ id: 12, chatId: 7, senderId: PEER }) });
  s.applyUpdate({ type: 'mention', message: msg({ id: 20, chatId: 7, senderId: PEER }) });   // повтор журнала
  expect(s.chats.get(7)).toMatchObject({ mentions: 2, mentionIds: [12, 20] });
  expect(s.nextMention(7)).toEqual({ id: 12 });
  s.applyUpdate({ type: 'readOwn', chatId: 7, upToId: 15 });
  expect(s.chats.get(7)).toMatchObject({ mentions: 1, mentionIds: [20] });
  s.applyUpdate({ type: 'mention', message: msg({ id: 14, chatId: 7, senderId: PEER }) });   // уже прочитано — мимо
  expect(s.chats.get(7)!.mentions).toBe(1);
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 20 });
  expect(s.chats.get(7)!.mentions).toBe(0);
  expect(s.nextMention(7)).toBeNull();
});

test('readThread clears only that thread; readOwn of the main feed keeps thread mentions; the row count is the base', async () => {
  const s = await store();
  group(s, 7);
  s.applyUpdate({ type: 'mention', message: msg({ id: 10, chatId: 7, senderId: PEER }) });
  s.applyUpdate({ type: 'mention', message: msg({ id: 11, chatId: 7, senderId: PEER, threadId: 5 }), threadId: 5 });
  s.applyUpdate({ type: 'mention', message: msg({ id: 12, chatId: 7, senderId: PEER, threadId: 6 }), threadId: 6 });
  expect(s.nextMention(7)).toEqual({ id: 10 });
  s.applyUpdate({ type: 'readOwn', chatId: 7, upToId: 12 });
  expect(s.chats.get(7)).toMatchObject({ mentions: 2, mentionIds: [11, 12] });
  expect(s.nextMention(7)).toEqual({ id: 11, threadId: 5 });
  s.applyUpdate({ type: 'readThread', chatId: 7, threadId: 5, upToId: 11 });
  expect(s.chats.get(7)).toMatchObject({ mentions: 1, mentionIds: [12] });
  // строка списка — число сервера
  s.applyChats([{ id: 7, kind: 'group', title: 'Группа', lastReadId: 12, unread: 0, last: null, unreadMentions: 0 }]);
  expect(s.chats.get(7)!.mentions).toBe(0);
  expect(s.chats.get(7)!.mentionIds).toBeUndefined();
});

test('one notification per message: newMessage then mention, or mention then newMessage; own messages do not notify', async () => {
  const s = await store();
  group(s, 7);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 30, chatId: 7, senderId: PEER }) });
  s.applyUpdate({ type: 'mention', message: msg({ id: 30, chatId: 7, senderId: PEER }) });
  s.applyUpdate({ type: 'mention', message: msg({ id: 31, chatId: 7, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 31, chatId: 7, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 32, chatId: 7, senderId: ME }) });
  expect(keys(s)).toEqual([['n7:30', false], ['n7:31', true]]);
  expect(s.chats.get(7)!.mentions).toBe(2);   // упоминание считается, даже если уведомило сообщение
});

// ---- через сервер: журнал mention, строка списка, «кто прочитал» ----
const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });

test('engine: a mention from the server counts, shows in the chat row and notifications; reading clears it; readBy fetch', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  await sql`update users set username = 'boris_b' where id = ${b.userId}`;
  const g = await srv.chat(a.token, [a.userId, b.userId, (await srv.login('Вера')).userId]);
  const eb = await Engine.open(srv.config(b)); engines.push(eb);
  const ea = await Engine.open(srv.config(a)); engines.push(ea);
  eb.connect(); ea.connect(); await eb.whenIdle(); await ea.whenIdle();
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  const notes = watchInto(eb, { kind: 'notifications' });
  const m = (await sendMessage(a.userId, { chatId: g, clientId: crypto.randomUUID(), body: 'эй @Boris_B' })).message;
  await list.until((x) => x.find((c) => c.id === g)?.mentions === 1);
  const n = await notes.until((x) => x.length === 1);
  expect(n[0]).toMatchObject({ chatId: g, id: m.id, body: 'эй @Boris_B' });
  await eb.whenIdle();
  expect(notes.list().length).toBe(1);   // newMessage и mention — одно уведомление
  expect(await eb.call({ type: 'nextMention', chatId: g })).toEqual({ id: m.id });
  await eb.call({ type: 'seen', chatId: g, upToId: m.id });
  await list.until((x) => x.find((c) => c.id === g)?.mentions === 0);
  await eb.whenIdle();
  expect((await sql`select 1 from message_mentions where user_id = ${b.userId}`).length).toBe(0);
  // новое устройство: число — из строки списка
  const m2 = (await sendMessage(a.userId, { chatId: g, clientId: crypto.randomUUID(), body: 'и снова @boris_b' })).message;
  const eb2 = await Engine.open(srv.config(b)); engines.push(eb2);
  eb2.connect(); await eb2.whenIdle();
  expect(eb2.store.chats.get(g)!.mentions).toBe(1);
  // «кто прочитал»: автор — список, не автор — отказ
  await markRead(b.userId, g, m2.id);
  expect(await ea.call({ type: 'readBy', chatId: g, id: m2.id })).toEqual({ ok: true, data: [{ id: b.userId, name: 'Борис' }] });
  expect(await eb.call({ type: 'readBy', chatId: g, id: m2.id })).toEqual({ ok: false, code: 'forbidden' });
});
