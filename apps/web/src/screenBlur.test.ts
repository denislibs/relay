import { expect, test } from 'bun:test';
import { createBlurController, createSwallow } from './screenBlur';

function rig(delay: number, enabled = true) {
  const timers: { fn: () => void; ms: number; dead: boolean }[] = [];
  const log: boolean[] = [];
  const c = createBlurController({
    enabled: () => enabled, delaySec: () => delay, apply: (v) => log.push(v),
    setTimer: (fn, ms) => { const t = { fn, ms, dead: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { dead: boolean }).dead = true; },
  });
  return { c, timers, log };
}

test('delay 0 blurs at once, back clears', () => {
  const { c, log } = rig(0);
  c.lost(); expect(c.isOn()).toBe(true);
  c.back(); expect(log).toEqual([true, false]);
});
test('delay 5: short loss does not blur', () => {
  const { c, timers, log } = rig(5);
  c.lost(); expect(timers[0].ms).toBe(5000);
  c.back(); expect(timers[0].dead).toBe(true);
  expect(log).toEqual([]);
});
test('delay 5: long loss blurs when timer fires', () => {
  const { c, timers } = rig(5);
  c.lost(); timers[0].fn(); expect(c.isOn()).toBe(true);
});
test('disabled never blurs', () => {
  const { c } = rig(0, false); c.lost(); expect(c.isOn()).toBe(false);
});

test('lost twice does not restart the pending timer', () => {
  const { c, timers } = rig(5);
  c.lost(); c.lost();
  expect(timers.length).toBe(1);
});
function sw() {
  const timers: { fn: () => void; dead: boolean }[] = [];
  const s = createSwallow((fn) => { const t = { fn, dead: false }; timers.push(t); return t; }, (t) => { (t as { dead: boolean }).dead = true; });
  return { s, timers };
}
test('swallow: click right after arm is eaten once', () => {
  const { s } = sw(); s.arm(); expect(s.take()).toBe(true); expect(s.take()).toBe(false);
});
test('swallow: drag without click expires, next click passes', () => {
  const { s, timers } = sw(); s.arm(); timers[0].fn(); expect(s.take()).toBe(false);
});
test('swallow: pointercancel clears', () => {
  const { s } = sw(); s.arm(); s.cancel(); expect(s.take()).toBe(false);
});
