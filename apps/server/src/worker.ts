import { sql } from './db';
import './jobs/kinds';
import { ensurePeriodic } from './jobs/queue';
import { startWorker } from './jobs/worker';
import { scheduleReindexIfStale } from './search/messagesIndex';

// одна на всю систему, сколько бы воркеров ни было
await ensurePeriodic('sessions.sweep');
await ensurePeriodic('uploads.sweep');
// индекс поиска не той версии или ещё не построен — перестройка (до её конца поиск идёт по Postgres)
await scheduleReindexIfStale().catch((e) => console.error('search: cannot schedule reindex:', e));

// Процесс-воркер: выполняет задачи из jobs. Можно запускать несколько — skip locked делит работу.
// Видео (ffmpeg, минуты на файл) — своим циклом: не задерживает пачку остальных задач, параллельно не больше
// VIDEO_CONCURRENCY на процесс, аренда час (дольше одного запуска ffmpeg, см. jobs/video.ts).
const LONG = ['video.process'];
const main = startWorker({ concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10), kinds: { except: LONG } });
const video = startWorker({ concurrency: Number(process.env.VIDEO_CONCURRENCY ?? 1), leaseSec: 3600, kinds: { only: LONG } });
const worker = { stop: () => Promise.all([main.stop(), video.stop()]) };
console.log('relay worker started');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    await worker.stop();
    await sql.end();
    process.exit(0);
  });
}
