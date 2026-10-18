import { expect, test } from 'bun:test';
import { flushOwn, key, PREFIX, valkey } from '../src/valkey';

test('keys carry the test prefix; flushOwn removes only them', async () => {
  expect(PREFIX).toBe('relay_test:');
  await valkey().set(key('probe'), '1');
  await valkey().set('foreign:probe', '1');
  await flushOwn();
  expect(await valkey().get(key('probe'))).toBeNull();
  expect(await valkey().get('foreign:probe')).toBe('1');
  await valkey().del('foreign:probe');
});
