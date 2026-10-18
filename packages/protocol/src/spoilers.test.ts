import { expect, test } from 'bun:test';
import { hideSpoilers, SPOILER_FILL } from './index';

test('spoiler ranges become filler, spaces and other text stay', () => {
  const out = hideSpoilers('пароль: 12 34, ок', [{ type: 'spoiler', offset: 8, length: 5 }, { type: 'bold', offset: 0, length: 6 }]);
  expect(out.slice(0, 8)).toBe('пароль: ');
  expect(out.slice(13)).toBe(', ок');
  expect(out[10]).toBe(' ');
  expect([...out.slice(8, 13)].every((c) => c === ' ' || SPOILER_FILL.includes(c))).toBe(true);
  expect(out).not.toContain('12');
});

test('offsets are UTF-16 units: an emoji before the spoiler does not shift it', () => {
  const text = '😀 тайна!';   // 😀 — две единицы UTF-16
  const out = hideSpoilers(text, [{ type: 'spoiler', offset: 3, length: 5 }]);
  expect(out.startsWith('😀 ')).toBe(true);
  expect(out.endsWith('!')).toBe(true);
  expect(out).not.toContain('тайна');
});

test('no spoilers — same string', () => {
  expect(hideSpoilers('x', null)).toBe('x');
  expect(hideSpoilers('x', [{ type: 'bold', offset: 0, length: 1 }])).toBe('x');
});
