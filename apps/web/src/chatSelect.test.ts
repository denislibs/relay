import { test, expect, beforeEach } from 'bun:test';
import { setGlobal, getGlobal } from './global';
import { bindChatFlags, pinMany } from './chatFlags';
import { endChatSelect, inListOrder, pinRoom, pruneChatSelect, selectionActions, setChatSelectIds, startChatSelect, stateOf, toggleChatSelect, type SelState } from './chatSelect';

const S = (o: Partial<SelState> = {}): SelState => ({ pinned: false, unread: false, muted: false, archived: false, system: false, owner: false, ...o });
test('пусто — ничего не предлагаем', () => { expect(selectionActions([])).toEqual({}); });
test('закрепить, пока хоть один не закреплён', () => {
  expect(selectionActions([S({ pinned: true }), S()]).pin).toBe(true);
  expect(selectionActions([S({ pinned: true }), S({ pinned: true })]).pin).toBe(false);
});
test('один без звука — включить звук всем', () => {
  expect(selectionActions([S({ muted: true }), S()]).mute).toBe(false);
  expect(selectionActions([S(), S()]).mute).toBe(true);
});
test('один в архиве — вернуть всех; системный — архива нет', () => {
  expect(selectionActions([S({ archived: true }), S()]).archive).toBe(false);
  expect(selectionActions([S(), S()]).archive).toBe(true);
  expect(selectionActions([S({ system: true }), S()]).archive).toBeUndefined();
});
test('прочитать, если есть непрочитанный; иначе отметить непрочитанными', () => {
  expect(selectionActions([S({ unread: true }), S()]).read).toBe(true);
  expect(selectionActions([S(), S()]).read).toBe(false);
});
test('удалить — не для системного и не для своей группы', () => {
  expect(selectionActions([S(), S()]).delete).toBe(true);
  expect(selectionActions([S({ owner: true }), S()]).delete).toBeUndefined();
  expect(selectionActions([S({ system: true })]).delete).toBeUndefined();
});
test('stateOf: владелец группы, отметка непрочитанного', () => {
  const s = stateOf({ id: 1, kind: 'group', me: { role: 'owner' }, unread: 0, unreadMark: true, pinnedAt: 5 });
  expect(s).toMatchObject({ owner: true, unread: true, pinned: true, archived: false, system: false });
});

beforeEach(() => setGlobal({ chatSelect: null }));
test('отметка, снятие, выход на последней', () => {
  startChatSelect('main', 3);
  toggleChatSelect(7);
  expect(getGlobal().chatSelect).toEqual({ list: 'main', ids: [3, 7] });
  toggleChatSelect(3); toggleChatSelect(7);
  expect(getGlobal().chatSelect).toBeNull();
});
test('протяжка задаёт набор целиком; пустой — выход', () => {
  startChatSelect('archive', 1);
  setChatSelectIds([1, 2, 3]);
  expect(getGlobal().chatSelect?.ids).toEqual([1, 2, 3]);
  setChatSelectIds([]);
  expect(getGlobal().chatSelect).toBeNull();
});
test('пропавшие из списка выпадают', () => {
  startChatSelect('main', 1); toggleChatSelect(2);
  pruneChatSelect((id) => id !== 2);
  expect(getGlobal().chatSelect?.ids).toEqual([1]);
  pruneChatSelect(() => false);
  expect(getGlobal().chatSelect).toBeNull();
  endChatSelect();
});
test('порядок — как в списке', () => {
  expect(inListOrder([9, 1, 5], [{ id: 1 }, { id: 5 }, { id: 9 }])).toEqual([1, 5, 9]);
});
test('лимит закреплённых — по своему списку', () => {
  const chats = [1, 2, 3, 4].map((id) => ({ id, pinnedAt: id })).concat([{ id: 10 }, { id: 11 }, { id: 12, archived: true, pinnedAt: 1 }] as never);
  expect(pinRoom([10], chats)).toBe(true);        // 4 + 1 = 5
  expect(pinRoom([10, 11], chats)).toBe(false);   // 4 + 2 > 5
});

test('pinMany: лимит — один тост, на сервер ничего', async () => {
  const sent: number[] = [];
  bindChatFlags(async (id) => { sent.push(id); });
  setGlobal({ chats: [1, 2, 3, 4].map((id) => ({ id, pinnedAt: id })).concat([{ id: 10 }, { id: 11 }] as never) as never });
  expect(pinMany([10, 11], true)).toBe(false);
  expect(sent).toEqual([]);
  expect(pinMany([10], true)).toBe(true);
  expect(sent).toEqual([10]);
});
test('pinMany: снизу вверх — верхний окажется выше (позже закреплён — выше)', () => {
  const sent: number[] = [];
  bindChatFlags(async (id) => { sent.push(id); });
  setGlobal({ chats: [{ id: 1 }, { id: 2 }, { id: 3 }] as never });
  pinMany([1, 3], true);
  expect(sent).toEqual([3, 1]);
});
