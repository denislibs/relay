import { sql } from '../db';
import { jobsDead, jobsLag, jobsReady } from './appMetrics';
import { onCollect } from './metrics';

/**
 * Очередь задач при опросе метрик (только процесс-воркер, чтобы серверы не множили одни и те же серии):
 * готовые задачи и возраст самой старой по kind, задачи в jobs_dead за сутки. Аренда не истекла — задача в работе,
 * не в очереди. Пустая очередь — серий нет: панели и правила берут sum(...) or vector(0).
 */
export function collectQueueMetrics(): void {
  onCollect(async () => {
    const [ready, dead] = await Promise.all([
      sql`select kind, count(*)::int as n, coalesce(extract(epoch from now() - min(run_at)), 0)::float8 as lag
            from jobs where run_at <= now() and (locked_until is null or locked_until < now()) group by kind`,
      sql`select kind, count(*)::int as n from jobs_dead where failed_at > now() - interval '24 hours' group by kind`,
    ]);
    jobsReady.reset(); jobsLag.reset(); jobsDead.reset();
    for (const r of ready) { jobsReady.set({ kind: r.kind as string }, Number(r.n)); jobsLag.set({ kind: r.kind as string }, Number(r.lag)); }
    for (const r of dead) jobsDead.set({ kind: r.kind as string }, Number(r.n));
  });
}
