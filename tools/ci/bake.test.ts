import { expect, test } from 'bun:test';
import { args, judge, LIMITS, parseVector, queries, STRICT, ZERO_BASE, type Base, type Sample, type Streak } from '../../deploy/bake';

// Судья фазы наблюдения после выката (deploy/bake.ts): каждый порог срабатывает и молчит на границе, малый трафик
// не откатывает, поломка мониторинга не откатывает.

const BAKE = 600, IV = 30;
const healthy = (over: Partial<Sample> = {}): Sample => ({
  seen: true, reqs: 0, err5xx: 0, wsInternal: 0, clientErrors: 0, p95: null,
  up: { server: 1, worker: 1 }, uptime: { server: 9000, worker: 9000 }, ...over,
});
const st = (): Streak => ({ ready: 0, up: 0 });
const run = (s: Sample | null, opts: { ready?: boolean | null; base?: Base; elapsed?: number; streak?: Streak; L?: typeof LIMITS } = {}) =>
  judge(opts.ready ?? true, s, opts.base ?? ZERO_BASE, opts.streak ?? st(), opts.elapsed ?? 300, BAKE, IV, opts.L);

test('quiet build: wait until the bake time is over, then ok', () => {
  expect(run(healthy(), { elapsed: 300 }).verdict).toBe('wait');
  expect(run(healthy(), { elapsed: BAKE }).verdict).toBe('ok');
});

test('/ready false: one miss is tolerated, two in a row fail', () => {
  const s = st();
  expect(run(healthy(), { ready: false, streak: s }).verdict).toBe('wait');
  expect(run(healthy(), { ready: true, streak: s }).verdict).toBe('wait');   // серия сбрасывается
  expect(run(healthy(), { ready: false, streak: s }).verdict).toBe('wait');
  const v = run(healthy(), { ready: false, streak: s });
  expect(v.verdict).toBe('fail');
  expect(v.reasons[0]).toStartWith('ready:');
});

test('a scrape target down twice in a row fails', () => {
  const s = st(), down = healthy({ up: { server: 0, worker: 1 } });
  expect(run(down, { streak: s }).verdict).toBe('wait');
  expect(run(down, { streak: s }).reasons[0]).toBe('up: server not scraped 2 times in a row');
});

test('a process of the new build restarted during the bake fails at once', () => {
  const v = run(healthy({ uptime: { server: 40, worker: 9000 } }), { elapsed: 300 });
  expect(v.verdict).toBe('fail');
  expect(v.reasons[0]).toStartWith('restart: server');
  // процесс поднят перед началом наблюдения — не перезапуск
  expect(run(healthy({ uptime: { server: 260, worker: 9000 } }), { elapsed: 300 }).verdict).toBe('wait');
});

test('5xx: needs volume, absolute share and growth against the base', () => {
  expect(run(healthy({ reqs: 19, err5xx: 19 })).verdict).toBe('wait');                       // мало запросов
  expect(run(healthy({ reqs: 100, err5xx: 2 })).verdict).toBe('wait');                         // 2 % — граница
  expect(run(healthy({ reqs: 100, err5xx: 3 })).reasons[0]).toStartWith('5xx: 3.0% of 100');
  const base = { ...ZERO_BASE, reqs: 1000, err5xx: 20 };                                         // база 2 %
  expect(run(healthy({ reqs: 100, err5xx: 5 }), { base }).verdict).toBe('wait');               // 5 % < 3 × 2 %
  expect(run(healthy({ reqs: 100, err5xx: 7 }), { base }).verdict).toBe('fail');
});

test('ws internal errors and client errors: 3 × base + 5', () => {
  expect(run(healthy({ wsInternal: 5 })).verdict).toBe('wait');
  expect(run(healthy({ wsInternal: 6 })).reasons[0]).toStartWith('ws internal errors: 6');
  const base = { ...ZERO_BASE, clientErrors: 2 };
  expect(run(healthy({ clientErrors: 11 }), { base }).verdict).toBe('wait');
  expect(run(healthy({ clientErrors: 12 }), { base }).reasons[0]).toStartWith('client errors: 12');
});

test('p95: over 1 s and twice the base, with enough requests', () => {
  expect(run(healthy({ reqs: 49, p95: 5 })).verdict).toBe('wait');
  expect(run(healthy({ reqs: 50, p95: 0.9 })).verdict).toBe('wait');
  expect(run(healthy({ reqs: 50, p95: 1.5 })).reasons[0]).toStartWith('p95: 1.50s');
  expect(run(healthy({ reqs: 50, p95: 1.5 }), { base: { ...ZERO_BASE, p95: 0.8 } }).verdict).toBe('wait');
});

test('new build not visible in metrics: wait for half the bake, then fail', () => {
  const unseen = healthy({ seen: false, uptime: {} });
  expect(run(unseen, { elapsed: 299 }).verdict).toBe('wait');
  expect(run(unseen, { elapsed: 300 }).reasons).toContain('metrics: VictoriaMetrics does not see the new build');
});

test('VictoriaMetrics unavailable: no rollback for broken monitoring, /ready still counts', () => {
  expect(run(null, { elapsed: BAKE }).verdict).toBe('ok');
  const s = st();
  run(null, { ready: false, streak: s });
  expect(run(null, { ready: false, streak: s }).verdict).toBe('fail');
});

test('--strict fails on any request of the new build (manual check of live queries)', () => {
  expect(run(healthy({ reqs: 1 }), { L: STRICT }).verdict).toBe('fail');
  expect(run(healthy({ reqs: 0 }), { L: STRICT }).verdict).toBe('wait');
});

test('parseVector: values by label, NaN dropped, bad response throws', () => {
  const body = { status: 'success', data: { resultType: 'vector', result: [
    { metric: { job: 'server' }, value: [1, '1'] as [number, string] },
    { metric: { job: 'worker' }, value: [1, 'NaN'] as [number, string] },
  ] } };
  expect(parseVector(body, 'job')).toEqual({ server: 1 });
  expect(parseVector({ status: 'success', data: { resultType: 'vector', result: [] } })).toEqual({});
  expect(() => parseVector({ status: 'error' })).toThrow();
});

test('queries: the build label is sanitized, the window is at least a minute', () => {
  const q = queries('abc"}or vector(1)', 10);
  expect(q.reqs).toBe('sum(increase(relay_http_requests_total{build="abcorvector1"}[60s]))');
  expect(queries('deadbeef', 3600).err5xx).toContain('[3600s]');
});

test('args: sha only, positive minutes', () => {
  expect(args(['--build', 'deadbeef1', '--minutes', '10'])).toMatchObject({ build: 'deadbeef1', base: '', minutes: 10, interval: 30, strict: false });
  expect(args(['--build', 'deadbeef1', '--base', 'cafe1234', '--minutes', '2', '--strict'])?.strict).toBe(true);
  expect(args(['--build', 'not a sha', '--minutes', '10'])).toBeNull();
  expect(args(['--build', 'deadbeef1', '--minutes', '0'])).toBeNull();
});
