import { expect, test } from 'bun:test';
import { cachedPinned, rememberPinned, settleWithin } from './pinnedCache';

test('pinned messages are cached per chat', () => {
  rememberPinned(7, [{ key: 'a', id: 10, body: 'привет' }]);
  expect(cachedPinned(7, 10)?.body).toBe('привет');
  expect(cachedPinned(8, 10)).toBeUndefined();
});

test('settleWithin waits for the promise but never longer than the limit, and never rejects', async () => {
  let t = performance.now();
  await settleWithin(new Promise((r) => setTimeout(r, 10)), 1000);
  expect(performance.now() - t).toBeLessThan(500);
  t = performance.now();
  await settleWithin(new Promise(() => {}), 30);
  expect(performance.now() - t).toBeGreaterThanOrEqual(25);
  await settleWithin(Promise.reject(new Error('нет сети')), 1000);
});
