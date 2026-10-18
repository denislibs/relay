import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { backoffMs, claim, complete, enqueue, ensurePeriodic, fail } from '../src/jobs/queue';
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
