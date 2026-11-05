import { expect, test } from 'bun:test';
import { keyedNext, keyedValue } from './keyedState';

const cache = new Map<number, string>([[1, 'чат 1'], [2, 'чат 2']]);
const read = (k: number) => cache.get(k) ?? 'загрузка';

test('after the key changes the previous key value is never returned', () => {
  const st = { key: 1, v: 'чат 1 свежий' };
  expect(keyedValue(st, 1, read)).toBe('чат 1 свежий');
  expect(keyedValue(st, 2, read)).toBe('чат 2');       // кэш нового чата, а не «чат 1 свежий»
  expect(keyedValue(st, 3, read)).toBe('загрузка');    // кэша нет — загрузка
});

test('updates land under the current key and see that key value', () => {
  const st = { key: 1, v: 'чат 1' };
  expect(keyedNext(st, 1, read, 'x')).toEqual({ key: 1, v: 'x' });
  expect(keyedNext(st, 2, read, (p) => p + '+')).toEqual({ key: 2, v: 'чат 2+' });
});
