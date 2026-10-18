import { sql } from './db';
import './jobs/kinds';
import { ensurePeriodic } from './jobs/queue';
import { startWorker } from './jobs/worker';

await ensurePeriodic('sessions.sweep');   // одна на всю систему, сколько бы воркеров ни было

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
