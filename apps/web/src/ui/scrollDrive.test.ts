import { expect, test } from 'bun:test';
import { burstAnimates, driveScroll, jumpNear } from './scrollDrive';

// ручные кадры: raf копит колбэки, tick() выполняет их с заданным временем
function clock() {
  const q: ((t: number) => void)[] = [];
  let t = 0;
  return {
    raf: (cb: (t: number) => void) => { q.push(cb); return q.length; },
    caf: () => { q.length = 0; },
    now: () => t,
    tick: (dt: number) => { t += dt; const cbs = q.splice(0); for (const cb of cbs) cb(t); },
  };
}

test('drive: eases from the current position to the target and lands exactly on it', () => {
  const c = clock(), root = { scrollTop: 0 };
  const ends: string[] = [];
  const d = driveScroll(root, { ms: 300, target: () => 600, onEnd: (r) => ends.push(r), ...c });
  expect(d.active).toBe(true);
  c.tick(0);                       // первый кадр — старт, позиция не меняется
  expect(root.scrollTop).toBe(0);
  c.tick(150);
  expect(root.scrollTop).toBeGreaterThan(300);   // ease-out: к середине времени больше половины пути
  expect(root.scrollTop).toBeLessThan(600);
  c.tick(150);
  expect(root.scrollTop).toBe(600);
  expect(d.active).toBe(false);
  expect(ends).toEqual(['done']);
});

test('drive: the target is read every frame — it moves, we re-base from where we are: no jump, no restart from zero', () => {
  const c = clock(), root = { scrollTop: 0 };
  let bottom = 600;
  driveScroll(root, { ms: 300, target: () => bottom, ...c });
  c.tick(0);
  for (let i = 0; i < 10; i++) c.tick(15);      // 150 мс по 15
  const mid = root.scrollTop;
  bottom = 1000;                   // пришло ещё сообщение: цель дальше на 400
  const steps: number[] = [];
  for (let i = 0; i < 21; i++) { const was = root.scrollTop; c.tick(15); steps.push(root.scrollTop - was); }   // кадр смены цели + 300 мс
  expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);        // не откатывается
  expect(Math.max(...steps)).toBeLessThan(120);                // и не прыгает: шаг кадра ограничен новой кривой от mid
  expect(root.scrollTop).toBe(1000);                           // новая кривая 300 мс от момента смены цели — доехали
  expect(mid).toBeGreaterThan(300);
});

test('burstAnimates: the first 600 ms of a burst animate, then instant until a 300 ms pause starts a new burst', () => {
  const b = { since: 0, last: 0 };
  expect(burstAnimates(b, 1000)).toBe(true);
  expect(burstAnimates(b, 1200)).toBe(true);
  expect(burstAnimates(b, 1500)).toBe(true);
  expect(burstAnimates(b, 1700)).toBe(false);   // 700 мс серии — мгновенно
  expect(burstAnimates(b, 1900)).toBe(false);   // поток продолжается (пауза 200 < 300)
  expect(burstAnimates(b, 2300)).toBe(true);    // пауза 400 мс — новая серия
});

test('drive: cancel stops where it is and reports cancel once', () => {
  const c = clock(), root = { scrollTop: 0 };
  const ends: string[] = [];
  const d = driveScroll(root, { ms: 300, target: () => 600, onEnd: (r) => ends.push(r), ...c });
  c.tick(0); c.tick(100);
  const at = root.scrollTop;
  expect(at).toBeGreaterThan(0);
  d.cancel(); d.cancel();
  c.tick(200);
  expect(root.scrollTop).toBe(at);
  expect(ends).toEqual(['cancel']);
  expect(d.active).toBe(false);
});

test('drive: start jumps first (far target), then eases the last screen', () => {
  const c = clock(), root = { scrollTop: 0 };
  driveScroll(root, { ms: 300, target: () => 5000, start: 4100, ...c });
  c.tick(0);
  expect(root.scrollTop).toBe(4100);
  c.tick(300);
  expect(root.scrollTop).toBe(5000);
});

test('jumpNear: farther than two screens — one screen short of the target on the near side; else null', () => {
  expect(jumpNear(0, 5000, 900)).toBe(4100);
  expect(jumpNear(5000, 0, 900)).toBe(900);
  expect(jumpNear(0, 1500, 900)).toBeNull();
});

import { bezier } from './scrollDrive';

test('bezier: CSS cubic-bezier timing (ends, the standard ease at 0.5, monotonic for the flight curve)', () => {
  const ease = bezier(0.25, 0.1, 0.25, 1);
  expect(ease(0)).toBe(0);
  expect(ease(1)).toBe(1);
  expect(ease(0.5)).toBeCloseTo(0.8024, 3);   // значение браузера для «ease» в середине
  const fly = bezier(0.1992, 0.0106, 0.2792, 0.9103);
  let prev = 0;
  for (let p = 0.05; p <= 1.0001; p += 0.05) { const v = fly(p); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
});
