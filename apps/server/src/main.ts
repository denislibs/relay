import { createServer } from './http';
import { startRealtime } from './realtime';

const server = createServer({ port: Number(process.env.PORT ?? 3000) });
await startRealtime(server);
// автозавершение неактивных сеансов (и при каждом входе, см. auth.ts) и чистка брошенных загрузок —
// периодические задачи sessions.sweep и uploads.sweep в процессе-воркере
console.log(`relay server on :${server.port}`);
