import { test, expect } from 'bun:test';
import { SelectHeader } from './more.js';

// SelectHeader на хуках — без DOM его не вызвать (в ките нет рендерера), поэтому проверяем склонение счётчика и экспорт.
import { plural } from './more.js';
test('склонение счётчика шапки выбора', () => {
  const t = (n) => 'Выбрано: ' + n + ' ' + plural(n, 'чат', 'чата', 'чатов');
  expect(t(1)).toBe('Выбрано: 1 чат');
  expect(t(2)).toBe('Выбрано: 2 чата');
  expect(t(5)).toBe('Выбрано: 5 чатов');
  expect(t(11)).toBe('Выбрано: 11 чатов');
  expect(t(21)).toBe('Выбрано: 21 чат');
});
test('SelectHeader экспортируется', () => { expect(typeof SelectHeader).toBe('function'); });
