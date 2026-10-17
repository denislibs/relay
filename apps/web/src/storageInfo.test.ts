import { expect, test } from 'bun:test';
import { formatBytes, MEDIA_CACHE } from './storageInfo';

test('formatBytes', () => {
  expect(formatBytes(0)).toBe('0 Б');
  expect(formatBytes(512)).toBe('512 Б');
  expect(formatBytes(2048)).toBe('2 КБ');
  expect(formatBytes(5.5 * 1024 * 1024)).toBe('5,5 МБ');
  expect(formatBytes(3 * 1024 ** 3)).toBe('3 ГБ');
});
test('only media caches match', () => {
  expect(MEDIA_CACHE.test('relay-media-v1')).toBe(true);
  expect(MEDIA_CACHE.test('relay-shell-abc')).toBe(false);
});
