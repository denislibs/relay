import { describe, expect, test } from 'bun:test';
import { dragRangeIds } from './chatSelectDrag';

const ids = [10, 11, 12, 13, 14, 15];

describe('dragRangeIds', () => {
  test('добавляет диапазон вниз и вверх', () => {
    expect(dragRangeIds(ids, 1, 3, [], true)).toEqual([11, 12, 13]);
    expect(dragRangeIds(ids, 3, 1, [], true)).toEqual([11, 12, 13]);
  });
  test('добавление не дублирует уже выбранные и сохраняет прочие', () => {
    expect(dragRangeIds(ids, 0, 1, [11, 15], true)).toEqual([11, 15, 10]);
  });
  test('снимает диапазон, остальные остаются', () => {
    expect(dragRangeIds(ids, 1, 2, [10, 11, 12, 13], false)).toEqual([10, 13]);
  });
  test('снятие всего даёт пустой набор', () => {
    expect(dragRangeIds(ids, 0, 5, ids, false)).toEqual([]);
  });
  test('курсор вернулся к началу — только стартовая строка', () => {
    expect(dragRangeIds(ids, 2, 2, [], true)).toEqual([12]);
  });
});
