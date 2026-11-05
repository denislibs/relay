import { expect, test } from 'bun:test';
import { checkSchedule, maxScheduleDay, nextSlot, quickOptions, scheduledDay, scheduledFailText, scheduledTitle, scheduledToast, submitLabel, whenText, withClock } from './schedule';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('nextSlot: the next half hour, at least ten minutes ahead', () => {
  expect(nextSlot(at(2026, 11, 4, 15, 2))).toBe(at(2026, 11, 4, 15, 30));
  expect(nextSlot(at(2026, 11, 4, 15, 25))).toBe(at(2026, 11, 4, 16, 0));
  expect(nextSlot(at(2026, 11, 4, 15, 20))).toBe(at(2026, 11, 4, 15, 30));
  expect(nextSlot(at(2026, 11, 4, 23, 55))).toBe(at(2026, 11, 5, 0, 30));
});

test('quickOptions: today while the day lasts, tomorrow at nine', () => {
  expect(quickOptions(at(2026, 11, 4, 15, 2))).toEqual([{ label: 'Сегодня в 15:30', at: at(2026, 11, 4, 15, 30) }, { label: 'Завтра в 09:00', at: at(2026, 11, 5, 9) }]);
  // вечером сегодняшнего варианта нет
  expect(quickOptions(at(2026, 11, 4, 23, 55)).map((o) => o.label)).toEqual(['Завтра в 09:00']);
  // конец месяца и года
  expect(quickOptions(at(2026, 12, 31, 12))[1].at).toBe(at(2027, 1, 1, 9));
});

test('checkSchedule: the past and more than a year ahead are refused', () => {
  const now = at(2026, 11, 4, 12);
  expect(checkSchedule(now - 1, now)).toBe('past');
  expect(checkSchedule(now, now)).toBe('past');
  expect(checkSchedule(NaN, now)).toBe('past');
  expect(checkSchedule(now + 60_000, now)).toBe(null);
  expect(checkSchedule(now + 365 * 86400_000, now)).toBe(null);
  expect(checkSchedule(now + 365 * 86400_000 + 1, now)).toBe('far');
  expect(maxScheduleDay(now).getTime()).toBe(now + 365 * 86400_000);
});

test('words: today, tomorrow, a date, another year; the Saved chat reminds', () => {
  const now = at(2026, 11, 4, 12);
  expect(whenText(at(2026, 11, 4, 15, 30), now)).toBe('сегодня в 15:30');
  expect(whenText(at(2026, 11, 5, 9), now)).toBe('завтра в 09:00');
  expect(whenText(at(2026, 12, 20, 10), now)).toBe('20 декабря в 10:00');
  expect(whenText(at(2027, 2, 1, 10), now)).toBe('1 февраля 2027 г. в 10:00');
  expect(submitLabel(at(2026, 11, 4, 15, 30), now, false)).toBe('Отправить сегодня в 15:30');
  expect(submitLabel(at(2026, 11, 5, 9), now, true)).toBe('Напомнить завтра в 09:00');
  expect(scheduledToast(at(2026, 11, 5, 9), now, false)).toBe('Сообщение будет отправлено завтра в 09:00');
  expect(scheduledToast(at(2026, 11, 5, 9), now, true)).toBe('Напоминание придёт завтра в 09:00');
  expect(scheduledTitle(false)).toBe('Отложенные сообщения');
  expect(scheduledTitle(true)).toBe('Напоминания');
});

test('list days: today, tomorrow, then dates', () => {
  const now = at(2026, 11, 4, 12), iso = (t: number) => new Date(t).toISOString();
  expect(scheduledDay(iso(at(2026, 11, 4, 23)), now)).toBe('Сегодня');
  expect(scheduledDay(iso(at(2026, 11, 5, 1)), now)).toBe('Завтра');
  expect(scheduledDay(iso(at(2026, 11, 20, 1)), now)).toBe('20 ноября');
});

test('withClock puts the time on the chosen day', () => {
  expect(withClock(new Date(2026, 10, 7), '09:05')).toBe(at(2026, 11, 7, 9, 5));
});

test('failure reasons are readable; the unknown is still honest', () => {
  expect(scheduledFailText('blocked')).toContain('ограничил');
  expect(scheduledFailText('whatever')).toBe('Не отправлено');
});
