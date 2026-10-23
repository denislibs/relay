import { sql, type Tx } from '../db';

/**
 * Очередь задач в Postgres (transactional outbox). Задача ставится в транзакции изменения данных;
 * pg_notify('jobs') уходит только после коммита и будит воркеры. Доставка «как минимум один раз»:
 * обработчик может выполниться повторно (истекла аренда, процесс упал до complete).
 */
export type Db = Tx | typeof sql;
export interface Job { id: number; kind: string; payload: Record<string, unknown>; attempts: number; maxAttempts: number }

export const LEASE_SEC = 300;
const BACKOFF_CAP_MS = 600_000;

export async function enqueue(db: Db, kind: string, payload: object, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}): Promise<void> {
  await db`
    insert into jobs (kind, payload, run_at, dedupe_key, max_attempts)
    values (${kind}, ${db.json(payload as never)}, coalesce(${opts.runAt ?? null}::timestamptz, now()), ${opts.dedupeKey ?? null}, ${opts.maxAttempts ?? 8})
    on conflict (dedupe_key) where dedupe_key is not null do nothing`;
  await db`select pg_notify('jobs', ${kind})`;
}

/** Периодическая задача: ровно одна строка на kind; после выполнения обработчик переносит её вперёд (complete с again). */
export function ensurePeriodic(kind: string): Promise<void> {
  return enqueue(sql, kind, {}, { dedupeKey: kind });
}

/** Какие задачи берёт цикл: only — только эти kind, except — все, кроме этих (долгие видео идут своим циклом). */
export interface KindFilter { only?: string[]; except?: string[] }

/** Забрать до limit готовых задач: аренда на leaseSec, attempts + 1. Параллельные воркеры не берут одно и то же. */
export async function claim(limit: number, leaseSec = LEASE_SEC, kinds: KindFilter = {}): Promise<Job[]> {
  const only = kinds.only ?? null, except = kinds.except ?? [];
  const rows = await sql`
    with next as (
      select id from jobs
       where run_at <= now() and (locked_until is null or locked_until < now())
         and (${only}::text[] is null or kind = any(${only}::text[])) and not (kind = any(${except}::text[]))
       order by run_at, id
       limit ${limit}
       for update skip locked)
    update jobs j set locked_until = now() + make_interval(secs => ${leaseSec}), attempts = j.attempts + 1
      from next where j.id = next.id
    returning j.id, j.kind, j.payload, j.attempts, j.max_attempts`;
  return rows.map((r) => ({ id: Number(r.id), kind: r.kind as string, payload: r.payload as Record<string, unknown>, attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts) }));
}

/** Готово: удалить (или перенести периодическую). Условие на attempts — аренду мог перехватить другой воркер. */
export async function complete(job: Job, again?: { inSec: number }): Promise<void> {
  if (again) {
    await sql`update jobs set run_at = now() + make_interval(secs => ${again.inSec}), attempts = 0, locked_until = null, last_error = null
              where id = ${job.id} and attempts = ${job.attempts}`;
    return;
  }
  await sql`delete from jobs where id = ${job.id} and attempts = ${job.attempts}`;
}

/**
 * Готово, пачкой: одна команда delete на все задачи вместо коммита на каждую. Условие на attempts — то же,
 * что в complete: задачу с перехваченной арендой не трогаем.
 */
export async function completeMany(jobs: Job[]): Promise<void> {
  if (!jobs.length) return;
  if (jobs.length === 1) { await complete(jobs[0]); return; }
  await sql`
    delete from jobs j using unnest(${jobs.map((x) => x.id)}::bigint[], ${jobs.map((x) => x.attempts)}::int[]) as d(id, attempts)
     where j.id = d.id and j.attempts = d.attempts`;
}

/** Пауза перед попыткой N+1: 1 с, 2 с, 4 с… не больше 10 минут, ±20 % чтобы повторы не шли стаей. */
export function backoffMs(attempts: number): number {
  const base = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** Ошибка обработчика: повтор позже, а без повтора или после лимита — в jobs_dead (без payload.secret). */
export async function fail(job: Job, err: unknown, opts: { retry: boolean } = { retry: true }): Promise<void> {
  const message = String(err instanceof Error ? err.message : err).slice(0, 2000);
  if (opts.retry && job.attempts < job.maxAttempts) {
    await sql`update jobs set run_at = now() + make_interval(secs => ${backoffMs(job.attempts) / 1000}), locked_until = null, last_error = ${message}
              where id = ${job.id} and attempts = ${job.attempts}`;
    return;
  }
  await sql.begin(async (tx) => {
    const moved = await tx`
      insert into jobs_dead (id, kind, payload, attempts, last_error, created_at)
      select id, kind, payload - 'secret', attempts, ${message}, created_at from jobs where id = ${job.id} and attempts = ${job.attempts}
      on conflict (id) do nothing
      returning id`;
    if (moved.length) await tx`delete from jobs where id = ${job.id}`;
  });
}
