import { describe, expect, test } from 'bun:test';
import { groupReactions } from './reactionChips';

describe('groupReactions', () => {
  test('одна плашка на эмодзи в любой форме записи, порядок первого появления, кто поставил', () => {
    const chips = groupReactions({ reactions: [{ userId: 2, emoji: '👍' }, { userId: 3, emoji: '❤️' }, { userId: 1, emoji: '❤' }] }, 1);
    expect(chips.map((c) => [c.key, c.count, c.mine, c.who])).toEqual([['👍', 1, false, [2]], ['❤', 2, true, [3, 1]]]);
  });
  test('от четырёх реакций — без списка реакторов (вместо аватаров число)', () => {
    const chips = groupReactions({ reactions: [1, 2, 3, 4].map((userId) => ({ userId, emoji: '🔥' })) }, 9);
    expect(chips).toEqual([{ key: '🔥', emoji: '🔥', count: 4, mine: false }]);
  });
  test('пост канала — счётчики и моя по myReaction', () => {
    const chips = groupReactions({ reactionCounts: [['❤', 12], ['👍', 3]], myReaction: '👍' }, 1);
    expect(chips.map((c) => [c.key, c.count, c.mine])).toEqual([['❤', 12, false], ['👍', 3, true]]);
    expect(chips[0].who).toBeUndefined();
  });
  test('без реакций — пусто', () => { expect(groupReactions({}, 1)).toEqual([]); });
});
