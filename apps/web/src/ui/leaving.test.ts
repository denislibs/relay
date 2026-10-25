import { expect, test } from 'bun:test';
import { flipDeltas, interiorRemovals, mergeLeaving } from './leaving';

const m = (key: string, sort: number, extra: Record<string, unknown> = {}) => ({ key, sort, ...extra });
const win = (...sorts: number[]) => sorts.map((s) => m('k' + s, s));

test('interior removal: a message gone from the middle of the same window', () => {
  expect(interiorRemovals(win(1, 2, 3, 4), win(1, 2, 4)).map((x) => x.key)).toEqual(['k3']);
  expect(interiorRemovals(win(1, 2, 3, 4, 5), win(1, 4, 5)).map((x) => x.key)).toEqual(['k2', 'k3']);   // два сразу
});

test('window edges are not deletions: trimmed or shifted windows produce nothing', () => {
  expect(interiorRemovals(win(1, 2, 3, 4), win(2, 3, 4))).toEqual([]);          // подрезали сверху
  expect(interiorRemovals(win(1, 2, 3, 4), win(1, 2, 3))).toEqual([]);          // подрезали снизу
  expect(interiorRemovals(win(1, 2, 3, 4), win(3, 4, 5, 6))).toEqual([]);       // сдвинули
  expect(interiorRemovals(win(1, 2, 3), win(10, 11, 12))).toEqual([]);          // окно сменилось целиком
  expect(interiorRemovals(null, win(1, 2))).toEqual([]);
  expect(interiorRemovals(win(1, 2), [])).toEqual([]);
});

test('a photo of an album that is still there, service rows and already-deleted rows are not animated', () => {
  const prev = [m('a', 1), m('p1', 2, { groupId: 'g' }), m('p2', 3, { groupId: 'g' }), m('s', 4, { service: { type: 'x' } }), m('d', 5, { deleted: true }), m('z', 6)];
  const next = [m('a', 1), m('p2', 3, { groupId: 'g' }), m('z', 6)];
  expect(interiorRemovals(prev, next)).toEqual([]);
  // альбом удалили целиком — обе строки уходят
  const next2 = [m('a', 1), m('z', 6)];
  expect(interiorRemovals(prev, next2).map((x) => x.key)).toEqual(['p1', 'p2']);
});

test('mergeLeaving puts leaving rows back by sort, including after the last one', () => {
  const next = win(1, 2, 5);
  expect(mergeLeaving(next, [m('k4', 4), m('k3', 3)]).map((x) => x.key)).toEqual(['k1', 'k2', 'k3', 'k4', 'k5']);
  expect(mergeLeaving(next, [m('k9', 9)]).map((x) => x.key)).toEqual(['k1', 'k2', 'k5', 'k9']);
  expect(mergeLeaving(next, [])).toBe(next);   // нечего вставлять — тот же массив (memo строк не ломается)
});

test('flipDeltas: was − now for rows present in both layouts, ignoring sub-pixel noise', () => {
  const first = new Map([['a', 100], ['b', 200], ['c', 300]]);
  const last = new Map([['a', 100.4], ['b', 150], ['d', 400]]);
  expect(flipDeltas(first, last)).toEqual([['b', 50]]);
});
