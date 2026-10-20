import { beforeEach, expect, test } from 'bun:test';
import { __setWorkerFactory, configureLottie, liveRenderers, openRenderer } from './pool.js';

// поддельный воркер: отвечает на open/frame и запоминает сообщения
let made;
class FakeWorker {
  constructor() { this.sent = []; made.push(this); }
  postMessage(m) {
    this.sent.push(m);
    queueMicrotask(() => {
      if (m.t === 'open') this.onmessage({ data: { t: 'opened', id: m.id, frames: 180, fps: 60, step: 1 } });
      if (m.t === 'frame') this.onmessage({ data: { t: 'frame', id: m.id, i: m.i, bmp: { i: m.i, closed: false, close() { this.closed = true; } } } });
    });
  }
}
beforeEach(() => {
  made = [];
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

test('frames are rendered once, cached by tier, trimmed on pause and closed on release', async () => {
  const r = await openRenderer({ url: '/stk/duck/aaaaaaaa/2.tgs', px: 400 });
  const [f1, f1b] = await Promise.all([r.frame(1), r.frame(1)]);
  expect(f1).toBe(f1b);
  expect(sent('frame').filter((m) => m.i === 1)).toHaveLength(1);
  await r.frame(4);                       // крупный: каждый четвёртый не кэшируется
  await r.frame(4);
  expect(sent('frame').filter((m) => m.i === 4)).toHaveLength(2);
  const f2 = await r.frame(2);
  r.trim(2);
  expect(f1.closed).toBe(true);
  expect(f2.closed).toBe(false);
  r.release();
  expect(f2.closed).toBe(true);
  const small = await openRenderer({ url: '/stk/duck/aaaaaaaa/2.tgs', px: 64 });
  await small.frame(4); await small.frame(4);   // мелкий: кэш целиком
  expect(sent('frame').filter((m) => m.i === 4 && m.id === small.id)).toHaveLength(1);
  small.release();
});
