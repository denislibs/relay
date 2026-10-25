import { expect, test } from 'bun:test';
import { anchorShift, deferShift, requestShift, rowFor, shiftWanted, type ShiftDir } from './windowShift';

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

test('deferShift: during a heavy animation both directions are kept and run once after it; idle — runs now', () => {
  const ran: ShiftDir[] = [];
  const later: (() => void)[] = [];
  const box = { dirs: new Set<ShiftDir>() };
  // короткая лента при открытии: оба датчика в кадре — оба направления нужны (older грузит историю)
  deferShift(box, 'older', true, (fn) => later.push(fn), (d) => ran.push(d));
  deferShift(box, 'newer', true, (fn) => later.push(fn), (d) => ran.push(d));
  deferShift(box, 'older', true, (fn) => later.push(fn), (d) => ran.push(d));
  expect(ran).toEqual([]);
  expect(later).toHaveLength(1);           // одна подписка на конец анимации
  later[0]();
  expect(ran).toEqual(['older', 'newer']);
  expect(box.dirs.size).toBe(0);
  deferShift(box, 'older', false, (fn) => later.push(fn), (d) => ran.push(d));
  expect(ran).toEqual(['older', 'newer', 'older']);
});

test('anchorShift: the top edge is held by default; a row clipped at the top keeps its bottom; a row covering the screen that shrank comes to the top', () => {
  const view = 900;
  expect(anchorShift({ top: 100, bottom: 300 }, { top: 160, bottom: 360 }, view)).toBe(60);          // в экране — верх
  expect(anchorShift({ top: -200, bottom: 100 }, { top: -400, bottom: 160 }, view)).toBe(60);        // торчит за верх — низ (строка подросла сверху)
  expect(anchorShift({ top: 100, bottom: 1200 }, { top: 150, bottom: 1250 }, view)).toBe(50);        // торчит за низ — верх
  expect(anchorShift({ top: -300, bottom: 1200 }, { top: -300, bottom: 700 }, view)).toBe(-300);     // за оба края и свернулась — её верх к верху экрана
  expect(anchorShift({ top: -300, bottom: 1200 }, { top: -250, bottom: 1250 }, view)).toBe(50);      // за оба края, размер тот же — верх
});
