import { expect, test } from 'bun:test';
import { dbRowsLabel, formatBytes, MEDIA_CACHE, within } from './storageInfo';

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
test('dbRowsLabel', () => {
  expect(dbRowsLabel(undefined)).toBeUndefined();
  expect(dbRowsLabel({ messages: 1, chats: 1 })).toBe('1 сообщение в 1 чате');
  expect(dbRowsLabel({ messages: 3, chats: 12 })).toBe('3 сообщения в 12 чатах');
  expect(dbRowsLabel({ messages: 0, chats: 0 })).toBe('0 сообщений в 0 чатах');
});

test('within: the answer if in time, undefined on timeout or failure', async () => {
  expect(await within(Promise.resolve(5), 50)).toBe(5);
  expect(await within(new Promise(() => {}), 20)).toBeUndefined();
  expect(await within(Promise.reject(new Error('x')), 50)).toBeUndefined();
});
