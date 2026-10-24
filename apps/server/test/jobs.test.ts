import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { backoffMs, claim, complete, completeMany, enqueue, ensurePeriodic, fail } from '../src/jobs/queue';
import { PermanentError, register, registerBatch } from '../src/jobs/handlers';
import { drainJobs, startWorker } from '../src/jobs/worker';
import { resetDb } from './helpers';

beforeEach(resetDb);

const count = async (table: 'jobs' | 'jobs_dead') => (await sql`select count(*)::int as n from ${sql(table)}`)[0].n as number;

test('a job enqueued in a rolled-back transaction never exists', async () => {
  await sql.begin(async (tx) => {
    await enqueue(tx, 'test.noop', { a: 1 });
    throw new Error('rollback');
  }).catch(() => {});
  expect(await count('jobs')).toBe(0);
  await sql.begin((tx) => enqueue(tx, 'test.noop', { a: 2 }));
  expect(await count('jobs')).toBe(1);
});

test('claim leases a job: a second claim does not get it until the lease expires', async () => {
  await enqueue(sql, 'test.noop', {});
  const [job] = await claim(10, 1);
  expect(job).toMatchObject({ kind: 'test.noop', attempts: 1 });
  expect(await claim(10, 1)).toEqual([]);
  await Bun.sleep(1100);
  const [again] = await claim(10, 1);
  expect(again).toMatchObject({ id: job.id, attempts: 2 });
});

test('future run_at is not claimed', async () => {
  await enqueue(sql, 'test.noop', {}, { runAt: new Date(Date.now() + 60_000) });
  expect(await claim(10)).toEqual([]);
});

test('complete deletes; a stale worker (lease taken over) cannot complete', async () => {
  await enqueue(sql, 'test.noop', {});
  const [first] = await claim(10, 1);
  await Bun.sleep(1100);
  const [second] = await claim(10, 60);
  await complete(first);                 // попытка уже не его — ничего не удалит
  expect(await count('jobs')).toBe(1);
  await complete(second);
  expect(await count('jobs')).toBe(0);
});

test('fail reschedules with backoff, then moves to jobs_dead without the secret', async () => {
  await enqueue(sql, 'test.noop', { to: 'x', secret: { code: '123456' } }, { maxAttempts: 2 });
  const [j1] = await claim(10);
  await fail(j1, new Error('boom'));
  const [row] = await sql`select run_at > now() as later, locked_until, last_error from jobs`;
  expect(row).toMatchObject({ later: true, locked_until: null, last_error: 'boom' });
  await sql`update jobs set run_at = now()`;
  const [j2] = await claim(10);
  await fail(j2, new Error('boom again'));
  expect(await count('jobs')).toBe(0);
  const [dead] = await sql`select kind, payload, attempts, last_error from jobs_dead`;
  expect(dead).toMatchObject({ kind: 'test.noop', payload: { to: 'x' }, attempts: 2, last_error: 'boom again' });
});

test('fail without retry goes straight to jobs_dead', async () => {
  await enqueue(sql, 'test.noop', {});
  const [j] = await claim(10);
  await fail(j, new Error('bad request'), { retry: false });
  expect(await count('jobs')).toBe(0);
  expect(await count('jobs_dead')).toBe(1);
});

test('periodic: ensurePeriodic keeps one job; complete with again reschedules and resets attempts', async () => {
  await ensurePeriodic('test.tick');
  await ensurePeriodic('test.tick');
  expect(await count('jobs')).toBe(1);
  const [j] = await claim(10);
  await complete(j, { inSec: 3600 });
  const [row] = await sql`select attempts, locked_until, run_at > now() + interval '59 minutes' as later from jobs`;
  expect(row).toEqual({ attempts: 0, locked_until: null, later: true });
});

test('backoff grows and is capped at 10 minutes', () => {
  expect(backoffMs(1)).toBeLessThan(1300);
  expect(backoffMs(5)).toBeGreaterThan(12_000);
  expect(backoffMs(30)).toBeLessThanOrEqual(720_000);
});

test('drainJobs runs handlers, including jobs they enqueue', async () => {
  const seen: number[] = [];
  register('test.chain', async (p: { n: number }) => {
    seen.push(p.n);
    if (p.n < 3) await enqueue(sql, 'test.chain', { n: p.n + 1 });
  });
  await enqueue(sql, 'test.chain', { n: 1 });
  expect(await drainJobs()).toBe(3);
  expect(seen).toEqual([1, 2, 3]);
  expect(await count('jobs')).toBe(0);
});

test('a throwing handler is retried later; PermanentError and unknown kinds are dead at once', async () => {
  let calls = 0;
  register('test.flaky', async () => { calls++; if (calls === 1) throw new Error('503'); });
  register('test.bad', async () => { throw new PermanentError('400'); });
  await enqueue(sql, 'test.flaky', {});
  await enqueue(sql, 'test.bad', {});
  await enqueue(sql, 'test.nobody', {});
  await drainJobs();
  expect(calls).toBe(1);
  expect((await sql`select kind from jobs_dead order by kind`).map((r) => r.kind)).toEqual(['test.bad', 'test.nobody']);
  await sql`update jobs set run_at = now()`;
  await drainJobs();
  expect(calls).toBe(2);
  expect(await count('jobs')).toBe(0);
});

test('a handler returning again reschedules a periodic job', async () => {
  register('test.tick', async () => ({ again: { inSec: 3600 } }));
  await ensurePeriodic('test.tick');
  await drainJobs();
  expect(await count('jobs')).toBe(1);
});

test('two workers take every job exactly once and wake on NOTIFY', async () => {
  const done: number[] = [];
  register('test.count', async (p: { i: number }) => { await Bun.sleep(5); done.push(p.i); });
  const w1 = startWorker({ concurrency: 5, pollMs: 60_000 });
  const w2 = startWorker({ concurrency: 5, pollMs: 60_000 });
  await Bun.sleep(100);                                  // оба успели подписаться на LISTEN
  await sql.begin(async (tx) => { for (let i = 0; i < 40; i++) await enqueue(tx, 'test.count', { i }); });
  for (let t = 0; t < 100 && done.length < 40; t++) await Bun.sleep(20);
  await Promise.all([w1.stop(), w2.stop()]);
  expect(done.length).toBe(40);
  expect(new Set(done).size).toBe(40);
});

test('completeMany deletes in one statement and skips jobs whose lease was taken over', async () => {
  for (let i = 0; i < 3; i++) await enqueue(sql, 'test.noop', { i });
  const first = await claim(10, 1);
  await Bun.sleep(1100);
  const [taken] = await claim(1, 60);                    // одну аренду перехватил другой воркер
  await completeMany(first);
  expect((await sql`select id from jobs`).map((r) => Number(r.id))).toEqual([taken.id]);
  await completeMany([]);
});

test('a batch handler gets every claimed job of its kind at once; drainJobs completes them together', async () => {
  const calls: number[][] = [];
  register('test.item', async () => { throw new Error('single path must not run'); });
  registerBatch('test.item', async (jobs) => { calls.push(jobs.map((j) => j.payload.i as number)); }, { max: 100 });
  await sql.begin(async (tx) => { for (let i = 0; i < 30; i++) await enqueue(tx, 'test.item', { i }); });
  expect(await drainJobs()).toBe(30);
  expect(calls.length).toBe(1);
  expect(calls[0].sort((x, y) => x - y)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  expect(await count('jobs')).toBe(0);
});

test('a failing batch falls back to one job at a time: a poison job does not hold back the rest', async () => {
  const single: number[] = [];
  register('test.poison', async (p: { i: number }) => {
    if (p.i === 3) throw new PermanentError('bad row');
    single.push(p.i);
  });
  registerBatch('test.poison', async () => { throw new Error('batch failed'); }, { max: 100 });
  await sql.begin(async (tx) => { for (let i = 0; i < 6; i++) await enqueue(tx, 'test.poison', { i }); });
  await drainJobs();
  expect(single.sort()).toEqual([0, 1, 2, 4, 5]);
  expect(await count('jobs')).toBe(0);
  expect((await sql`select payload from jobs_dead`).map((r) => r.payload.i)).toEqual([3]);
});

test('the worker is pipelined: a slow job does not hold a batch of fast ones; batch kinds run alongside', async () => {
  const done: string[] = [];
  register('test.slow', async () => { await Bun.sleep(800); done.push('slow'); });
  register('test.fast', async (p: { i: number }) => { await Bun.sleep(10); done.push(`fast${p.i}`); });
  registerBatch('test.many', async (jobs) => { for (const j of jobs) done.push(`many${j.payload.i}`); }, { max: 50 });
  const w = startWorker({ concurrency: 2, pollMs: 60_000 });
  await Bun.sleep(100);
  await sql.begin(async (tx) => {
    await enqueue(tx, 'test.slow', {});
    for (let i = 0; i < 20; i++) await enqueue(tx, 'test.fast', { i });
    for (let i = 0; i < 20; i++) await enqueue(tx, 'test.many', { i });
  });
  for (let t = 0; t < 100 && done.length < 41; t++) await Bun.sleep(20);
  await w.stop();
  expect(done.length).toBe(41);
  // с одним медленным в работе вторая «полоса» успела все 20 быстрых, до того как он закончил
  expect(done.indexOf('slow')).toBe(40);
  expect(await count('jobs')).toBe(0);
});

test('stop waits for jobs in flight and their completion', async () => {
  register('test.wait', async () => { await Bun.sleep(200); });
  const w = startWorker({ concurrency: 4, pollMs: 60_000 });
  await Bun.sleep(100);
  await sql.begin(async (tx) => { for (let i = 0; i < 4; i++) await enqueue(tx, 'test.wait', { i }); });
  await Bun.sleep(100);
  await w.stop();
  expect(await count('jobs')).toBe(0);
});

test('enqueue wakes workers only for a job that is new and due: no NOTIFY on a dedupe hit or a future runAt', async () => {
  const got: string[] = [];
  const l = await sql.listen('jobs', (p) => { got.push(p); });
  try {
    await enqueue(sql, 'test.noop', {}, { dedupeKey: 'win:1' });
    await enqueue(sql, 'test.noop', {}, { dedupeKey: 'win:1' });                        // повтор ключа — задача уже стоит
    await enqueue(sql, 'test.noop', {}, { runAt: new Date(Date.now() + 60_000) });      // ещё не созрела
    await sql.begin(async (tx) => { await enqueue(tx, 'test.later', {}, { dedupeKey: 'w2', runAt: new Date(Date.now() + 60_000) }); });
    await Bun.sleep(200);
    expect(got).toEqual(['test.noop']);
    expect(await count('jobs')).toBe(3);
  } finally {
    await l.unlisten();
  }
});

test('an idle worker sleeps until the nearest delayed job, not the whole poll', async () => {
  let ranAt = 0;
  register('test.delayed', async () => { ranAt = Date.now(); });
  register('test.noop2', async () => {});
  const w = startWorker({ concurrency: 2, pollMs: 60_000 });
  try {
    await Bun.sleep(100);   // воркер уснул на пустой очереди
    const t0 = Date.now();
    await enqueue(sql, 'test.delayed', {}, { runAt: new Date(t0 + 400) });   // без NOTIFY (не созрела)
    await enqueue(sql, 'test.noop2', {});   // NOTIFY: воркер проснётся, увидит отложенную и уснёт до неё, а не на poll
    for (let i = 0; i < 100 && !ranAt; i++) await Bun.sleep(20);
    expect(ranAt).toBeGreaterThan(0);
    expect(ranAt - t0).toBeGreaterThanOrEqual(350);
    expect(ranAt - t0).toBeLessThan(1500);
  } finally {
    await w.stop();
  }
});
