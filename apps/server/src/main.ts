import { createServer } from './http';
import { initPeerKeys } from './crypto/peerKey';
import { watchMigrations } from './migrate';
import { startRealtime } from './realtime';
import { startKeyEvents } from './crypto/keyEvents';
import { hasStickerAssets, importStickers } from './stickers/import';

// dev: новые миграции применяются сами, до первого запроса (см. watchMigrations)
if (process.env.DEV_MIGRATE === '1') await watchMigrations().ready;

await initPeerKeys();   // ключи доступа к людям считаются синхронно — секрет нужен до первого запроса
const server = createServer({ port: Number(process.env.PORT ?? 3000) });
const stopRealtime = await startRealtime(server);
const stopKeyEvents = await startKeyEvents();   // уничтоженный ключ чата забывается в памяти сразу
// штатная остановка: процесс снимается из реестра онлайна сразу, а не через 90 с
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => { void Promise.all([stopRealtime(), stopKeyEvents()]).finally(() => process.exit(0)); });
}
// автозавершение неактивных сеансов (и при каждом входе, см. auth.ts) и чистка брошенных загрузок —
// периодические задачи sessions.sweep и uploads.sweep в процессе-воркере
console.log(`relay server on :${server.port}`);
// стикерпаки из смонтированных ассетов: в фоне, неизменные паки пропускаются по хэшу
if (hasStickerAssets()) void importStickers().then((r) => console.log(`stickers: ${r.sets} packs, ${r.changed} imported`), (e) => console.error('stickers import:', e));
