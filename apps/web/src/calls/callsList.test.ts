import { expect, test } from 'bun:test';
import { groupCalls, groupText, isMissed, type CallRow } from './callsList';

const row = (id: number, o: Partial<CallRow>): CallRow => ({ id, chatId: 1, peerId: 2, name: 'Анна', photo: null, outgoing: false, video: false, reason: 'ended', at: '2026-11-07T10:00:00.000Z', ...o });

test('consecutive calls of one person, one kind, one day — one group; missed never merges with answered', () => {
  const rows = [
    row(6, { reason: 'missed' }), row(5, { reason: 'cancelled' }),            // два пропущенных подряд
    row(4, { reason: 'ended', duration: 30 }),                               // принятый — отдельно
    row(3, { outgoing: true, duration: 5 }), row(2, { outgoing: true, reason: 'busy' }),
    row(1, { outgoing: true, at: '2026-11-05T10:00:00.000Z' }),               // другой день
  ];
  expect(groupCalls(rows).map((g) => g.rows.map((r) => r.id))).toEqual([[6, 5], [4], [3, 2], [1]]);
  expect(groupCalls([row(2, { peerId: 3 }), row(1, {})]).length).toBe(2);
});

test('subtitle: direction, video, duration of a single answered call', () => {
  expect(groupText({ key: 'a', rows: [row(1, { duration: 125 })] })).toBe('Входящий, 2 мин');
  expect(groupText({ key: 'a', rows: [row(1, { outgoing: true, video: true, reason: 'cancelled' })] })).toBe('Исходящий видеозвонок');
  expect(groupText({ key: 'a', rows: [row(1, { reason: 'missed' }), row(0, { reason: 'missed' })] })).toBe('Пропущенный');
  expect(groupText({ key: 'a', rows: [row(1, { reason: 'declined' })] })).toBe('Отклонённый');
  expect(isMissed(row(1, { outgoing: true, reason: 'missed' }))).toBe(false);
  expect(isMissed(row(1, { reason: 'busy' }))).toBe(true);
});
