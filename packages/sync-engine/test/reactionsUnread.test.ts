import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { reactMessage } from '../../../apps/server/src/domain/messageOps';
import { Engine } from '../src/engine';
import { openDb } from '../src/idb';
import { computeQuery } from '../src/queries';
import { Store } from '../src/store';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };

// непрочитанные реакции на мои сообщения в движке: число — строки списка, id — журналом reaction; reactionsRead
// гасит (ids или все); удаление сообщения тоже; nextReaction — самая старая известная

const ME = 1;
const store = async () => Store.open(await openDb('ur-' + crypto.randomUUID()), ME);
const group = (s: Store, id: number, unreadReactions = 0) => s.applyChats([{ id, kind: 'group', title: 'Группа', lastReadId: 0, unread: 0, last: null, unreadReactions }]);
const row = (s: Store, id: number) => computeQuery(s, { kind: 'chatList', limit: 50 }).items.get('c' + id) as { reactions: number; reactionIds: number[] | null };

test('reaction: +1 and sorted unique ids; reactionsRead by ids and all; a deleted message drops its id', async () => {
  const s = await store();
  group(s, 7);
  s.applyUpdate({ type: 'reaction', chatId: 7, id: 20 });
  s.applyUpdate({ type: 'reaction', chatId: 7, id: 12 });
  s.applyUpdate({ type: 'reaction', chatId: 7, id: 20 });   // повтор журнала
  expect(s.chats.get(7)).toMatchObject({ reactions: 2, reactionIds: [12, 20] });
  expect(s.nextReaction(7)).toBe(12);
  expect(row(s, 7)).toMatchObject({ reactions: 2, reactionIds: [12, 20] });
  s.applyUpdate({ type: 'reactionsRead', chatId: 7, ids: [12] });
  expect(s.chats.get(7)).toMatchObject({ reactions: 1, reactionIds: [20] });
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 20 });
  expect(s.chats.get(7)!.reactions).toBe(0);
  expect(s.nextReaction(7)).toBeNull();
  s.applyUpdate({ type: 'reaction', chatId: 7, id: 30 });
  s.applyUpdate({ type: 'reaction', chatId: 7, id: 31 });
  s.applyUpdate({ type: 'reactionsRead', chatId: 7 });   // все
  expect(row(s, 7)).toMatchObject({ reactions: 0, reactionIds: null });
});

test('the list row brings the count; ids come later from the server and the count never drops below them', async () => {
  const s = await store();
  group(s, 7, 3);
  expect(s.chats.get(7)).toMatchObject({ reactions: 3 });
  expect(s.nextReaction(7)).toBeNull();   // число есть, id нет — спросить сервер
  s.setReactionIds(7, [40, 35], 3);
  expect(s.chats.get(7)).toMatchObject({ reactions: 3, reactionIds: [35, 40] });
  expect(s.nextReaction(7)).toBeNull();   // сервер отдал не все id (их 3) — спросить снова
  s.setReactionIds(7, [40, 35], 2);
  expect(s.nextReaction(7)).toBe(35);
  s.applyUpdate({ type: 'reactionsRead', chatId: 7, ids: [35] });
  expect(s.chats.get(7)).toMatchObject({ reactions: 1, reactionIds: [40] });
  expect(s.nextReaction(7)).toBe(40);
  group(s, 7, 2);   // строка списка: стало два, второй id не знаем
  expect(s.nextReaction(7)).toBeNull();   // знаем не все id — у сервера точнее
  s.applyUpdate({ type: 'reactionsRead', chatId: 7, ids: [41] });   // сервер снял то, что знали только числом
  expect(s.chats.get(7)).toMatchObject({ reactions: 1, reactionIds: [40] });
  expect(s.nextReaction(7)).toBe(40);
  group(s, 7, 0);   // строка списка: всё прочитано
  expect(s.chats.get(7)).toMatchObject({ reactions: 0 });
  expect(s.chats.get(7)!.reactionIds).toBeUndefined();
});

test('count without ids: a journal echo for a counted message does not double; a deleted message does not touch the count', async () => {
  const s = await store();
  group(s, 7, 2);
  s.applyUpdate({ type: 'reaction', chatId: 7, id: 5 });   // одно из двух — теперь известно
  expect(s.chats.get(7)).toMatchObject({ reactions: 2, reactionIds: [5] });
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 9 });   // было ли у 9 — не знаем: число не трогаем
  expect(s.chats.get(7)!.reactions).toBe(2);
  s.applyUpdate({ type: 'reactionsRead', chatId: 7, ids: [9] });   // сервер сказал — было
  expect(s.chats.get(7)).toMatchObject({ reactions: 1, reactionIds: [5] });
});

test('end to end: the list row brings the count, nextReaction fetches the ids, readReactions clears on the server too', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const { message } = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'моё' });
  await reactMessage(b.userId, chatId, message.id, '❤');
  const e = await open(srv.config(a));
  e.connect();
  await e.whenIdle();
  const list = watchInto(e, { kind: 'chatList', limit: 50 });
  await list.until((l) => l.find((c: any) => c.id === chatId)?.reactions === 1);
  expect(await e.call({ type: 'nextReaction', chatId })).toBe(message.id);   // id спросили у сервера
  await e.call({ type: 'readReactions', chatId, ids: [message.id] });
  await list.until((l) => l.find((c: any) => c.id === chatId)?.reactions === 0);
  await e.whenIdle();
  expect(await srv.unreadReactions(a.token, chatId)).toEqual({ ids: [], count: 0 });
});
