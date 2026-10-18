import { createServer } from './http';
import { startRealtime } from './realtime';
import { sweepPendingUploads } from './domain/files';

const server = createServer({ port: Number(process.env.PORT ?? 3000) });
const stopRealtime = await startRealtime(server);
// штатная остановка: процесс снимается из реестра онлайна сразу, а не через 90 с
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => { void stopRealtime().finally(() => process.exit(0)); });
}
// автозавершение неактивных сеансов — периодическая задача sessions.sweep в процессе-воркере (и при каждом входе, см. auth.ts)
// брошенные загрузки (pending старше суток): запись и объект в S3
const sweepUploads = () => { sweepPendingUploads().catch((e) => console.error('uploads sweep:', e)); };
sweepUploads();
setInterval(sweepUploads, 3600_000).unref();
console.log(`relay server on :${server.port}`);
