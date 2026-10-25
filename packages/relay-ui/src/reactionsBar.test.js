import { expect, test } from 'bun:test';
import { BAR_READY_MS, barReady, cellNext } from './reactionsBar.js';

test('ячейка: appear → select по концу appear; наведение играет select только когда он стоит', () => {
  expect(cellNext('appear', 'hover')).toBe('appear');          // пока появляется — не трогаем
  expect(cellNext('appear', 'appearEnded')).toBe('select');
  expect(cellNext('select', 'hover')).toBe('playing');
  expect(cellNext('playing', 'hover')).toBe('playing');        // повторное наведение не перезапускает
  expect(cellNext('playing', 'selectEnded')).toBe('select');
  expect(cellNext('static', 'hover')).toBe('static');          // без анимаций — ничего
});

test('панель готова, когда все первые кадры на месте или вышло время', () => {
  expect(barReady(3, 7, 0)).toBe(false);
  expect(barReady(7, 7, 0)).toBe(true);
  expect(barReady(0, 7, BAR_READY_MS)).toBe(true);
});
