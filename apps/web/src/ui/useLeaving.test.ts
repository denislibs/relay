import { expect, test } from 'bun:test';
import { mergeLeaving, type Leaving } from './useLeaving';

const id = (s: string) => s;
const rows = (xs: string[]) => xs.map((k) => ({ item: k, key: k }));
const view = (r: { key: string; leaving: boolean }[]) => r.map((x) => (x.leaving ? '-' + x.key : x.key));

test('a removed row stays right after its old upper neighbour', () => {
  const l: Leaving<string> = new Map();
  expect(view(mergeLeaving(rows(['a', 'b', 'c']), ['a', 'c'], id, l))).toEqual(['a', '-b', 'c']);
});

test('the first row leaves at the top, the last one at the bottom', () => {
  expect(view(mergeLeaving(rows(['a', 'b', 'c']), ['b', 'c'], id, new Map()))).toEqual(['-a', 'b', 'c']);
  expect(view(mergeLeaving(rows(['a', 'b', 'c']), ['a', 'b'], id, new Map()))).toEqual(['a', 'b', '-c']);
});

test('neighbour gone too (all others terminated): rows keep their order', () => {
  const l: Leaving<string> = new Map();
  expect(view(mergeLeaving(rows(['a', 'b', 'c']), ['a'], id, l))).toEqual(['a', '-b', '-c']);
  expect(view(mergeLeaving(rows(['a', 'b', 'c']), [], id, new Map()))).toEqual(['-a', '-b', '-c']);
});

test('a row that comes back is no longer leaving; without animation nothing lingers', () => {
  const l: Leaving<string> = new Map();
  mergeLeaving(rows(['a', 'b']), ['a'], id, l);
  expect(view(mergeLeaving(rows(['a']), ['a', 'b'], id, l))).toEqual(['a', 'b']);
  expect(l.size).toBe(0);
  expect(view(mergeLeaving(rows(['a', 'b']), ['a'], id, new Map(), false))).toEqual(['a']);
});
