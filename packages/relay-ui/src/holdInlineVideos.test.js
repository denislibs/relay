import { test, expect } from 'bun:test';

// поддельный IntersectionObserver: видимость задаём сами
let io = null;
globalThis.IntersectionObserver = class {
  constructor(cb, opts) { this.cb = cb; this.opts = opts; io = this; }
  observe() {}
  unobserve() {}
  show(el, on) { this.cb([{ target: el, isIntersecting: on, intersectionRatio: on ? 1 : 0 }]); }
};
const { videoObserve, holdInlineVideos } = await import('./kit.js');

test('while a viewer is open feed videos pause; on close only the visible ones play again', () => {
  const a = {}, b = {}, log = [];
  const offA = videoObserve(a, (on) => log.push(['a', on]));
  videoObserve(b, (on) => log.push(['b', on]));
  io.show(a, true); io.show(b, false);
  log.length = 0;

  const release = holdInlineVideos();
  expect(log).toEqual([['a', false], ['b', false]]);
  log.length = 0;
  io.show(b, true);                     // прокрутили под просмотрщиком — играть рано
  expect(log).toEqual([]);

  release();
  release();                            // повторное снятие ничего не ломает
  expect(log).toEqual([['a', true], ['b', true]]);
  offA();
});

test('nested viewers: playback resumes only after the last one closes', () => {
  const el = {}, log = [];
  const off = videoObserve(el, (on) => log.push(on));
  io.show(el, true);
  log.length = 0;
  const r1 = holdInlineVideos(), r2 = holdInlineVideos();
  r1();
  expect(log).toEqual([false]);
  r2();
  expect(log).toEqual([false, true]);
  off();
  // отписанный ролик не будят
  const r3 = holdInlineVideos(); r3();
  expect(log).toEqual([false, true]);
});
