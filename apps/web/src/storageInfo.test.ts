import { expect, test } from 'bun:test';
import { formatBytes } from './storageInfo';

test('formatBytes', () => {
  expect(formatBytes(0)).toBe('0 Б');
  expect(formatBytes(512)).toBe('512 Б');
  expect(formatBytes(2048)).toBe('2 КБ');
  expect(formatBytes(5.5 * 1024 * 1024)).toBe('5,5 МБ');
  expect(formatBytes(3 * 1024 ** 3)).toBe('3 ГБ');
});
