import { expect, test } from 'bun:test';
import { requestShift, rowFor, shiftWanted } from './windowShift';

const both = { hasOlder: true, hasNewer: true };

test('window moves only where there is more and where the user scrolls', () => {
  expect(shiftWanted('newer', both, 0)).toBe(true);    // ещё не листали (окно только открыли)
  expect(shiftWanted('newer', both, 1)).toBe(true);
  expect(shiftWanted('newer', both, -1)).toBe(false);  // листают вверх — нижний датчик окно не тянет
  expect(shiftWanted('older', both, 1)).toBe(false);
  expect(shiftWanted('older', both, -1)).toBe(true);
  expect(shiftWanted('newer', { hasOlder: true, hasNewer: false }, 1)).toBe(false);   // у живого края
  expect(shiftWanted('older', { hasOlder: false, hasNewer: true }, -1)).toBe(false);  // у начала истории
  expect(shiftWanted('newer', null, 1)).toBe(false);
});

test('restored at the start of history, the user scrolled up and then down: the newer shift is allowed again', () => {
  const atStart = { hasOlder: false, hasNewer: true };
  expect(shiftWanted('newer', atStart, -1)).toBe(false);
  expect(shiftWanted('newer', atStart, 1)).toBe(true);
});

test('anchor is kept only while a shift is really on its way', () => {
  const anchor = { key: 'k', top: 10 };
  expect(requestShift(() => anchor, () => true)).toBe(anchor);
  // окно не двинулось (край уже пуст, прежний сдвиг в пути) — якорь не остаётся висеть
  expect(requestShift(() => anchor, () => false)).toBeNull();
  // замер — до запроса: новое окно может прийти раньше, чем мы прочли бы старое
  const order: string[] = [];
  requestShift(() => { order.push('measure'); return anchor; }, () => { order.push('move'); return true; });
  expect(order).toEqual(['measure', 'move']);
});

test('row of a message: by key, or the album row that contains it when the window split the album differently', () => {
  const row = (key: string, sort: number) => ({ dataset: { key, sort: String(sort) } });
  const rows = [row('a', 10), row('album', 20), row('b', 30)];   // альбом 20…29 — одна строка с ключом первого фото
  expect(rowFor(rows, 'b', 30)).toBe(rows[2]);
  // позицию запомнили, когда окно начиналось с середины альбома (строка с ключом его 24-го): теперь альбом целый
  expect(rowFor(rows, 'p24', 24)).toBe(rows[1]);
  expect(rowFor(rows, 'p5', 5)).toBeNull();      // раньше окна — не найдена (откроется как без позиции)
  expect(rowFor(rows, 'x', 99)).toBe(rows[2]);
});
