import { expect, test } from 'bun:test';
import { albumSafe, estimateRow, extendWindow, firstWindow, learnScale, textLines, type Metrics, type RowLike } from './firstScreen';

const x: Metrics = { textW: 300, lineH: 20, pad: 16, gap: 4, mediaW: 400, mediaH: 400, sticker: 200, scale: 1, measure: (s) => s.length * 8 };
const txt = (i: number, body = 'привет'): RowLike => ({ key: 'k' + i, id: i, senderId: 1, body });
const list = (n: number, f: (i: number) => RowLike = txt) => Array.from({ length: n }, (_, i) => f(i));

test('textLines: абзац не меньше строки, длинный — по ширине', () => {
  expect(textLines('', x)).toBe(0);
  expect(textLines('a', x)).toBe(1);
  expect(textLines('a'.repeat(100), x)).toBe(3);   // 800 px / 300
  expect(textLines('a\n\nb', x)).toBe(3);
});

test('estimateRow: текст, фото по пропорциям, стикер, служебное, добавки', () => {
  expect(estimateRow(txt(1), x)).toBe(16 + 20 + 4);
  expect(estimateRow({ key: 'p', attachment: { kind: 'photo', w: 800, h: 600 } }, x)).toBe(300 + 4);
  expect(estimateRow({ key: 'p', attachment: { kind: 'photo', w: 300, h: 2000 } }, x)).toBe(400 + 4);   // упирается в высоту
  expect(estimateRow({ key: 's', sticker: { w: 512, h: 512 } }, x)).toBe(200 + 4);
  expect(estimateRow({ key: 'v', service: { type: 'join' } }, x)).toBe(30 + 4);
  expect(estimateRow({ ...txt(1), replyToId: 5, reactions: [1] }, x)).toBe(16 + 20 + 40 + 26 + 4);
  expect(estimateRow(txt(1), { ...x, scale: 1.5 })).toBe((16 + 20 + 4) * 1.5);
});

test('albumSafe: край окна не режет альбом одного отправителя', () => {
  const l = list(10, (i) => ({ ...txt(i), groupId: i >= 3 && i <= 5 ? 'g' : null }));
  expect(albumSafe(l, 4, 9)).toEqual([3, 9]);
  expect(albumSafe(l, 0, 4)).toEqual([0, 5]);
  expect(albumSafe(l, 6, 8)).toEqual([6, 8]);
});

test('firstWindow, низ: последние строки на экран + запас', () => {
  const l = list(100);   // по 40 px
  const w = firstWindow(l, { mode: 'bottom' }, { height: 400, margin: 100 }, x)!;
  expect(w[1]).toBe(99);
  expect((w[1] - w[0] + 1) * 40).toBeGreaterThanOrEqual(500);
  expect((w[1] - w[0]) * 40).toBeLessThan(500);
});

test('firstWindow, якорь: над ним — его отступ + запас, ниже — остаток экрана + запас', () => {
  const l = list(100);
  const [from, to] = firstWindow(l, { mode: 'anchor', index: 50, above: 80 }, { height: 400, margin: 100 }, x)!;
  expect(from).toBeLessThanOrEqual(50 - Math.ceil(180 / 40));
  expect(from).toBeGreaterThanOrEqual(50 - Math.ceil(180 / 40) - 1);
  expect((to - 50 + 1) * 40).toBeGreaterThanOrEqual(400 - 80 + 100);
});

test('firstWindow: почти всё окно — null (строить целиком)', () => {
  expect(firstWindow(list(10), { mode: 'bottom' }, { height: 400, margin: 100 }, x)).toBeNull();
  expect(firstWindow([], { mode: 'bottom' }, { height: 400, margin: 100 }, x)).toBeNull();
});

test('extendWindow: сначала вниз, потом вверх, полное — null', () => {
  const l = list(50);
  expect(extendWindow(l, [20, 30], 8)).toEqual([20, 38]);
  expect(extendWindow(l, [20, 45], 8)).toEqual([20, 49]);
  expect(extendWindow(l, [20, 49], 8)).toEqual([12, 49]);
  expect(extendWindow(l, [4, 49], 8)).toBeNull();
});

test('learnScale: низкий процентиль отношений, с пределами; мало замеров — прежняя', () => {
  expect(learnScale([{ actual: 60, estimate: 40 }, { actual: 50, estimate: 40 }, { actual: 80, estimate: 40 }], 1)).toBe(1.25);
  expect(learnScale([{ actual: 10, estimate: 40 }, { actual: 50, estimate: 40 }, { actual: 80, estimate: 40 }], 1)).toBe(0.8);
  // выброс среди многих замеров не решает
  const many = Array.from({ length: 20 }, () => ({ actual: 60, estimate: 40 }));
  expect(learnScale([{ actual: 10, estimate: 40 }, ...many], 1)).toBe(1.5);
  expect(learnScale([{ actual: 60, estimate: 40 }], 1.2)).toBe(1.2);
  // оценки уже умножены на прежнюю поправку — сравнение идёт с базовой оценкой
  expect(learnScale([{ actual: 60, estimate: 60 }, { actual: 60, estimate: 60 }, { actual: 60, estimate: 60 }], 1.5)).toBe(1.5);
});
