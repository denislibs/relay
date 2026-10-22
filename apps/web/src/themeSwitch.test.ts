import { expect, test } from 'bun:test';
import { circleOrigin, circleRadius } from './themeSwitch';

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
