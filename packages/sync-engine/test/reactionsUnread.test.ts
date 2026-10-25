import { expect, test } from 'bun:test';
import { openDb } from '../src/idb';
import { computeQuery } from '../src/queries';
import { Store } from '../src/store';

// непрочитанные реакции на мои сообщения в движке: число — строки списка, id — журналом reaction; reactionsRead
// гасит (ids или все); удаление сообщения тоже; nextReaction — самая старая известная

const ME = 1;
const store = async () => Store.open(await openDb('ur-' + crypto.randomUUID()), ME);
const group = (s: Store, id: number, unreadReactions = 0) => s.applyChats([{ id, kind: 'group', title: 'Группа', lastReadId: 0, unread: 0, last: null, unreadReactions }]);
const row = (s: Store, id: number) => computeQuery(s, { kind: 'chatList', limit: 50 }).items.get(String(id)) as { reactions: number; reactionIds: number[] | null };

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
  expect(s.nextReaction(7)).toBe(35);
  s.applyUpdate({ type: 'reactionsRead', chatId: 7, ids: [35] });
  expect(s.chats.get(7)).toMatchObject({ reactions: 2, reactionIds: [40] });   // один известный + один только числом
  group(s, 7, 0);   // строка списка: всё прочитано
  expect(s.chats.get(7)).toMatchObject({ reactions: 0 });
  expect(s.chats.get(7)!.reactionIds).toBeUndefined();
});
