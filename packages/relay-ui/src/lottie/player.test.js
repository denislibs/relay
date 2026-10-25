import { beforeEach, expect, test } from 'bun:test';

globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 0);
const { __setWorkerFactory, configureLottie } = await import('./pool.js');
const { attachSticker, setStickerGroupExclusive, stickerStats } = await import('./player.js');

let made;
class FakeWorker {
  constructor() { this.sent = []; made.push(this); }
  postMessage(m) {
    this.sent.push(m);
    setTimeout(() => {
      if (m.t === 'open') this.onmessage({ data: { t: 'opened', id: m.id, frames: 60, fps: 60, step: 1 } });
      if (m.t === 'frame') this.onmessage({ data: { t: 'frame', id: m.id, i: m.i, bmp: { width: 4, height: 4, close() {} } } });
    }, 0);
  }
}
const canvas = () => ({ width: 0, height: 0, draws: 0, getContext() { const c = this; return { clearRect() {}, drawImage() { c.draws++; } }; } });
const sent = (t) => made.flatMap((w) => w.sent.filter((m) => m.t === t));
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => { made = []; __setWorkerFactory(() => new FakeWorker()); configureLottie({ workerUrl: 'w', wasm: { simd: 's', noSimd: 'n' } }); });

test('copies of one sticker share a clock; the first frame is drawn even before it is visible', async () => {
  const a = canvas(), b = canvas();
  let firstA = 0;
  const va = attachSticker({ url: '/stk/x/aaaaaaaa/1.tgs', px: 64, canvas: a, onFirstFrame: () => firstA++ });
  const vb = attachSticker({ url: '/stk/x/aaaaaaaa/1.tgs', px: 64, canvas: b });
  await wait();
  expect(sent('open')).toHaveLength(1);
  expect(firstA).toBe(1);
  expect(a.draws).toBeGreaterThan(0);
  expect(stickerStats()).toEqual({ players: 1, playing: 0 });   // не на экране — часы стоят
  va.setVisible(true);
  expect(stickerStats().playing).toBe(1);
  va.destroy();
  expect(sent('close')).toHaveLength(0);
  vb.destroy();
  expect(sent('close')).toHaveLength(1);
  expect(stickerStats().players).toBe(0);
});

test('an exclusive group pauses everything else', async () => {
  const feed = attachSticker({ url: '/stk/x/aaaaaaaa/2.tgs', px: 64, canvas: canvas(), group: 'feed' });
  const modal = attachSticker({ url: '/stk/x/aaaaaaaa/3.tgs', px: 64, canvas: canvas(), group: 'modal' });
  await wait();
  feed.setVisible(true); modal.setVisible(true);
  expect(stickerStats().playing).toBe(2);
  setStickerGroupExclusive('modal');
  expect(stickerStats().playing).toBe(1);
  setStickerGroupExclusive(null);
  expect(stickerStats().playing).toBe(2);
  feed.destroy(); modal.destroy();
});

test('onEnded fires once when a non-looping sticker reaches its last frame; restart arms it again', async () => {
  let ended = 0;
  const v = attachSticker({ url: '/stk/x/aaaaaaaa/4.tgs', px: 64, canvas: canvas(), loop: false, onEnded: () => ended++ });
  await wait();
  v.setVisible(true);
  await wait(1200);   // 60 кадров при 60 fps — секунда
  expect(ended).toBe(1);
  expect(stickerStats().playing).toBe(0);
  await wait(100);
  expect(ended).toBe(1);
  v.restart();
  await wait(1200);
  expect(ended).toBe(2);
  v.destroy();
});

test('force plays through heavy animation, autoplay off and an exclusive group', async () => {
  const { beginHeavyAnimation } = await import('../schedule.js');
  const { setStickerPolicy } = await import('./player.js');
  const end = beginHeavyAnimation(5000);
  setStickerPolicy({ autoplay: false });
  setStickerGroupExclusive('modal');
  const plain = attachSticker({ url: '/stk/x/aaaaaaaa/5.tgs', px: 64, canvas: canvas(), group: 'feed' });
  const forced = attachSticker({ url: '/stk/x/aaaaaaaa/6.tgs', px: 64, canvas: canvas(), group: 'fx', force: true });
  await wait();
  plain.setVisible(true); forced.setVisible(true);
  expect(stickerStats().playing).toBe(1);
  end(); setStickerPolicy({ autoplay: true }); setStickerGroupExclusive(null);
  plain.destroy(); forced.destroy();
});

test('shared:false даёт отдельный плеер при том же url и размере (часы не делятся)', async () => {
  const a = attachSticker({ url: '/stk/x/aaaaaaaa/7.tgs', px: 64, canvas: canvas(), shared: false });
  const b = attachSticker({ url: '/stk/x/aaaaaaaa/7.tgs', px: 64, canvas: canvas(), shared: false });
  const c = attachSticker({ url: '/stk/x/aaaaaaaa/7.tgs', px: 64, canvas: canvas() });
  await wait();
  expect(stickerStats().players).toBe(3);
  a.destroy(); b.destroy(); c.destroy();
  expect(stickerStats().players).toBe(0);
});
