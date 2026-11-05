import { expect, test } from 'bun:test';
import { canSetAutoDelete, customTerm, leftText, termParts, termText } from './autoDelete';
import { serviceText } from './ui/serviceText';

test('termText speaks Russian and keeps the exact term', () => {
  expect(termText(86400)).toBe('1 день');
  expect(termText(7 * 86400)).toBe('1 неделя');
  expect(termText(30 * 86400)).toBe('1 месяц');
  expect(termText(365 * 86400)).toBe('1 год');
  expect(termText(3600)).toBe('1 час');
  expect(termText(36 * 3600)).toBe('36 часов');
  expect(termText(2 * 86400)).toBe('2 дня');
  expect(termText(21 * 86400)).toBe('3 недели');
  expect(termText(10)).toBe('10 секунд');
});

test('leftText rounds up: «через 1 мин» has not passed yet', () => {
  const now = 1_000_000;
  expect(leftText(now + 1500, now)).toBe('Удалится через 2 с');
  expect(leftText(now + 61_000, now)).toBe('Удалится через 2 мин');
  expect(leftText(now + 3601_000, now)).toBe('Удалится через 2 ч');
  expect(leftText(now + 86400_000 * 3, now)).toBe('Удалится через 3 дня');
  expect(leftText(now + 86400_000 * 60, now)).toBe('Удалится через 2 месяца');
  expect(leftText(now - 5, now)).toBe('Удалится через 1 с');
});

test('customTerm: an hour to a year, whole numbers only', () => {
  expect(customTerm('1', 'hours')).toBe(3600);
  expect(customTerm(' 2 ', 'days')).toBe(2 * 86400);
  expect(customTerm('12', 'months')).toBe(360 * 86400);
  expect(customTerm('365', 'days')).toBe(365 * 86400);
  expect(customTerm('366', 'days')).toBe('Не больше года');
  expect(customTerm('13', 'months')).toBe('Не больше года');
  for (const bad of ['', '0', '-1', '1.5', 'abc']) expect(typeof customTerm(bad, 'hours')).toBe('string');
  expect(termParts(2 * 86400)).toEqual({ value: '2', unit: 'days' });
  expect(termParts(null)).toEqual({ value: '', unit: 'hours' });
});

test('who may change it', () => {
  const admin = { admin: { info: true } } as never, plain = { admin: null, rights: { info: true } } as never;
  expect(canSetAutoDelete({ saved: true })).toBe(true);
  expect(canSetAutoDelete({ peerId: 1 })).toBe(true);
  expect(canSetAutoDelete({ peerId: 1, blocked: true })).toBe(false);
  expect(canSetAutoDelete({ system: true, peerId: 1 })).toBe(false);
  expect(canSetAutoDelete({ me: admin })).toBe(true);
  expect(canSetAutoDelete({ me: plain })).toBe(false);   // разрешение участникам менять информацию — не про автоудаление
  expect(canSetAutoDelete({ preview: true, me: admin })).toBe(false);
});

test('service text', () => {
  const o = { mine: false, sender: 'Анна', meId: 1 };
  expect(serviceText('auto_delete_changed', { ...o, data: { sec: 604800 } })).toBe('Анна включил(а) автоудаление: 1 неделя');
  expect(serviceText('auto_delete_changed', { ...o })).toBe('Анна выключил(а) автоудаление');
  expect(serviceText('auto_delete_changed', { ...o, mine: true, data: { sec: 86400 } })).toBe('Вы включили автоудаление: 1 день');
  expect(serviceText('auto_delete_changed', { ...o, fromChannel: true, data: { sec: 86400 } })).toBe('Автоудаление в канале: 1 день');
  expect(serviceText('auto_delete_changed', { ...o, fromChannel: true })).toBe('Автоудаление в канале выключено');
});
