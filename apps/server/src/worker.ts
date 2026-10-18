import { sql } from './db';
import './jobs/kinds';
import { ensurePeriodic } from './jobs/queue';
import { startWorker } from './jobs/worker';
import { scheduleReindexIfStale } from './search/messagesIndex';

await ensurePeriodic('sessions.sweep');   // одна на всю систему, сколько бы воркеров ни было
// индекс поиска не той версии или ещё не построен — перестройка (до её конца поиск идёт по Postgres)
await scheduleReindexIfStale().catch((e) => console.error('search: cannot schedule reindex:', e));

// Процесс-воркер: выполняет задачи из jobs. Можно запускать несколько — skip locked делит работу.
const worker = startWorker({ concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10) });
console.log('relay worker started');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    await worker.stop();
    await sql.end();
    process.exit(0);
  });
}
