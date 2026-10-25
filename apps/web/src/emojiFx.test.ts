import { expect, test } from 'bun:test';
import { EMOJI_FX_MAX } from '@relay/protocol';
import { createBatcher, EMOJI_FX_BATCH_MS } from './emojiFx';

test('пачка: окно от первого клика, t — секунды от него, одним кадром', () => {
  let t = 1000;
  const sent: unknown[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const b = createBatcher((chatId, id, key, tt) => sent.push([chatId, id, key, tt]), () => t, (fn, ms) => { timers.push({ fn, ms }); });
  b.click(5, 42, '❤');
  t += 350; b.click(5, 42, '❤');
  t += 400; b.click(5, 42, '❤');
  expect(timers).toHaveLength(1);
  expect(timers[0].ms).toBe(EMOJI_FX_BATCH_MS);
  expect(sent).toHaveLength(0);
  timers[0].fn();
  expect(sent).toEqual([[5, 42, '❤', [0, 0.35, 0.75]]]);
  expect(b.pending()).toBe(0);
  b.click(5, 42, '❤');   // новая пачка
  expect(timers).toHaveLength(2);
});

test('пачки по разным сообщениям независимы; не больше EMOJI_FX_MAX кликов', () => {
  let t = 0;
  const sent: number[][] = [];
  const timers: (() => void)[] = [];
  const b = createBatcher((_c, _i, _k, tt) => sent.push(tt), () => t, (fn) => { timers.push(fn); });
  for (let i = 0; i < EMOJI_FX_MAX + 5; i++) { b.click(1, 1, '🔥'); t += 10; }
  b.click(1, 2, '🔥');
  expect(b.pending()).toBe(2);
  timers.forEach((fn) => fn());
  expect(sent[0]).toHaveLength(EMOJI_FX_MAX);
  expect(sent[1]).toEqual([0]);
});
