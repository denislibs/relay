import { expect, test } from 'bun:test';
import { buildDateFormat, defaultDateLabel, formatDateEntity, parseDateFormat, relativeRefreshMs } from './formattedDate.js';

const at = (s) => Math.floor(new Date(s).getTime() / 1000);
const now = new Date('2026-10-19T12:00:00');

test('relative dates read like Telegram', () => {
  expect(formatDateEntity(at('2026-10-19T12:00:30'), 'r', now)).toBe('сейчас');
  expect(formatDateEntity(at('2026-10-19T12:05:00'), 'r', now)).toBe('через 5 минут');
  expect(formatDateEntity(at('2026-10-19T09:00:00'), 'r', now)).toBe('3 часа назад');
  expect(formatDateEntity(at('2026-10-20T20:00:00'), 'r', now)).toBe('завтра');
  expect(formatDateEntity(at('2026-10-16T10:00:00'), 'r', now)).toBe('3 дня назад');
});

test('absolute formats by letters; empty format shows the text as is', () => {
  const d = at('2026-10-20T09:05:07');
  expect(formatDateEntity(d, 'D')).toBe('20 октября 2026 г.');
  expect(formatDateEntity(d, 't')).toBe('09:05');
  expect(formatDateEntity(d, 'T')).toBe('09:05:07');
  expect(formatDateEntity(d, 'wDt')).toContain('вторник');
  expect(formatDateEntity(d, '')).toBe(null);
  expect(defaultDateLabel(d)).toContain('20 октября 2026');
  expect(defaultDateLabel(d)).toContain('09:05');
});

test('format string round-trips through the modal options; refresh cadence', () => {
  for (const f of ['r', 'wDt', 'dT', 'D', 't', '']) expect(buildDateFormat(parseDateFormat(f))).toBe(f);
  expect(relativeRefreshMs(at('2026-10-19T12:00:20'), now.getTime())).toBe(1000);
  expect(relativeRefreshMs(at('2026-10-19T12:30:00'), now.getTime())).toBe(60000);
  expect(relativeRefreshMs(at('2026-10-21T12:30:00'), now.getTime())).toBe(0);
});
