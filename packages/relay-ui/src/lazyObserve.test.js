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
const { beginHeavyAnimation } = await import('./schedule.js');

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

test('during a heavy animation the callback waits; it runs once the animation ends, with the last known state', () => {
  const root = {}, a = {}, b = {};
  let na = 0, nb = 0;
  lazyObserve(a, () => { na++; }, root);
  lazyObserve(b, () => { nb++; }, root);
  const io = made.at(-1);
  const end = beginHeavyAnimation(1000);
  io.fire(a);
  io.cb([{ target: b, isIntersecting: true }, { target: b, isIntersecting: false }]);   // b вошёл и вышел
  expect(na).toBe(0);
  expect(io.els.has(a)).toBe(true);        // наблюдение не снято: состояние может измениться до конца анимации
  end();
  expect(na).toBe(1);
  expect(nb).toBe(0);                      // последнее состояние b — вне зоны
  expect(io.els.has(a)).toBe(false);
  expect(io.els.has(b)).toBe(true);        // b ждёт следующего пересечения
});

test('released before the animation ends — the callback never runs', () => {
  const root = {}, a = {};
  let n = 0;
  const off = lazyObserve(a, () => { n++; }, root);
  const io = made.at(-1);
  const end = beginHeavyAnimation(1000);
  io.fire(a);
  off();
  end();
  expect(n).toBe(0);
});

test('a second margin on the same root gets its own observer; the root is forgotten after both leave', () => {
  const root = {}, a = {};
  const base = lazyRoots();
  const offNear = lazyObserve(a, () => {}, root);
  const offSeen = lazyObserve(a, () => {}, root, '0px');
  const near = made.at(-2), seen = made.at(-1);
  expect(near.opts.rootMargin).toBe('500px 0px');
  expect(seen.opts.rootMargin).toBe('0px');
  expect(lazyRoots()).toBe(base + 1);          // один корень, два наблюдателя
  let n = 0;
  lazyObserve({}, () => { n++; }, root, '0px');
  seen.fire(a);                                 // «видно сейчас» для a — колбэк только у a
  expect(n).toBe(0);
  offNear(); offSeen();
  expect(near.off).toBe(true);
  expect(seen.off).toBe(false);                 // второй элемент ещё наблюдается
  expect(lazyRoots()).toBe(base + 1);
});
