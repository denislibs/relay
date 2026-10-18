import { expect, test } from 'bun:test';
import { CHECK_MS, startUpdateCheck } from './update';

function harness(builds: (string | null | Error)[], visible = true) {
  let t = 0;
  const timers: { at: number; fn: () => void }[] = [];
  let vis = visible, onVis: (() => void) | null = null;
  const found: string[] = [];
  let calls = 0;
  const stop = startUpdateCheck({
    current: 'a',
    fetchBuild: async () => { const b = builds[Math.min(calls++, builds.length - 1)]; if (b instanceof Error) throw b; return b; },
    onUpdate: (b) => found.push(b),
    now: () => t,
    visible: () => vis,
    setTimer: (fn, ms) => { const x = { at: t + ms, fn }; timers.push(x); return x; },
    clearTimer: (x) => { const i = timers.indexOf(x as never); if (i >= 0) timers.splice(i, 1); },
    onVisible: (fn) => { onVis = fn; return () => { onVis = null; }; },
  });
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((x, y) => x.at - y.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
      await Promise.resolve(); await Promise.resolve();
    }
    t = end;
  };
  return { advance, found, calls: () => calls, setVisible: (v: boolean) => { vis = v; }, show: async () => { vis = true; onVis?.(); await Promise.resolve(); await Promise.resolve(); }, stop };
}

test('same build — keeps quietly checking every 5 minutes; a new one is reported once', async () => {
  const h = harness(['a', 'a', 'b', 'c']);
  await h.advance(10_000);
  expect(h.calls()).toBe(1);
  await h.advance(CHECK_MS);
  expect(h.found).toEqual([]);
  await h.advance(CHECK_MS);
  expect(h.found).toEqual(['b']);
  await h.advance(CHECK_MS * 3);
  expect(h.calls()).toBe(3);
});

test('offline or a broken answer is not an update', async () => {
  const h = harness([new Error('offline'), null, 'a']);
  await h.advance(10_000 + CHECK_MS * 2);
  expect(h.found).toEqual([]);
  expect(h.calls()).toBe(3);
});

test('hidden tab does not poll; coming back after a long pause checks at once', async () => {
  const h = harness(['b'], false);
  await h.advance(10_000 + CHECK_MS * 2);
  expect(h.calls()).toBe(0);
  await h.show();
  expect(h.found).toEqual(['b']);
});

test('stop cancels everything', async () => {
  const h = harness(['b']);
  h.stop();
  await h.advance(CHECK_MS * 2);
  expect(h.calls()).toBe(0);
});
