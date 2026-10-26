import { test, expect } from 'bun:test';
import { articleTall } from './richview.js';

const p = (text) => ({ type: 'p', text });
test('короткая статья — ясно, что не сворачивать', () => {
  expect(articleTall([p('Привет'), p('Пара слов')])).toBe(false);
  expect(articleTall([])).toBe(false);
});
test('много абзацев — ясно, что сворачивать, без раскладки', () => {
  expect(articleTall(Array.from({ length: 40 }, (_, i) => p('абзац ' + i)))).toBe(true);
  expect(articleTall([{ type: 'code', text: Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n') }])).toBe(true);
  expect(articleTall([{ type: 'ul', items: Array.from({ length: 40 }, () => [p('пункт')]) }])).toBe(true);
});
test('середина — мерить', () => {
  expect(articleTall([p('a'.repeat(900))])).toBeNull();
  expect(articleTall([{ type: 'quote', blocks: [p('b'.repeat(700))] }, { type: 'hr' }])).toBeNull();
});
