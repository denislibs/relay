import { createServer } from './http';
import { watchMigrations } from './migrate';
import { startRealtime } from './realtime';

// dev: новые миграции применяются сами, до первого запроса (см. watchMigrations)
if (process.env.DEV_MIGRATE === '1') await watchMigrations().ready;

const server = createServer({ port: Number(process.env.PORT ?? 3000) });
const stopRealtime = await startRealtime(server);
// штатная остановка: процесс снимается из реестра онлайна сразу, а не через 90 с
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => { void stopRealtime().finally(() => process.exit(0)); });
}
// автозавершение неактивных сеансов (и при каждом входе, см. auth.ts) и чистка брошенных загрузок —
// периодические задачи sessions.sweep и uploads.sweep в процессе-воркере
console.log(`relay server on :${server.port}`);
