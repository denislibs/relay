import { expect, test } from 'bun:test';
import { pushRecent, RECENT_MAX } from './recent';

test('a new pick goes on top, repeats move up, the list keeps the last five', () => {
  expect(pushRecent([], 'a')).toEqual(['a']);
  expect(pushRecent(['a', 'b'], 'b')).toEqual(['b', 'a']);
  expect(pushRecent(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['f', 'a', 'b', 'c', 'd']);
  expect(RECENT_MAX).toBe(5);
});
