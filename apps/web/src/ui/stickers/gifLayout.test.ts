import { expect, test } from 'bun:test';
import { GIF_GAP, gifLayout, gifWindow } from './gifLayout';

const gif = (id: string, w: number | null, h: number | null) => ({ id, w, h });

test('full rows fill the width exactly, with the gap between tiles and the same height within a row', () => {
  const { boxes, height } = gifLayout([gif('a', 200, 100), gif('b', 100, 100), gif('c', 300, 200), gif('d', 400, 300), gif('e', 500, 300), gif('f', 100, 200)], 400);
  const rows = new Map<number, typeof boxes>();
  for (const b of boxes) rows.set(b.y, [...(rows.get(b.y) ?? []), b]);
  for (const [, row] of [...rows].slice(0, -1)) {
    expect(new Set(row.map((b) => b.h)).size).toBe(1);
    expect(row[0].x).toBe(0);
    const last = row[row.length - 1];
    expect(last.x + last.w).toBe(400);
    row.slice(1).forEach((b, i) => expect(b.x).toBe(row[i].x + row[i].w + GIF_GAP));
  }
  const last = boxes[boxes.length - 1];
  expect(height).toBe(last.y + last.h);
});

test('the order of tiles is kept (newest first) and a tile is never wider than the panel', () => {
  const list = Array.from({ length: 200 }, (_, i) => gif('g' + i, 100 + (i * 37) % 400, 100 + (i * 53) % 300));
  const { boxes } = gifLayout(list, 420);
  expect(boxes.map((b) => b.id)).toEqual(list.map((g) => g.id));
  for (const b of boxes) { expect(b.w).toBeGreaterThan(0); expect(b.x + b.w).toBeLessThanOrEqual(420); }
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y);
});

test('layout is known before loading and stable: the same sizes give the same boxes', () => {
  const list = [gif('a', 320, 240), gif('b', 480, 270), gif('c', 240, 240), gif('d', 200, 400)];
  expect(gifLayout(list, 400)).toEqual(gifLayout(list.map((x) => ({ ...x })), 400));
});

test('extreme proportions and missing sizes do not break a row', () => {
  const { boxes } = gifLayout([gif('wide', 2000, 10), gif('tall', 10, 2000), gif('none', null, null)], 300);
  for (const b of boxes) { expect(b.h).toBeGreaterThan(40); expect(b.h).toBeLessThan(250); expect(b.w).toBeGreaterThan(30); }
});

test('an incomplete last row keeps the normal height instead of stretching', () => {
  const { boxes } = gifLayout([gif('a', 100, 100)], 400);
  expect(boxes[0]).toEqual({ id: 'a', x: 0, y: 0, w: 104, h: 104 });
});

test('no width — no tiles; nothing saved — zero height', () => {
  expect(gifLayout([gif('a', 1, 1)], 0).boxes).toEqual([]);
  expect(gifLayout([], 400)).toEqual({ boxes: [], height: 0 });
});

test('the window keeps only tiles near the viewport: 200 tiles, about two screens in the DOM', () => {
  const { boxes, height } = gifLayout(Array.from({ length: 200 }, (_, i) => gif('g' + i, 300, 200)), 420);
  const [a, b] = gifWindow(boxes, 0, 400, 200);
  expect(a).toBe(0);
  expect(b).toBeLessThan(40);
  const [c, d] = gifWindow(boxes, height - 400, height, 200);
  expect(d).toBe(200);
  expect(d - c).toBeLessThan(40);
  const [e, f] = gifWindow(boxes, 1500, 1900, 100);
  expect(boxes[e].y + boxes[e].h).toBeGreaterThanOrEqual(1400);
  expect(boxes[f - 1].y).toBeLessThanOrEqual(2000);
});
