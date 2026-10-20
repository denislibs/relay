import { sql } from './db';
import { SLOW_KINDS } from './jobs/kinds';
import { enqueue, ensurePeriodic } from './jobs/queue';
import { startWorker } from './jobs/worker';
import { startKeyEvents } from './crypto/keyEvents';
import { scheduleReindexIfStale } from './search/messagesIndex';

// одна на всю систему, сколько бы воркеров ни было
await ensurePeriodic('sessions.sweep');
await ensurePeriodic('uploads.sweep');
await ensurePeriodic('storage.gc');
await ensurePeriodic('crypto.rewrap');
// строки до шифрования (messageContent.ts): одна задача на запуск, дубль не встанет
await enqueue(sql, 'crypto.encrypt', {}, { dedupeKey: 'crypto.encrypt' });
// индекс поиска не той версии или ещё не построен — перестройка (до её конца поиск идёт по Postgres)
await scheduleReindexIfStale().catch((e) => console.error('search: cannot schedule reindex:', e));

// Процесс-воркер: выполняет задачи из jobs. Можно запускать несколько — skip locked делит работу.
// Видео (ffmpeg, минуты на файл) — своим циклом: не задерживает пачку остальных задач, параллельно не больше
// VIDEO_CONCURRENCY на процесс, аренда час (дольше одного запуска ffmpeg, см. jobs/video.ts).
// Превью фото (ffmpeg, секунды) — тоже своим циклом, по PHOTO_CONCURRENCY: поток загрузок фото не забивает общий.
const main = startWorker({ concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10), kinds: { except: [...SLOW_KINDS.video, ...SLOW_KINDS.photo] } });
const video = startWorker({ concurrency: Number(process.env.VIDEO_CONCURRENCY ?? 1), leaseSec: 3600, kinds: { only: SLOW_KINDS.video } });
const photo = startWorker({ concurrency: Number(process.env.PHOTO_CONCURRENCY ?? 2), kinds: { only: SLOW_KINDS.photo } });
const worker = { stop: () => Promise.all([main.stop(), video.stop(), photo.stop()]) };
await startKeyEvents();   // уничтоженный ключ чата забывается в памяти сразу
console.log('relay worker started');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    await worker.stop();
    await sql.end();
    process.exit(0);
  });
}
