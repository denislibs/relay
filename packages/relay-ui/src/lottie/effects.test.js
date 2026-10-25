import { expect, test } from 'bun:test';
import { createEffects, EMOJI_FX_MAX, FX_MAX, FX_TIMEOUT_MS } from './effects.js';

// плеер и DOM подменены: тест проверяет оркестрацию (синхронный старт, лимиты, уборку), не отрисовку
function harness() {
  const views = [];
  const attach = (o) => { const v = { o, play: !!o.play, visible: false, destroyed: false, setPlay(p) { v.play = p; }, setVisible(s) { v.visible = s; }, destroy() { v.destroyed = true; }, restart() {} }; views.push(v); return v; };
  const boxes = [];
  const timers = [];
  const hidden = new Map();
  let scrolls = [];
  const vib = [];
  const dom = {
    makeBig() { const b = { placed: [], removed: false, canvas: {}, place(x, y, m) { b.placed.push([Math.round(x), Math.round(y), m]); }, remove() { b.removed = true; } }; boxes.push(b); return b; },
    make() { const b = { placed: [], removed: false, centerGone: false, center: {}, around: {}, place(x, y) { b.placed.push([x, y]); }, dropCenter() { b.centerGone = true; }, remove() { b.removed = true; } }; boxes.push(b); return b; },
    rect: (el) => el.rect || { x: 100, y: 200, top: 190, bottom: 210, gone: false },
    hide(el, on) { hidden.set(el, on); },
    onScroll(fn) { scrolls.push(fn); return () => { scrolls = scrolls.filter((f) => f !== fn); }; },
    viewHeight: () => 800, dpr: () => 2, vibrate(ms) { vib.push(ms); },
  };
  const fx = createEffects({ attach, dom, measure: (f) => f(), mutate: (f) => f(), setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; }, raf: (fn) => { fn(); return 1; } });
  return { fx, views, boxes, timers, hidden, vib, scrolls: () => scrolls };
}
const assets = { center: '/rx/a/1/center.tgs', around: '/rx/a/1/around.tgs' };

test('оба плеера ждут первый кадр и стартуют вместе; центр доиграл — иконка вернулась; вокруг доиграл — всё убрано', () => {
  const h = harness();
  const icon = { id: 'i' };
  expect(h.fx.play(icon, assets)).toBe(true);
  expect(h.views.length).toBe(2);
  expect(h.views.map((v) => v.o.px)).toEqual([80, 160]);                // 40 и 80 px при dpr 2
  expect(h.views.every((v) => v.visible && !v.play && v.o.force && v.o.loop === false && v.o.shared === false)).toBe(true);
  expect(h.boxes[0].placed[0]).toEqual([100, 200]);                      // центр иконки
  h.views[0].o.onFirstFrame();
  expect(h.views.some((v) => v.play)).toBe(false);                       // один кадр — ещё ждём
  h.views[1].o.onFirstFrame();
  expect(h.views.every((v) => v.play)).toBe(true);
  expect(h.hidden.get(icon)).toBe(true);
  expect(h.vib).toEqual([100]);
  h.views[0].o.onEnded();
  expect(h.hidden.get(icon)).toBe(false);
  expect(h.boxes[0].centerGone).toBe(true);
  expect(h.fx.active()).toBe(1);
  h.views[1].o.onEnded();
  expect(h.fx.active()).toBe(0);
  expect(h.boxes[0].removed).toBe(true);
  expect(h.views.every((v) => v.destroyed)).toBe(true);
  expect(h.scrolls().length).toBe(0);
});

test('повтор на той же плашке не стартует, лимит FX_MAX, без ассетов — нет', () => {
  const h = harness();
  const icon = {};
  expect(h.fx.play(icon, assets)).toBe(true);
  expect(h.fx.play(icon, assets)).toBe(false);
  for (let i = 1; i < FX_MAX; i++) expect(h.fx.play({ n: i }, assets)).toBe(true);
  expect(h.fx.play({ n: 'over' }, assets)).toBe(false);
  expect(h.fx.play({ n: 'x' }, { center: '/c', around: null })).toBe(false);
});

test('страховочный таймер и уход за экран снимают эффект; ошибка плеера — тоже', () => {
  const h = harness();
  const a = {};
  h.fx.play(a, assets);
  expect(h.timers[0].ms).toBe(FX_TIMEOUT_MS);
  h.timers[0].fn();
  expect(h.fx.active()).toBe(0);
  const b = { rect: { x: 1, y: 1, top: -100, bottom: -80, gone: false } };
  h.fx.play(b, assets);
  expect(h.fx.active()).toBe(0);                                         // place() при старте: за экраном
  const c = {};
  h.fx.play(c, assets);
  h.views[h.views.length - 1].o.onError();
  expect(h.fx.active()).toBe(0);
});

test('прокрутка переставляет эффект за иконкой', () => {
  const h = harness();
  const icon = { rect: { x: 10, y: 20, top: 10, bottom: 30, gone: false } };
  h.fx.play(icon, assets);
  icon.rect = { x: 10, y: 60, top: 50, bottom: 70, gone: false };
  h.scrolls()[0]();
  expect(h.boxes[0].placed.at(-1)).toEqual([10, 60]);
});

test('эффект у большого эмодзи: якорь по стороне, отражение, лимит и уборка', () => {
  const h = harness();
  const el = { rect: { x: 300, y: 400, left: 200, right: 400, width: 200, height: 112, top: 344, bottom: 456, gone: false } };
  expect(h.fx.playBig(el, { url: '/stk/e/1/1.tgs', side: 'right', mirror: false })).toBe(true);
  const v = h.views.at(-1);
  expect(v.o.px).toBe(720);
  expect(v.play && v.o.force && v.o.shared === false && v.o.loop === false).toBe(true);
  const [x, y, m] = h.boxes[0].placed[0];
  expect(x).toBeGreaterThanOrEqual(400 - 360 + 16 - 16); expect(x).toBeLessThanOrEqual(400 - 360 + 16 + 16);   // right − 360 + наружу ±16
  expect(y).toBeGreaterThanOrEqual(344 + (112 - 360) / 2 - 4); expect(y).toBeLessThanOrEqual(344 + (112 - 360) / 2 + 4);
  expect(m).toBe(false);
  expect(h.fx.playBig({ rect: el.rect }, { url: '/stk/e/1/1.tgs', side: 'left', mirror: true })).toBe(true);
  expect(h.boxes[1].placed[0][2]).toBe(true);
  expect(h.boxes[1].placed[0][0]).toBeLessThanOrEqual(200 - 16 + 16);
  h.fx.playBig({ rect: el.rect }, { url: '/stk/e/1/1.tgs', side: 'left' });
  expect(h.fx.playBig({ rect: el.rect }, { url: '/stk/e/1/1.tgs', side: 'left' })).toBe(false);   // EMOJI_FX_MAX
  expect(h.fx.activeBig()).toBe(EMOJI_FX_MAX);
  v.o.onEnded();
  expect(h.fx.activeBig()).toBe(EMOJI_FX_MAX - 1);
  expect(h.boxes[0].removed && v.destroyed).toBe(true);
});
