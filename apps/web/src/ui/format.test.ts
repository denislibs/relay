import { expect, test } from 'bun:test';
import { chatTime, clock, hm } from './format';

const at = (h: number, m: number) => new Date(2026, 9, 17, h, m).toISOString();

test('clock: 12h and 24h with explicit format', () => {
  expect(clock(at(21, 5), '12h')).toBe('9:05 PM');
  expect(clock(at(21, 5), '24h')).toBe('21:05');
  expect(clock(at(0, 7), '12h')).toBe('12:07 AM');
  expect(clock(at(12, 0), '12h')).toBe('12:00 PM');
  expect(clock(at(9, 5), '24h')).toBe('09:05');
});

test('chatTime: today uses the format, other days do not', () => {
  const now = new Date(); now.setHours(21, 5, 0, 0);
  expect(chatTime(now.toISOString(), '12h')).toBe('9:05 PM');
  expect(chatTime(now.toISOString(), '24h')).toBe('21:05');
  expect(hm(new Date(2026, 0, 1, 15, 30), '12h')).toBe('3:30 PM');
});
