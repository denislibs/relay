import { expect, test } from 'bun:test';
import { frameTags, summarize, type RecFrame } from './recorder';

const f = (t: number, ms: number, extra: Partial<RecFrame> = {}): RecFrame => ({ t, ms, heavy: false, drive: false, stickers: 0, anims: [], ...extra });

test('summarize: skips the first frame, counts slow (>25) and jank (>50), percentiles and fps', () => {
  const frames = [f(5, 5), ...Array.from({ length: 58 }, (_, i) => f(5 + (i + 1) * 16.7, 16.7)), f(1000, 30, { drive: true }), f(1070, 70, { anims: ['rl-msg-in'] })];
  const s = summarize({ startedAt: 0, frames, longTasks: [{ t: 990, ms: 60 }] });
  expect(s.frames).toBe(60);
  expect(s.durationMs).toBe(1070);
  expect(s.fps).toBe(56);
  expect(s.slow).toBe(2);
  expect(s.jank).toBe(1);
  expect(s.max).toBe(70);
  expect(s.p50).toBe(16.7);
  expect(s.slowest.map((x) => x.ms)).toEqual([70, 30]);
  expect(s.longTasks).toBe(1);
  expect(s.longTasksMs).toBe(60);
});

test('summarize: an empty recording is all zeros', () => {
  expect(summarize({ startedAt: 0, frames: [], longTasks: [] })).toMatchObject({ frames: 0, fps: 0, p95: 0, max: 0, slow: 0, slowest: [] });
});

test('frameTags: scroll, heavy, stickers, then animation names', () => {
  expect(frameTags(f(0, 40, { drive: true, heavy: true, stickers: 3, anims: ['app-rpanel-in'] }))).toEqual(['прокрутка ленты', 'тяжёлая анимация', 'стикеров играет: 3', 'app-rpanel-in']);
});
