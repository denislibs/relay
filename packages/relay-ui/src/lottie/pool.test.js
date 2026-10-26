import { beforeEach, expect, test } from 'bun:test';
import { __setFrameBudget, __setWorkerFactory, configureLottie, liveRenderers, lottieStats, openRenderer } from './pool.js';

// поддельный воркер: отвечает на open/frame и запоминает сообщения
let made;
class FakeWorker {
  constructor() { this.sent = []; made.push(this); }
  postMessage(m) {
    this.sent.push(m);
    queueMicrotask(() => {
      if (m.t === 'open') this.onmessage({ data: { t: 'opened', id: m.id, frames: 180, fps: 60, step: 1 } });
      if (m.t === 'frame') this.onmessage({ data: { t: 'frame', id: m.id, i: m.i, bmp: bitmap(m.i, made.find((w) => w.sent.some((x) => x.t === 'open' && x.id === m.id))?.sent.find((x) => x.t === 'open' && x.id === m.id).px ?? 1) } });
    });
  }
}
// поддельный ImageBitmap: width/height нужны для учёта байтов, close() обнуляет как настоящий
const bitmap = (i, px) => ({ i, width: px, height: px, closed: false, close() { this.closed = true; this.width = this.height = 0; } });
beforeEach(() => {
  made = [];
  __setFrameBudget(32 << 20);
  __setWorkerFactory(() => new FakeWorker());
  configureLottie({ workerUrl: 'w.js', wasm: { simd: 's.wasm', noSimd: 'n.wasm' } });
});
const sent = (t) => made.flatMap((w) => w.sent.filter((m) => m.t === t));

test('the same animation at the same size is one renderer; the last release closes it', async () => {
  const a = await openRenderer({ url: '/stk/duck/aaaaaaaa/1.tgs', px: 400 });
  const b = await openRenderer({ url: '/stk/duck/aaaaaaaa/1.tgs', px: 400 });
  expect(a).toBe(b);
  expect(sent('open')).toHaveLength(1);
  expect(a.frames).toBe(180);
  const c = await openRenderer({ url: '/stk/duck/aaaaaaaa/1.tgs', px: 144 });   // другой размер — свой рендерер
  expect(c).not.toBe(a);
  a.release();
  expect(sent('close')).toHaveLength(0);
  b.release(); c.release();
  expect(sent('close')).toHaveLength(2);
  expect(liveRenderers()).toBe(0);
});

test('a key always lands on the same worker; at most four workers', async () => {
  const keys = Array.from({ length: 40 }, (_, i) => `/stk/p/aaaaaaaa/${i}.tgs`);
  const rs = await Promise.all(keys.map((url) => openRenderer({ url, px: 400 })));
  expect(made.length).toBeLessThanOrEqual(4);
  rs.forEach((r) => r.release());
  const again = await openRenderer({ url: keys[7], px: 400 });
  const owner = made.find((w) => w.sent.some((m) => m.t === 'open' && m.url === keys[7]));
  expect(owner.sent.filter((m) => m.t === 'open' && m.url === keys[7])).toHaveLength(2);
  again.release();
});

test('frames are rendered once and cached; trimmed on pause and closed on release', async () => {
  const r = await openRenderer({ url: '/stk/duck/aaaaaaaa/2.tgs', px: 144 });
  const [f1, f1b] = await Promise.all([r.frame(1), r.frame(1)]);
  expect(f1).toBe(f1b);
  expect(sent('frame').filter((m) => m.i === 1)).toHaveLength(1);
  await r.frame(1);
  expect(sent('frame').filter((m) => m.i === 1)).toHaveLength(1);
  const f2 = await r.frame(2);
  r.trim(2);
  expect(f1.closed).toBe(true);
  expect(f2.closed).toBe(false);
  expect(lottieStats().bytes).toBe(144 * 144 * 4);
  r.release();
  expect(f2.closed).toBe(true);
  expect(lottieStats().bytes).toBe(0);
});

test('large sizes are never cached: every frame is rendered on demand and closed after use', async () => {
  const r = await openRenderer({ url: '/stk/duck/aaaaaaaa/3.tgs', px: 400 });
  const a = await r.frame(5);
  r.done(5, a);
  expect(a.closed).toBe(true);
  await r.frame(5);
  expect(sent('frame').filter((m) => m.i === 5)).toHaveLength(2);
  expect(lottieStats().cachedFrames).toBe(0);
  r.release();
});

test('one animation takes at most an eighth of the budget; the rest of its frames play uncached', async () => {
  const frame = 64 * 64 * 4;
  __setFrameBudget(frame * 8 * 4);              // по 4 кадра на анимацию
  const r = await openRenderer({ url: '/stk/duck/aaaaaaaa/4.tgs', px: 64 });
  for (let i = 0; i < 10; i++) r.done(i, await r.frame(i));
  expect(lottieStats().cachedFrames).toBe(4);
  for (let i = 0; i < 10; i++) r.done(i, await r.frame(i));
  // закэшированы одни и те же первые четыре: повторный цикл их не перерисовывает, остальные — заново
  expect(sent('frame')).toHaveLength(16);
  r.release();
});

test('the global budget evicts idle animations first and never goes over', async () => {
  const frame = 64 * 64 * 4;
  __setFrameBudget(frame * 8);                  // всего 8 кадров, по одному на анимацию
  const now = { t: 0 };
  const realNow = performance.now;
  performance.now = () => now.t;
  try {
    const rs = await Promise.all(Array.from({ length: 9 }, (_, k) => openRenderer({ url: `/stk/p/aaaaaaaa/${k}.tgs`, px: 64 })));
    for (const r of rs.slice(0, 8)) r.done(0, await r.frame(0));
    expect(lottieStats().cachedFrames).toBe(8);
    const last = rs[8];
    const b0 = await last.frame(0);             // бюджет полон, все играли только что — не кэшируется
    last.done(0, b0);
    expect(b0.closed).toBe(true);
    now.t = 5000;                               // остальные давно не просили кадров — простаивают
    for (const r of rs.slice(1, 8)) await r.frame(0);   // …кроме этих семи
    const b = await last.frame(1);
    expect(last.cache.get(1)).toBe(b);          // место освободил простаивающий rs[0]
    expect(rs[0].cache.size).toBe(0);
    expect(lottieStats().bytes).toBeLessThanOrEqual(frame * 8);
    rs.forEach((r) => r.release());
  } finally { performance.now = realNow; }
});
