import { expect, test } from 'bun:test';
import { createErrorReporter } from './errorReport';

const collect = () => {
  const sent: { url: string; body: Record<string, unknown>; keepalive: boolean }[] = [];
  return { sent, post: async (url: string, body: string, keepalive: boolean) => { sent.push({ url, body: JSON.parse(body), keepalive }); } };
};

test('errors are batched with the build, repeats glued into a counter, messages capped', () => {
  const { sent, post } = collect();
  const r = createErrorReporter({ build: 'b1', post, flushMs: 60_000 });
  r.report('window', 'boom', 'Error: boom\n at x');
  r.report('window', 'boom');
  r.report('call', 'x'.repeat(1000));
  r.flush();
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toBe('/client-errors');
  expect(sent[0].body.build).toBe('b1');
  const errors = sent[0].body.errors as { source: string; message: string; count: number; stack?: string }[];
  expect(errors).toEqual([
    { source: 'window', message: 'boom', stack: 'Error: boom\n at x', count: 2 },
    { source: 'call', message: 'x'.repeat(300), count: 1 },
  ]);
});

test('a looping error stops being reported after the page cap; batches are at most 10 records', () => {
  const { sent, post } = collect();
  const r = createErrorReporter({ build: 'b1', post, flushMs: 60_000, maxSent: 15 });
  for (let i = 0; i < 100; i++) r.report('promise', 'e' + i);
  r.flush(); r.flush(); r.flush();
  const total = sent.reduce((n, s) => n + (s.body.errors as unknown[]).length, 0);
  expect(total).toBe(15);
  expect(sent.every((s) => (s.body.errors as unknown[]).length <= 10)).toBe(true);
});

test('call paths go to /client-stats; pagehide flush uses keepalive', () => {
  const { sent, post } = collect();
  const r = createErrorReporter({ build: 'b1', post, flushMs: 60_000 });
  r.callPath('p2p', 'relay');
  r.flush(true);
  expect(sent).toEqual([{ url: '/client-stats', body: { build: 'b1', calls: [{ kind: 'p2p', path: 'relay' }] }, keepalive: true }]);
});

test('a failing network never throws into the caller', async () => {
  const r = createErrorReporter({ build: 'b1', post: () => { throw new Error('offline'); }, flushMs: 60_000 });
  r.report('window', 'x');
  expect(() => r.flush()).not.toThrow();
  const r2 = createErrorReporter({ build: 'b1', post: async () => { throw new Error('offline'); }, flushMs: 60_000 });
  r2.report('window', 'x');
  r2.flush();
  await Bun.sleep(0);
});
