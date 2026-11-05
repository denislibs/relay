import { beforeEach, expect, test } from 'bun:test';
import { resetVideoWorkerForTests, transcodeInWorker } from './compressVideo';

/** Поддельный Worker: отвечает сценарием на 'run', помнит terminate. */
function fake(script: (w: FakeWorker) => void) {
  const made: FakeWorker[] = [];
  const spawn = () => { const w = new FakeWorker(script); made.push(w); return w as unknown as Worker; };
  return { spawn, made };
}
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  sent: unknown[] = [];
  constructor(private script: (w: FakeWorker) => void) {}
  postMessage(m: unknown) { this.sent.push(m); queueMicrotask(() => this.script(this)); }
  terminate() { this.terminated = true; }
  emit(data: unknown) { if (!this.terminated) this.onmessage?.({ data } as MessageEvent); }
  fail() { this.onerror?.({ preventDefault() {} } as unknown as ErrorEvent); }
}

const file = new Blob(['x'], { type: 'video/mp4' });
beforeEach(resetVideoWorkerForTests);

test('progress and the result come from the worker; the worker is terminated afterwards', async () => {
  const out = new Blob(['small'], { type: 'video/mp4' });
  const { spawn, made } = fake((w) => { w.emit({ type: 'progress', p: 0.5 }); w.emit({ type: 'done', out }); });
  const seen: number[] = [];
  expect(await transcodeInWorker(file, 720, (p) => seen.push(p), undefined, spawn)).toBe(out);
  expect(seen).toEqual([0.5]);
  expect(made[0].sent).toEqual([{ type: 'run', file, short: 720 }]);
  expect(made[0].terminated).toBe(true);
});

test('abort terminates the worker at once and resolves null', async () => {
  const ac = new AbortController();
  const { spawn, made } = fake((w) => w.emit({ type: 'progress', p: 0.1 }));   // «работает» и не заканчивает
  const p = transcodeInWorker(file, 720, () => ac.abort(), ac.signal, spawn);
  expect(await p).toBeNull();
  expect(made[0].terminated).toBe(true);
});

test('a transcode error rejects (caller sends the original)', async () => {
  const { spawn } = fake((w) => w.emit({ type: 'error', message: 'codec' }));
  await expect(transcodeInWorker(file, 720, undefined, undefined, spawn)).rejects.toThrow('codec');
});

test('no WebCodecs in the worker or the script failed to load → page fallback, and the worker is not tried again', async () => {
  const a = fake((w) => w.emit({ type: 'unsupported' }));
  expect(typeof await transcodeInWorker(file, 720, undefined, undefined, a.spawn)).toBe('symbol');
  const b = fake(() => {});
  expect(typeof await transcodeInWorker(file, 720, undefined, undefined, b.spawn)).toBe('symbol');
  expect(b.made.length).toBe(0);

  resetVideoWorkerForTests();
  const c = fake((w) => w.fail());
  expect(typeof await transcodeInWorker(file, 720, undefined, undefined, c.spawn)).toBe('symbol');
});

test('a crash after the worker started is an error, not a silent fallback', async () => {
  const { spawn } = fake((w) => { w.emit({ type: 'progress', p: 0.3 }); w.fail(); });
  await expect(transcodeInWorker(file, 720, undefined, undefined, spawn)).rejects.toThrow('video worker failed');
});
