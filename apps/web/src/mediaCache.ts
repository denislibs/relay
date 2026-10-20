// Файлы вложений на устройстве. Тела лежат в Cache Storage, сведения о них — в индексе IndexedDB
// (attachmentsOnDevice.ts). Ключ файла в кэше — /files/<id>: файл по id не меняется, подписанная ссылка хранилища
// в кэш не попадает. Два ящика:
//   relay-attachments-auto-evictable — то, что подгрузилось само (лента, просмотренное видео, трек, автозагрузка):
//                                      уходит по сроку, по лимиту и когда браузеру не хватает места;
//   relay-attachments-saved-by-user  — то, что вы скачали кнопкой: само не удаляется, только очисткой в «Данные и память».
// Чужой пользователь на этом устройстве файлы не увидит: при выходе и при входе другим пользователем всё стирается
// (storageInfo.clearMediaCaches).

import { FILE_CHUNK, FILE_HEADER, chunkCount, fromBase64, importFileKey, openChunk, openFile, readHeader, sealedRange, variantKey, type FileHeader } from '@relay/protocol';
import {
  announceOnDeviceChanged, fileKeysStore, idbAttachmentIndex,
  type AttachmentBucket, type AttachmentIndex, type AttachmentOnDevice, type AutoCleanupPolicy,
} from './attachmentsOnDevice';

/** Код и стили сборки (sw.ts): `relay-app-shell@<сборка>`. */
export const CACHE_APP_SHELL_PREFIX = 'relay-app-shell@';
export const CACHE_ATTACHMENTS_AUTO = 'relay-attachments-auto-evictable';
export const CACHE_ATTACHMENTS_SAVED = 'relay-attachments-saved-by-user';
const CACHE_OF: Record<AttachmentBucket, string> = { 'auto-evictable': CACHE_ATTACHMENTS_AUTO, 'saved-by-user': CACHE_ATTACHMENTS_SAVED };

/** Прежние имена (до разделения на ящики) — переносятся при старте SW и удаляются. */
export const LEGACY_CACHES = { media: 'relay-media', meta: 'relay-meta', shellPrefix: 'relay-shell-' };

/** Само подгруженное крупнее — только HTTP-кэш браузера (скачанное кнопкой кладём любого размера). */
export const MAX_AUTO_FILE = 20 * 1024 * 1024;
const TOUCH_MS = 3600_000;                     // «открывали» пишем не чаще раза в час на файл
const OP_MS = 5000;                            // Cache API бывает задумчив (Safari): дольше — считаем промахом
const MB = 1024 * 1024;
/** Сколько свободного места держим сверх файла: не меньше 64 МБ и не меньше пятой части квоты. */
const headroom = (quota: number) => Math.max(64 * MB, quota * 0.2);

export const DEFAULT_POLICY: AutoCleanupPolicy = { keepAutoDays: 30, maxAutoMb: 0 };

type Estimate = () => Promise<{ usage?: number; quota?: number }>;
/** Всё, с чем работает кэш вложений: подменяется в тестах. */
export interface AttachmentStore {
  caches: Pick<CacheStorage, 'open' | 'delete' | 'has'>;
  index: AttachmentIndex;
  estimate?: Estimate;
  changed?: () => void;
  /** Ключи зашифрованных файлов (IndexedDB) и вопрос вкладке, если там ещё нет (только в Service Worker). */
  keys?: { get(id: string): Promise<string | undefined>; clear(): Promise<void> };
  askKey?: (id: string) => Promise<string | null>;
}

/** Хранилище этого origin — одинаковое на странице и в Service Worker. */
export function deviceStore(): AttachmentStore {
  const est = typeof navigator !== 'undefined' && navigator.storage?.estimate ? () => navigator.storage.estimate() : undefined;
  return { caches, index: idbAttachmentIndex, estimate: est, changed: announceOnDeviceChanged, keys: fileKeysStore };
}

const withTimeout = <T>(p: Promise<T>, ms = OP_MS): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('cache timeout')), ms))]);

/** Ключ файла в кэше: путь без параметров. fileId — «<uuid>», копия видео — «<uuid>/preview», «<uuid>/720»,
 *  кусок начала видео — «…@<смещение>». */
export const attachmentKey = (fileId: string): string => `/files/${fileId}`;
/** Адрес вложения, который просит страница: оригинал или копия видео. */
const FILE_PATH = /^\/files\/([0-9a-f-]{36}(?:\/(?:preview|720))?)$/;
/** Ключ в кэше: адрес вложения или кусок начала видео. */
const KEY_PATH = /^\/files\/([0-9a-f-]{36}(?:\/(?:preview|720))?(?:@\d+)?)$/;
const fileIdOf = (path: string): string | null => FILE_PATH.exec(path)?.[1] ?? null;
const keyIdOf = (path: string): string | null => KEY_PATH.exec(path)?.[1] ?? null;

/** Что кэшируем: GET вложения без параметров (download=1 — сохранение на диск) и без Range. */
export function isMediaRequest(req: Request, origin: string): boolean {
  if (req.method !== 'GET' || req.headers.has('range')) return false;
  const u = new URL(req.url);
  return u.origin === origin && !u.search && FILE_PATH.test(u.pathname);
}

/**
 * Запрос части вложения (видео, аудио): GET /files/<id>[/вариант] с Range. Каждый кусок идёт через /files/… и
 * получает свежую подписанную ссылку (перемотка после истечения не ломается). Начало видео SW отдаёт из своего
 * кэша кусков (serveVideoRange), остальное — сеть как есть. Скачанное целиком играет по blob: (downloads.useOfflineUrl).
 */
export function isMediaRangeRequest(req: Request, origin: string): boolean {
  if (req.method !== 'GET' || !req.headers.has('range')) return false;
  const u = new URL(req.url);
  return u.origin === origin && !u.search && FILE_PATH.test(u.pathname);
}

/**
 * Сеть для вложения: /files/<id> отвечает 302 на подписанную ссылку хранилища (другой origin). Запрос <img> идёт
 * в режиме no-cors, и после такого редиректа ответ непрозрачный — его нельзя ни измерить, ни сохранить. Поэтому
 * спрашиваем сами в режиме cors (хранилище отдаёт CORS-заголовки), cookie — только нашему origin. Не вышло
 * (хранилище без CORS) — исходный запрос как есть: картинка покажется, просто не попадёт в кэш.
 */
export function fetchMedia(req: Request, net: (r: Request) => Promise<Response> = fetch): Promise<Response> {
  return net(new Request(req.url, { mode: 'cors', credentials: 'same-origin', redirect: 'follow' })).catch(() => net(req));
}

/** Ответ для кэша: только тип и длина — никаких служебных заголовков, всё служебное в индексе. */
const bodyResponse = (body: Blob, mimeType: string): Response =>
  new Response(body, { status: 200, statusText: 'OK', headers: { 'content-type': mimeType || 'application/octet-stream', 'content-length': String(body.size) } });

/** Файл на устройстве: запись индекса и ответ из её ящика. Запись есть, а файла нет (вытеснил браузер) — забываем запись. */
export async function findOnDevice(store: AttachmentStore, fileId: string): Promise<{ rec: AttachmentOnDevice; response: Response } | null> {
  const rec = await withTimeout(store.index.get(fileId)).catch(() => undefined);
  if (!rec) return null;
  const cache = await withTimeout(store.caches.open(CACHE_OF[rec.bucket])).catch(() => null);
  const response = cache ? await withTimeout(cache.match(attachmentKey(fileId))).catch(() => undefined) : undefined;
  if (!response) {
    if (cache) { await store.index.delete([fileId]).catch(() => {}); store.changed?.(); }
    return null;
  }
  return { rec, response };
}

export async function readAttachment(store: AttachmentStore, fileId: string): Promise<Blob | null> {
  const hit = await findOnDevice(store, fileId);
  return hit ? hit.response.blob() : null;
}

const touch = (store: AttachmentStore, rec: AttachmentOnDevice, now: number): Promise<void> | null =>
  now - rec.lastOpenedAt < TOUCH_MS ? null : store.index.put({ ...rec, lastOpenedAt: now }).catch(() => {});

/**
 * Ответ на запрос вложения в SW. background — то, что SW должен дождаться (event.waitUntil): запись в кэш
 * или отметка «открывали». Любая ошибка кэша — промах, идём в сеть.
 */
export async function serveMedia(store: AttachmentStore, req: Request, net: (r: Request) => Promise<Response>, now = Date.now(), raw: Uint8Array | null = null):
  Promise<{ response: Response; background: Promise<unknown> | null; stored: boolean }> {
  const fileId = fileIdOf(new URL(req.url).pathname);
  const hit = fileId ? await findOnDevice(store, fileId).catch(() => null) : null;
  if (hit) return { response: hit.response, background: touch(store, hit.rec, now), stored: false };
  // зашифрованный (ключ известен): шифр из сети → открытый текст; на устройстве — тоже открытый
  if (raw && fileId) return serveEncrypted(store, req, raw, net, now);
  const res = await net(req);
  const len = Number(res.headers.get('content-length'));
  if (!fileId || res.status !== 200 || res.type === 'opaque' || !(len > 0) || len > MAX_AUTO_FILE) return { response: res, background: null, stored: false };
  const copy = res.clone();
  const background = copy.blob()
    .then((b) => (b.size <= MAX_AUTO_FILE ? putAttachment(store, fileId, b, 'auto-evictable', now) : false))
    .catch(() => false);
  return { response: res, background, stored: true };
}

/* ---------- начало видео: куски в кэше (как progressive у Telegram Web A) ----------
   Плеер просит «с байта X и до конца». Если X в первых VIDEO_START_BYTES, SW качает кусок по сетке CHUNK
   (с границы, кратной CHUNK), кладёт его в auto-evictable и отдаёт плееру 206 с честным Content-Range — плеер
   прочитает кусок и попросит следующий. Повторное открытие стартует мгновенно и даже без сети; дальше — сеть
   и обычная буферизация браузера (он грузит вперёд понемногу, не весь файл).
   Ответ плееру собирается заново из байтов (не отдаём закэшированный Response как есть): так Chrome перематывает.
   Хранилище обязано отдавать Content-Range по CORS (Access-Control-Expose-Headers) — иначе полный размер не
   узнать, и SW просто пропускает запрос в сеть, как без кэша. */
export const VIDEO_START_BYTES = 2 * 1024 * 1024;
export const VIDEO_CHUNK = 512 * 1024;

const RANGE = /^bytes=(\d+)-(\d*)$/;
const partial = (body: ArrayBuffer, start: number, fullSize: number, mime: string): Response =>
  new Response(body, { status: 206, statusText: 'Partial Content', headers: {
    'content-type': mime, 'content-length': String(body.byteLength), 'accept-ranges': 'bytes',
    'content-range': `bytes ${start}-${start + body.byteLength - 1}/${fullSize}`,
  } });

/**
 * Ответ на Range-запрос видео. pass — запрос как есть в сеть (через /files/…: свежая ссылка). chunk — запрос куска
 * в режиме cors, чтобы прочитать байты и Content-Range. background — запись куска в кэш или отметка «открывали».
 */
export async function serveVideoRange(store: AttachmentStore, req: Request, pass: (r: Request) => Promise<Response>, chunk: (url: string, range: string) => Promise<Response>, now = Date.now()):
  Promise<{ response: Response; background: Promise<unknown> | null }> {
  const fileId = fileIdOf(new URL(req.url).pathname);
  const m = RANGE.exec(req.headers.get('range') ?? '');
  const start = m ? Number(m[1]) : NaN;
  if (!fileId || !m || !(start < VIDEO_START_BYTES)) return { response: await pass(req), background: null };
  const want = m[2] ? Number(m[2]) : Infinity;
  const offset = start - (start % VIDEO_CHUNK);
  const chunkId = `${fileId}@${offset}`;
  let bytes: ArrayBuffer, fullSize: number, mime: string, background: Promise<unknown> | null = null;
  const hit = await findOnDevice(store, chunkId).catch(() => null);
  if (hit?.rec.chunkOf) {
    bytes = await hit.response.arrayBuffer();
    fullSize = hit.rec.chunkOf.fullSize;
    mime = hit.rec.mimeType;
    background = touch(store, hit.rec, now);
  } else {
    let res: Response;
    try { res = await chunk(req.url, `bytes=${offset}-${offset + VIDEO_CHUNK - 1}`); } catch { return { response: await pass(req), background: null }; }
    fullSize = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]);
    // не кусок (хранилище отдало файл целиком) или размер скрыт CORS — без кэша, как раньше
    if (res.status !== 206 || !(fullSize > 0)) { void res.body?.cancel().catch(() => {}); return { response: await pass(req), background: null }; }
    mime = res.headers.get('content-type') ?? 'video/mp4';
    bytes = await res.arrayBuffer();
    background = putChunk(store, chunkId, bytes, mime, offset, fullSize, now).catch(() => false);
  }
  const from = start - offset;
  const to = Math.min(bytes.byteLength, want === Infinity ? bytes.byteLength : want - offset + 1);
  if (from >= to) return { response: await pass(req), background };
  return { response: partial(bytes.slice(from, to), start, fullSize, mime), background };
}

async function putChunk(store: AttachmentStore, chunkId: string, bytes: ArrayBuffer, mimeType: string, offset: number, fullSize: number, now: number): Promise<boolean> {
  if (!(await makeRoom(store, bytes.byteLength))) return false;
  const cache = await withTimeout(store.caches.open(CACHE_ATTACHMENTS_AUTO));
  await withTimeout(cache.put(attachmentKey(chunkId), new Response(bytes, { headers: { 'content-type': mimeType, 'content-length': String(bytes.byteLength) } })), 30_000);
  await store.index.put({ fileId: chunkId, bucket: 'auto-evictable', sizeBytes: bytes.byteLength, mimeType, storedAt: now, lastOpenedAt: now, chunkOf: { offset, fullSize } });
  return true;
}

const isQuotaError = (e: unknown) => e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22);

/**
 * Положить файл целиком в ящик. Сначала освобождаем место (вытесняя только auto-evictable), при ошибке квоты —
 * освобождаем ещё и пробуем второй раз. Сохранённое кнопкой «поднимается» из auto-evictable в saved-by-user.
 * false — не влезло: файл просто не останется на устройстве.
 */
export async function putAttachment(store: AttachmentStore, fileId: string, body: Blob, bucket: AttachmentBucket, now = Date.now()): Promise<boolean> {
  const prev = await store.index.get(fileId).catch(() => undefined);
  if (prev?.bucket === 'saved-by-user' && bucket === 'auto-evictable') return true;   // уже сохранён вами — не понижаем
  if (!(await makeRoom(store, body.size, fileId))) return false;
  const mimeType = body.type || prev?.mimeType || 'application/octet-stream';
  const cache = await withTimeout(store.caches.open(CACHE_OF[bucket]));
  const write = () => withTimeout(cache.put(attachmentKey(fileId), bodyResponse(body, mimeType)), 120_000);
  try { await write(); } catch (e) {
    if (!isQuotaError(e)) return false;
    await evictAuto(store, body.size + 64 * MB, fileId);
    try { await write(); } catch { return false; }
  }
  await store.index.put({ fileId, bucket, sizeBytes: body.size, mimeType, storedAt: prev?.storedAt ?? now, lastOpenedAt: now });
  if (prev && prev.bucket !== bucket) await (await store.caches.open(CACHE_OF[prev.bucket])).delete(attachmentKey(fileId)).catch(() => {});
  store.changed?.();
  return true;
}

/** Хватит ли места под need байт с запасом; не хватает — вытесняем auto-evictable, давно не открытое первым. */
export async function makeRoom(store: AttachmentStore, need: number, keep?: string): Promise<boolean> {
  const e = await store.estimate?.().catch(() => null);
  if (!e?.quota || e.usage == null) return true;   // оценки нет — пробуем: Cache API сам откажет при нехватке
  const free = e.quota - e.usage;
  const want = need + headroom(e.quota);
  if (free >= want) return true;
  const freed = await evictAuto(store, want - free, keep);
  return free + freed >= need + 16 * MB;
}

/** Удалить из auto-evictable давно не открытое, пока не освободится bytes. Возвращает сколько освободили. */
async function evictAuto(store: AttachmentStore, bytes: number, keep?: string): Promise<number> {
  const auto = (await store.index.all().catch(() => [] as AttachmentOnDevice[]))
    .filter((r) => r.bucket === 'auto-evictable' && r.fileId !== keep)
    .sort((a, b) => a.lastOpenedAt - b.lastOpenedAt);
  const drop: AttachmentOnDevice[] = [];
  let freed = 0;
  for (const r of auto) { if (freed >= bytes) break; drop.push(r); freed += r.sizeBytes; }
  await removeRecords(store, drop);
  return freed;
}

async function removeRecords(store: AttachmentStore, recs: AttachmentOnDevice[]): Promise<void> {
  if (!recs.length) return;
  const byBucket = new Map<AttachmentBucket, Cache>();
  for (const r of recs) {
    let c = byBucket.get(r.bucket);
    if (!c) byBucket.set(r.bucket, (c = await store.caches.open(CACHE_OF[r.bucket])));
    await c.delete(attachmentKey(r.fileId)).catch(() => false);
  }
  await store.index.delete(recs.map((r) => r.fileId));
  store.changed?.();
}

/**
 * Сверка индекса с ящиками: запись без файла — удаляем, файл без записи (оборвалась запись индекса) — дописываем.
 * Тела не читаем: размер — из content-length.
 */
async function reconcile(store: AttachmentStore, now: number): Promise<AttachmentOnDevice[]> {
  const rows = new Map((await store.index.all()).map((r) => [r.fileId, r]));
  const seen = new Set<string>();
  let changed = false;
  for (const bucket of Object.keys(CACHE_OF) as AttachmentBucket[]) {
    const cache = await store.caches.open(CACHE_OF[bucket]);
    for (const key of await cache.keys()) {
      const fileId = keyIdOf(new URL(key.url).pathname);
      if (!fileId) continue;
      const row = rows.get(fileId);
      if (row && row.bucket === bucket) { seen.add(fileId); continue; }
      if (fileId.includes('@') && !row) { await cache.delete(key); continue; }   // кусок без записи: размер файла не знаем — не нужен
      if (row?.bucket === 'saved-by-user') { await cache.delete(key); continue; }   // копия в auto при сохранённом — лишняя
      const res = await cache.match(key);
      const rec: AttachmentOnDevice = { fileId, bucket, sizeBytes: Number(res?.headers.get('content-length')) || 0, mimeType: res?.headers.get('content-type') ?? '', storedAt: now, lastOpenedAt: now };
      if (row) await store.caches.open(CACHE_OF[row.bucket]).then((c) => c.delete(key)).catch(() => false);   // запись в другом ящике: верим файлу
      await store.index.put(rec);
      rows.set(fileId, rec);
      seen.add(fileId);
      changed = true;
    }
  }
  const lost = [...rows.keys()].filter((id) => !seen.has(id));
  if (lost.length) { await store.index.delete(lost); changed = true; }
  if (changed) store.changed?.();
  return [...rows.values()].filter((r) => seen.has(r.fileId));
}

/**
 * Очистка auto-evictable: сначала всё, что не открывали дольше keepAutoDays, затем — давно не открытое, пока ящик
 * не уложится в maxAutoMb. saved-by-user не трогаем. Возвращает сколько удалили и сколько весит auto-evictable.
 */
export async function sweepAuto(store: AttachmentStore, policy: AutoCleanupPolicy, now = Date.now()): Promise<{ removed: number; autoBytes: number }> {
  const auto = (await reconcile(store, now)).filter((r) => r.bucket === 'auto-evictable');
  const ttl = policy.keepAutoDays > 0 ? policy.keepAutoDays * 24 * 3600_000 : Infinity;
  const expired = auto.filter((r) => now - r.lastOpenedAt > ttl);
  const live = auto.filter((r) => now - r.lastOpenedAt <= ttl).sort((a, b) => a.lastOpenedAt - b.lastOpenedAt);
  let autoBytes = live.reduce((n, r) => n + r.sizeBytes, 0);
  const max = policy.maxAutoMb > 0 ? policy.maxAutoMb * MB : Infinity;
  const over: AttachmentOnDevice[] = [];
  for (const r of live) { if (autoBytes <= max) break; over.push(r); autoBytes -= r.sizeBytes; }
  await removeRecords(store, [...expired, ...over]);
  return { removed: expired.length + over.length, autoBytes };
}

export async function loadPolicy(store: AttachmentStore): Promise<AutoCleanupPolicy> {
  try {
    const p = await store.index.getPolicy();
    const n = (v: unknown, d: number) => (v != null && Number(v) >= 0 ? Number(v) : d);
    return { keepAutoDays: n(p?.keepAutoDays, DEFAULT_POLICY.keepAutoDays), maxAutoMb: n(p?.maxAutoMb, DEFAULT_POLICY.maxAutoMb) };
  } catch { return DEFAULT_POLICY; }
}

export const savePolicy = (store: AttachmentStore, p: AutoCleanupPolicy): Promise<void> => store.index.setPolicy(p);

/** Стереть все файлы вложений и индекс (выход, вход другим пользователем, «Очистить кэш медиа»). */
export async function clearAllAttachments(store: AttachmentStore): Promise<void> {
  await Promise.all([CACHE_ATTACHMENTS_AUTO, CACHE_ATTACHMENTS_SAVED, LEGACY_CACHES.media].map((n) => store.caches.delete(n).catch(() => false)));
  await store.index.clear().catch(() => {});
  await store.keys?.clear().catch(() => {});   // и ключи зашифрованных файлов
  store.changed?.();
}

/**
 * Перенос кэша прежнего устройства (`relay-media` с заголовками x-relay-saved/x-relay-used, политика в `relay-meta`):
 * файлы — в auto-evictable с теми же отметками времени, политика — в индекс. Тело переносится потоком, без чтения в память.
 */
export async function migrateLegacyCaches(store: AttachmentStore, now = Date.now()): Promise<number> {
  let moved = 0;
  if (await store.caches.has(LEGACY_CACHES.meta).catch(() => false)) {
    try {
      const res = await (await store.caches.open(LEGACY_CACHES.meta)).match('/__relay/media-policy');
      const p = res ? (await res.json()) as { keepDays?: number; maxMb?: number } : null;
      if (p) await store.index.setPolicy({ keepAutoDays: Number(p.keepDays) >= 0 ? Number(p.keepDays) : DEFAULT_POLICY.keepAutoDays, maxAutoMb: Number(p.maxMb) >= 0 ? Number(p.maxMb) : 0 });
    } catch { /* политика по умолчанию */ }
    await store.caches.delete(LEGACY_CACHES.meta).catch(() => false);
  }
  if (!(await store.caches.has(LEGACY_CACHES.media).catch(() => false))) return 0;
  const old = await store.caches.open(LEGACY_CACHES.media);
  const auto = await store.caches.open(CACHE_ATTACHMENTS_AUTO);
  for (const key of await old.keys()) {
    const fileId = fileIdOf(new URL(key.url).pathname);
    const res = fileId ? await old.match(key) : undefined;
    if (!fileId || !res || (await store.index.get(fileId))) continue;
    const sizeBytes = Number(res.headers.get('content-length')) || 0;
    const mimeType = res.headers.get('content-type') ?? 'application/octet-stream';
    const at = (h: string) => Number(res.headers.get(h)) || now;
    try {
      await auto.put(attachmentKey(fileId), new Response(res.body, { headers: { 'content-type': mimeType, 'content-length': String(sizeBytes) } }));
      await store.index.put({ fileId, bucket: 'auto-evictable', sizeBytes, mimeType, storedAt: at('x-relay-saved'), lastOpenedAt: at('x-relay-used') });
      moved++;
    } catch { /* не влезло — пропускаем */ }
  }
  await store.caches.delete(LEGACY_CACHES.media).catch(() => false);
  if (moved) store.changed?.();
  return moved;
}


/* ---------- зашифрованные вложения (packages/protocol/src/fileCrypto.ts) ----------
   В хранилище — шифр; ключ файла знает клиент (из сообщения). SW расшифровывает: целый файл — для <img> и роликов,
   куски — для Range плеера (перемотка). В кэш устройства кладётся открытый текст. Копия (preview, 720) — ключом,
   выведенным из ключа файла. Ключа нет (публичный файл: аватар, музыка профиля) — файл открытый, как раньше. */

const keyCache = new Map<string, Uint8Array | null>();   // «id файла» → сырой ключ; null — проверено: ключа нет

/** Сырой ключ для пути /files/<id>[/вариант]: память → IndexedDB → вопрос вкладке. null — файл не зашифрован. */
export async function fileKeyOf(store: AttachmentStore, fileId: string): Promise<Uint8Array | null> {
  const [base, variant] = fileId.split('/');
  let raw = keyCache.get(base);
  if (raw === undefined) {
    const b64 = (await store.keys?.get(base).catch(() => undefined)) ?? (await store.askKey?.(base).catch(() => null)) ?? null;
    raw = b64 ? fromBase64(b64) : null;
    keyCache.set(base, raw);
    if (keyCache.size > 5000) keyCache.delete(keyCache.keys().next().value!);
  }
  if (!raw) return null;
  return variant ? variantKey(raw, variant) : raw;
}
/** Тесты и выход: забыть ключи в памяти SW. */
export function resetFileKeyCache(): void { keyCache.clear(); headers.clear(); }

const MAGIC: [number[], string, number][] = [
  [[0xff, 0xd8, 0xff], 'image/jpeg', 0], [[0x89, 0x50, 0x4e, 0x47], 'image/png', 0], [[0x47, 0x49, 0x46, 0x38], 'image/gif', 0],
  [[0x57, 0x45, 0x42, 0x50], 'image/webp', 8], [[0x66, 0x74, 0x79, 0x70], 'video/mp4', 4], [[0x1a, 0x45, 0xdf, 0xa3], 'video/webm', 0],
  [[0x4f, 0x67, 0x67, 0x53], 'audio/ogg', 0], [[0x49, 0x44, 0x33], 'audio/mpeg', 0],
];
/** Тип по первым байтам: объект в хранилище — octet-stream, а <img>/<video> нужен настоящий. */
export function sniffMime(b: Uint8Array): string {
  for (const [sig, type, at] of MAGIC) if (sig.every((x, i) => b[at + i] === x)) return type;
  return 'application/octet-stream';
}

/** Целый зашифрованный файл: шифр из сети → открытый текст (ответ 200 и запись в кэш). */
export async function serveEncrypted(store: AttachmentStore, req: Request, raw: Uint8Array, net: (r: Request) => Promise<Response>, now = Date.now()):
  Promise<{ response: Response; background: Promise<unknown> | null; stored: boolean }> {
  const fileId = fileIdOf(new URL(req.url).pathname)!;
  const res = await net(req);
  if (res.status !== 200 || res.type === 'opaque') return { response: res, background: null, stored: false };
  const sealed = await res.blob();
  const plainNoType = await openFile(sealed, await importFileKey(raw));
  const type = sniffMime(new Uint8Array(await plainNoType.slice(0, 16).arrayBuffer()));
  const plain = new Blob([plainNoType], { type });
  const background = plain.size <= MAX_AUTO_FILE ? putAttachment(store, fileId, plain, 'auto-evictable', now).catch(() => false) : null;
  return { response: new Response(plain, { status: 200, headers: { 'content-type': type, 'content-length': String(plain.size) } }), background, stored: !!background };
}

const headers = new Map<string, FileHeader>();   // путь → заголовок объекта (размер, сетка)
const ENC_RANGE_MAX = 2 * FILE_CHUNK;            // за один ответ — не больше двух кусков: плеер попросит следующие

/**
 * Range зашифрованного файла: нужные куски шифра из сети (или открытые из кэша), расшифровка, ответ 206 с исходным
 * размером. Начало (первые VIDEO_START_BYTES) кэшируется кусками, как у открытых файлов.
 */
export async function serveEncryptedRange(store: AttachmentStore, req: Request, raw: Uint8Array, chunk: (url: string, range: string) => Promise<Response>, now = Date.now()):
  Promise<{ response: Response; background: Promise<unknown> | null }> {
  const fileId = fileIdOf(new URL(req.url).pathname)!;
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('range') ?? '');
  const key = await importFileKey(raw);
  let h = headers.get(fileId);
  if (!h) {
    const r = await chunk(req.url, `bytes=0-${FILE_HEADER - 1}`);
    const got = readHeader(new Uint8Array(await r.arrayBuffer()));
    if (!got) return { response: new Response(null, { status: 502, statusText: 'not an encrypted file' }), background: null };
    h = got; headers.set(fileId, h);
  }
  const start = m ? Number(m[1]) : 0;
  if (start >= h.size) return { response: new Response(null, { status: 416, headers: { 'content-range': `bytes */${h.size}` } }), background: null };
  const want = m?.[2] ? Math.min(Number(m[2]), h.size - 1) : h.size - 1;
  const end = Math.min(want, start - (start % h.chunk) + ENC_RANGE_MAX - 1);
  const first = Math.floor(start / h.chunk), last = Math.min(chunkCount(h.size, h.chunk) - 1, Math.floor(end / h.chunk));
  const pieces: Uint8Array[] = [];
  const writes: Promise<unknown>[] = [];
  let mime = '';
  for (let i = first; i <= last; i++) {
    const offset = i * h.chunk, chunkId = `${fileId}@${offset}`;
    const hit = offset < VIDEO_START_BYTES ? await findOnDevice(store, chunkId).catch(() => null) : null;
    let plain: Uint8Array;
    if (hit?.rec.chunkOf) { plain = new Uint8Array(await hit.response.arrayBuffer()); mime = hit.rec.mimeType; }
    else {
      const [s, e] = sealedRange(h, i);
      const r = await chunk(req.url, `bytes=${s}-${e - 1}`);
      if (r.status !== 206 && r.status !== 200) return { response: new Response(null, { status: r.status }), background: null };
      plain = await openChunk(key, h, i, new Uint8Array(await r.arrayBuffer()));
      if (offset < VIDEO_START_BYTES) {
        const type = i === 0 ? sniffMime(plain) : (mime || 'application/octet-stream');
        writes.push(putChunk(store, chunkId, plain.slice().buffer as ArrayBuffer, type, offset, h.size, now).catch(() => false));
      }
    }
    if (i === 0) mime = sniffMime(plain);
    pieces.push(plain);
  }
  const joined = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of pieces) { joined.set(p, at); at += p.length; }
  const body = joined.slice(start - first * h.chunk, end - first * h.chunk + 1);
  return {
    response: new Response(body, { status: 206, statusText: 'Partial Content', headers: {
      'content-type': mime || 'application/octet-stream', 'content-length': String(body.length), 'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${start + body.length - 1}/${h.size}`,
    } }),
    background: writes.length ? Promise.all(writes) : null,
  };
}
