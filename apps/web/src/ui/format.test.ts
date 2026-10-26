import { expect, test } from 'bun:test';
import { chatTime, clock, dayLabel, hideCode, hm, isSystemChat, shownBody, snippet } from './format';

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

test('chatTime: weekday this week, short date this year, full date another year — no «Вчера»', () => {
  const now = new Date(2026, 9, 22, 12, 0);   // чт, 22 октября 2026
  expect(chatTime(new Date(2026, 9, 21, 9, 0).toISOString(), '24h', now).toLowerCase()).toBe('ср');
  expect(chatTime(new Date(2026, 9, 19, 9, 0).toISOString(), '24h', now).toLowerCase()).toBe('пн');
  expect(chatTime(new Date(2026, 9, 18, 9, 0).toISOString(), '24h', now)).toBe('18 окт');   // вс — прошлая неделя
  expect(chatTime(new Date(2026, 2, 3, 9, 0).toISOString(), '24h', now)).toBe('3 мар');
  expect(chatTime(new Date(2025, 11, 31, 9, 0).toISOString(), '24h', now)).toBe('31.12.2025');
  expect(chatTime(new Date(2026, 9, 22, 8, 7).toISOString(), '24h', now)).toBe('08:07');
});

test('sessionTime: today with time, yesterday, older as a date; fullDateTime', async () => {
  const { sessionTime, fullDateTime } = await import('./format');
  const now = new Date(2026, 9, 17, 18, 0);
  expect(sessionTime(new Date(2026, 9, 17, 14, 5).toISOString(), now, '24h')).toBe('сегодня в 14:05');
  expect(sessionTime(new Date(2026, 9, 16, 23, 59).toISOString(), now, '24h')).toBe('вчера');
  expect(sessionTime(new Date(2026, 9, 3, 9, 0).toISOString(), now, '24h')).toBe('03.10.26');
  expect(fullDateTime(new Date(2026, 9, 17, 14, 5).toISOString(), '24h')).toBe('17 октября 2026 в 14:05');
});

test('hideCode masks the first five-digit run only', () => {
  expect(hideCode('Код для входа в Relay: 48213\n\nНикому…')).toBe('Код для входа в Relay: •••••\n\nНикому…');
  expect(hideCode('без кода')).toBe('без кода');
});

test('isSystemChat reads peer.system', () => {
  expect(isSystemChat({ peer: { id: 1, name: 'Relay', system: true } })).toBe(true);
  expect(isSystemChat({ peer: { id: 2, name: 'Bob' } })).toBe(false);
  expect(isSystemChat({ peer: null })).toBe(false);
  expect(isSystemChat(undefined)).toBe(false);
});

test('search hits: a login_code hit shows the code as dots in the snippet', () => {
  const hit = { body: 'Код для входа в Relay: 48213\n\nНикому не сообщайте этот код', service: { type: 'login_code' } };
  expect(snippet(shownBody(hit), 'код')).not.toContain('48213');
  expect(snippet(shownBody(hit), '48213')).not.toContain('48213');
  expect(shownBody({ body: 'встреча 48213' })).toBe('встреча 48213');
  expect(shownBody({ body: 'встреча 48213', service: { type: 'new_login' } })).toBe('встреча 48213');
});

test('dayLabel: сегодня, вчера, дата этого и прошлого года', () => {
  const now = new Date();
  const d = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12).toISOString();
  expect(dayLabel(d(0))).toBe('Сегодня');
  expect(dayLabel(d(1))).toBe('Вчера');
  const old = new Date(now.getFullYear() - 1, 2, 8, 12);
  expect(dayLabel(old.toISOString())).toBe(old.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }));
  const thisYear = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 40, 12);
  if (thisYear.getFullYear() === now.getFullYear()) expect(dayLabel(thisYear.toISOString())).toBe(thisYear.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }));
});

test('dayLabel: два момента одного дня — одна подпись', () => {
  expect(dayLabel(new Date(2020, 4, 9, 0, 5).toISOString())).toBe(dayLabel(new Date(2020, 4, 9, 23, 55).toISOString()));
  expect(dayLabel(new Date(2020, 4, 9, 12).toISOString())).toBe('9 мая 2020 г.');
});
