import { expect, test } from 'bun:test';
import { driveScroll, jumpNear } from './scrollDrive';

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

test('drive: the target is read every frame — it moves, we follow without restarting', () => {
  const c = clock(), root = { scrollTop: 0 };
  let bottom = 600;
  driveScroll(root, { ms: 300, target: () => bottom, ...c });
  c.tick(0); c.tick(150);
  const mid = root.scrollTop;
  bottom = 900;                    // пришло ещё сообщение
  c.tick(75);
  expect(root.scrollTop).toBeGreaterThan(mid);   // не откатывается и не прыгает в старт
  c.tick(75);
  expect(root.scrollTop).toBe(900);
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
