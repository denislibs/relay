import { expect, test } from 'bun:test';
import { circleClip, circleOrigin, circleRadius } from './themeSwitch';

test('радиус круга закрывает окно до самого дальнего угла', () => {
  expect(circleRadius(0, 0, 300, 400)).toBe(500);
  expect(circleRadius(300, 400, 300, 400)).toBe(500);
  expect(circleRadius(150, 200, 300, 400)).toBe(250);
  expect(circleRadius(250, 50, 300, 400)).toBeCloseTo(Math.hypot(250, 350));
});

test('без нажатия и фокуса круг идёт из центра окна', () => {
  const g = globalThis as unknown as { innerWidth: number; innerHeight: number };
  g.innerWidth = 1000; g.innerHeight = 600;
  expect(circleOrigin()).toEqual({ x: 500, y: 300 });
});

test('круг в процентах снимка: центр — точка нажатия, полный радиус закрывает окно', () => {
  expect(circleClip(0, 0, 0, 1000, 500)).toBe('circle(0% at 0% 0%)');
  expect(circleClip(500, 250, 0, 1000, 500)).toBe('circle(0% at 50% 50%)');
  // радиус = диагональ/√2 → 100%
  const w = 1000, h = 500, d = Math.hypot(w, h) / Math.SQRT2;
  expect(circleClip(250, 100, d, w, h)).toBe('circle(100% at 25% 20%)');
});
