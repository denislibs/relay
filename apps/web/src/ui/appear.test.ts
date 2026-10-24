import { expect, test } from 'bun:test';
import { arrivals, type FeedSeen } from './appear';

const rows = (...keys: string[]) => keys.map((key) => ({ key }));
const step = (prev: FeedSeen | null, keys: string[], live = true) => arrivals(prev, rows(...keys), live);

test('first window: nothing animates', () => {
  expect(step(null, ['a', 'b', 'c']).fresh).toEqual([]);
});

test('live feed: a new message at the bottom animates, the oldest dropped from the window does not matter', () => {
  const s = step(null, ['a', 'b', 'c']).seen;
  expect(step(s, ['b', 'c', 'd']).fresh).toEqual(['d']);
});

test('an incoming message inserted above an own pending one animates too', () => {
  const s = step(null, ['a', 'b', 'pending']).seen;
  expect(step(s, ['a', 'b', 'in', 'pending']).fresh).toEqual(['in']);
});

test('history above the window (window shift older, top-up while opening) appears without animation', () => {
  const s = step(null, ['c', 'd', 'e']).seen;
  expect(step(s, ['a', 'b', 'c', 'd', 'e']).fresh).toEqual([]);
  const old = step(null, ['c', 'd', 'e'], false).seen;
  expect(step(old, ['a', 'b', 'c', 'd'], false).fresh).toEqual([]);
});

test('window moved away from the live end or back to it: rows are history, not arrivals', () => {
  const s = step(null, ['a', 'b', 'c'], false).seen;
  expect(step(s, ['b', 'c', 'd', 'e'], true).fresh).toEqual([]);   // дошли до последних сдвигом вниз
  const l = step(null, ['d', 'e'], true).seen;
  expect(step(l, ['a', 'b', 'c'], false).fresh).toEqual([]);   // переход к сообщению в истории
});

test('a window replaced entirely (jump) shares no rows: nothing animates even at the live end', () => {
  const s = step(null, ['a', 'b'], true).seen;
  expect(step(s, ['x', 'y'], true).fresh).toEqual([]);
});
