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

test('sessionTime: today with time, yesterday, older as a date; fullDateTime', async () => {
  const { sessionTime, fullDateTime } = await import('./format');
  const now = new Date(2026, 9, 17, 18, 0);
  expect(sessionTime(new Date(2026, 9, 17, 14, 5).toISOString(), now, '24h')).toBe('сегодня в 14:05');
  expect(sessionTime(new Date(2026, 9, 16, 23, 59).toISOString(), now, '24h')).toBe('вчера');
  expect(sessionTime(new Date(2026, 9, 3, 9, 0).toISOString(), now, '24h')).toBe('03.10.26');
  expect(fullDateTime(new Date(2026, 9, 17, 14, 5).toISOString(), '24h')).toBe('17 октября 2026 в 14:05');
});
