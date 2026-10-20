import { test, expect } from 'bun:test';

// поддельный IntersectionObserver: запоминаем экземпляры, наблюдаемые элементы и disconnect
const made = [];
globalThis.IntersectionObserver = class {
  constructor(cb, opts) { this.cb = cb; this.opts = opts; this.els = new Set(); this.off = false; made.push(this); }
  observe(el) { this.els.add(el); }
  unobserve(el) { this.els.delete(el); }
  disconnect() { this.off = true; this.els.clear(); }
  fire(el) { this.cb([{ target: el, isIntersecting: true }]); }
};
const { lazyObserve, lazyRoots } = await import('./kit.js');

test('one observer per root; after the last element leaves, the observer is disconnected and the root forgotten', () => {
  const root = {}, a = {}, b = {};
  const base = lazyRoots();
  const offA = lazyObserve(a, () => {}, root);
  const offB = lazyObserve(b, () => {}, root);
  const io = made.at(-1);
  expect(made.filter((x) => x.opts.root === root)).toHaveLength(1);
  expect(io.opts).toMatchObject({ root, rootMargin: '500px 0px' });
  expect(lazyRoots()).toBe(base + 1);
  offA();
  offA();                                 // повторная отмена ничего не ломает
  expect(io.off).toBe(false);
  offB();
  expect(io.off).toBe(true);
  expect(lazyRoots()).toBe(base);
  // корень снова нужен — новый наблюдатель
  const off = lazyObserve(a, () => {}, root);
  expect(made.at(-1)).not.toBe(io);
  off();
  expect(lazyRoots()).toBe(base);
});

test('a loaded element releases itself: the callback runs once and the root entry goes away', () => {
  const root = {}, a = {};
  let n = 0;
  const off = lazyObserve(a, () => { n++; }, root);
  const io = made.at(-1);
  io.fire(a);
  io.fire(a);
  expect(n).toBe(1);
  expect(io.off).toBe(true);
  off();                                  // размонтирование после загрузки — без двойного учёта
  expect(lazyRoots()).toBe(0);
});
