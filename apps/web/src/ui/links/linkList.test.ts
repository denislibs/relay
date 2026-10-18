import { expect, test } from 'bun:test';
import { dropIndex, moveLink, putLink, shiftFor } from './linkList';

const L = (h: string) => ({ service: 'github' as const, handle: h });

test('move and drop index', () => {
  expect(moveLink([L('a'), L('b'), L('c')], 0, 2).map((l) => l.handle)).toEqual(['b', 'c', 'a']);
  expect(moveLink([L('a'), L('b'), L('c')], 2, 0).map((l) => l.handle)).toEqual(['c', 'a', 'b']);
  expect(dropIndex(0, 130, 64, 3)).toBe(2);
  expect(dropIndex(1, -500, 64, 3)).toBe(0);
  expect([0, 1, 2, 3].map((i) => shiftFor(i, 0, 2))).toEqual([0, -1, -1, 0]);
  expect([0, 1, 2, 3].map((i) => shiftFor(i, 3, 1))).toEqual([0, 1, 1, 0]);
});

test('put: new goes last, edit stays in place, duplicates collapse', () => {
  expect(putLink([L('a')], null, L('b')).map((l) => l.handle)).toEqual(['a', 'b']);
  expect(putLink([L('a'), L('b')], null, L('A')).map((l) => l.handle)).toEqual(['b', 'A']);
  expect(putLink([L('a'), L('b'), L('c')], 1, L('x')).map((l) => l.handle)).toEqual(['a', 'x', 'c']);
  expect(putLink([L('a'), L('b'), L('c')], 1, L('c')).map((l) => l.handle)).toEqual(['a', 'c']);
});
