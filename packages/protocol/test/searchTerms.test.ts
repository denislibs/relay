import { expect, test } from 'bun:test';
import { searchTerms } from '../src/index';

test('lowercases, folds ё, splits on non-letters, dedupes', () => {
  expect(searchTerms('Ёжик пришёл!')).toEqual(['ежик', 'пришел']);
  expect(searchTerms('Hello, hello WORLD 42 x')).toEqual(['hello', 'world', '42']);
});
test('length bounds 2..32', () => {
  expect(searchTerms('a bb ' + 'x'.repeat(32) + ' ' + 'y'.repeat(33))).toEqual(['bb', 'x'.repeat(32)]);
});
test('at most 64 terms', () => {
  const text = Array.from({ length: 200 }, (_, i) => 'w' + i).join(' ');
  expect(searchTerms(text)).toHaveLength(64);
});
