import { test, expect } from 'bun:test';
import { gridLayout } from './windowMath.js';

test('grid layout: whole-pixel columns, the remainder spread over the first columns, 1px gaps', () => {
  // 302: 300 на плитки — ровно по 100
  expect(gridLayout(302, 3, 1)).toEqual({ cell: 100, step: 101, cols: [{ x: 0, w: 100 }, { x: 101, w: 100 }, { x: 202, w: 100 }] });
  // 304.6 → 304: 302 на плитки = 100 × 3 + 2 → первые две на пиксель шире; без дробных пикселей (нет «швов»)
  expect(gridLayout(304.6, 3, 1)).toEqual({ cell: 100, step: 101, cols: [{ x: 0, w: 101 }, { x: 102, w: 101 }, { x: 204, w: 100 }] });
  const L = gridLayout(304.6, 3, 1);
  expect(L.cols[2].x + L.cols[2].w).toBe(304);
});

test('grid layout: no width yet — nothing to place', () => {
  expect(gridLayout(0, 3, 1)).toEqual({ cell: 0, step: 0, cols: [] });
  expect(gridLayout(1, 3, 1)).toEqual({ cell: 0, step: 0, cols: [] });
});
