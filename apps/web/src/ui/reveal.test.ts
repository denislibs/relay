import { expect, test } from 'bun:test';
import { REVEAL_MAX, revealOrder, revealTotalMs } from './reveal';

const box = (key: string, top: number, h = 50) => ({ key, top, bottom: top + h });

test('reveal order: visible rows bottom-up, rows outside the screen do not wait', () => {
  const rows = [box('a', -100), box('b', 10), box('c', 300), box('d', 700), box('e', 1200)];
  const order = revealOrder(rows, 0, 900);
  expect(order.get('d')).toBe(0);     // ближайшая к низу — первой
  expect(order.get('c')).toBe(1);
  expect(order.get('b')).toBe(2);
  expect(order.has('a')).toBe(false); // выше экрана — без задержки (нет в карте → 0)
  expect(order.has('e')).toBe(false);
});

test('reveal order: a row crossing the edge counts as visible; the ladder is capped', () => {
  const rows = [box('edge', -20), ...Array.from({ length: 40 }, (_, i) => box('r' + i, i * 20, 20))];
  const order = revealOrder(rows, 0, 800);
  expect(order.has('edge')).toBe(true);
  expect(Math.max(...order.values())).toBe(REVEAL_MAX);
});

test('revealTotalMs: 200 ms for one row, +10 ms per further step, capped', () => {
  expect(revealTotalMs(1)).toBe(200);
  expect(revealTotalMs(5)).toBe(240);
  expect(revealTotalMs(100)).toBe(200 + (REVEAL_MAX - 1) * 10);
  expect(revealTotalMs(0)).toBe(200);
});
