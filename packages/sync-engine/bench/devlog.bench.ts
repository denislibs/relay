// Цена журнала движка в горячем пути: кадр updates на 500 записей — запись (devlog) против применения к Store.
// Запуск: docker compose --profile test run --rm test-engine bun bench/devlog.bench.ts
import 'fake-indexeddb/auto';
import type { ServerFrame } from '@relay/protocol';
import { DevLog } from '../src/devlog';
import { openDb } from '../src/idb';
import { Store } from '../src/store';
import { msg } from '../test/fixtures';

export interface BenchResult { applyMs: number; flushMs: number; recordUs: number; ratio: number; ratioWithFlush: number }

/** Средние на кадр: применение в памяти, flush (выборочно), запись в журнал (пачкой, минус пустой регистратор). */
export async function measureRecording(N = 40, SIZE = 500): Promise<BenchResult> {
  const db = await openDb('bench-' + crypto.randomUUID());
  const store = await Store.open(db, 1);
  const frames: Extract<ServerFrame, { op: 'updates' }>[] = [];
  const raws: string[] = [];
  let id = 1;
  for (let k = 0; k < N; k++) {
    const items = [];
    for (let i = 0; i < SIZE; i++, id++) items.push({ seq: id, update: { type: 'newMessage' as const, message: msg({ id, chatId: 1 + (id % 20), senderId: 2, body: 'сообщение ' + id }) } });
    const f = { op: 'updates' as const, from: id - SIZE - 1, to: id - 1, items, more: false };
    frames.push(f);
    raws.push(JSON.stringify(f));
  }
  const log = new DevLog();
  for (let r = 0; r < 20; r++) for (let k = 0; k < N; k++) log.frameIn(frames[k], raws[k].length);   // разогрев (JIT)

  // применение: как в syncLoop — записи по одной; flush — выборочно (fake-indexeddb медленный)
  let tApply = 0, tFlush = 0;
  for (let k = 0; k < N; k++) {
    const t0 = performance.now();
    for (const it of frames[k].items) { store.applyUpdate(it.update, it.seq); store.lastSeq = it.seq; }
    tApply += performance.now() - t0;
    if (k % 10 === 0) { const t1 = performance.now(); await store.flush(); tFlush += (performance.now() - t1) * 10; }
  }
  // запись — то, что движок пишет на такой кадр (кадр, flush, проход подписок), против пустого регистратора, пачкой
  const R = 50;
  type Rec = { frameIn(f: ServerFrame, size: number): void; record(...a: unknown[]): unknown };
  const noop: Rec = { frameIn() {}, record() { return null; } };
  const bulk = (rec: Rec) => {
    const t0 = performance.now();
    for (let r = 0; r < R; r++) for (let k = 0; k < N; k++) {
      rec.frameIn(frames[k], raws[k].length);
      rec.record('engine', 'flush', { keys: SIZE + 20 }, undefined, 3);
      rec.record('engine', 'patches', { count: 3 });
    }
    return (performance.now() - t0) / R;
  };
  bulk(log as unknown as Rec); bulk(noop);
  const tRecord = Math.max(0, bulk(log as unknown as Rec) - bulk(noop));
  db.close();
  return { applyMs: tApply / N, flushMs: tFlush / N, recordUs: (tRecord / N) * 1000, ratio: tRecord / tApply, ratioWithFlush: tRecord / (tApply + tFlush) };
}

if (import.meta.main) {
  for (let i = 0; i < 3; i++) {
    const r = await measureRecording();
    console.log(`updates×500: apply ${r.applyMs.toFixed(3)} ms/frame (+ flush ≈ ${r.flushMs.toFixed(1)} ms), record ${r.recordUs.toFixed(2)} µs/frame → ${(r.ratio * 100).toFixed(2)} % of in-memory apply, ${(r.ratioWithFlush * 100).toFixed(4)} % with flush`);
  }
}
