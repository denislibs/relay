// Менеджер загрузок вложений, как в Telegram: большой файл качается частями (Range), кольцо с процентом и ×,
// обрыв сети — продолжаем с последнего полученного байта, истёкшая подписанная ссылка — берём новую у /files/<id>.
// Готовый файл отдаём пользователю (сохранить) и кладём целиком в кэш relay-media: второй раз «открыть» — мгновенно
// и без сети (SW отдаёт оттуда и картинки, и части видео). Ядро (downloadChunks) не знает про браузер — тесты гоняют
// его с подставным fetch.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ON_DEVICE_CHANNEL, fileKeysStore, type AttachmentBucket } from './attachmentsOnDevice';
import { encryptedSize, fromBase64, importFileKey, openFile } from '@relay/protocol';
import { keyFor } from './fileKeys';
import { deviceStore, putAttachment, readAttachment } from './mediaCache';
import { requestPersistentStorage } from './storageInfo';

export const CHUNK = 8 * 1024 * 1024;
const MAX_FAILS = 8;          // подряд без единого нового байта — сдаёмся (офлайн не считается: ждём сеть)
const MAX_REFRESH = 3;        // подряд новых ссылок, и все отказали — это уже не срок, а доступ

export class DownloadError extends Error {
  constructor(public code: 'aborted' | 'not_found' | 'forbidden' | 'network' | 'bad_response', message: string = code) { super(message); }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ChunkOptions {
  /** /files/<id>?download=1 — отвечает 302 на подписанную ссылку хранилища */
  url: string;
  /** размер из вложения; нет — узнаем из первого ответа */
  size?: number;
  type?: string;
  chunk?: number;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  /** «ждём сеть» и обратно — для подписи под кольцом */
  onWaiting?: (waiting: boolean) => void;
  fetch?: Fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** офлайн — промис, который сбудется, когда сеть вернётся */
  online?: () => Promise<void> | null;
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(t); reject(new DownloadError('aborted')); };
  signal?.addEventListener('abort', stop, { once: true });
});

const defaultOnline = (): Promise<void> | null => (typeof navigator !== 'undefined' && navigator.onLine === false && typeof addEventListener === 'function'
  ? new Promise((r) => addEventListener('online', () => r(), { once: true })) : null);

/**
 * Скачать файл частями по chunk байт. Первый запрос идёт в /files/<id> (редирект на подписанную ссылку), дальше —
 * прямо по ссылке (res.url). 401/403/400 от хранилища — ссылка истекла: снова через /files/<id> мимо HTTP-кэша.
 * Обрыв посреди части — полученное не теряем, следующий запрос с того же байта.
 */
export async function downloadChunks(o: ChunkOptions): Promise<Blob> {
  const net = o.fetch ?? ((u, i) => fetch(u, i));
  const sleep = o.sleep ?? defaultSleep;
  const online = o.online ?? defaultOnline;
  const step = o.chunk ?? CHUNK;
  const parts: Blob[] = [];
  let total = o.size && o.size > 0 ? o.size : -1;
  let offset = 0, direct: string | null = null, fresh = false, fails = 0, refreshes = 0;
  const aborted = () => { if (o.signal?.aborted) throw new DownloadError('aborted'); };

  while (total < 0 || offset < total) {
    aborted();
    const end = total < 0 ? offset + step - 1 : Math.min(total, offset + step) - 1;
    const viaFiles = direct == null;
    let res: Response;
    try {
      res = await net(direct ?? o.url, {
        headers: { range: `bytes=${offset}-${end}` }, signal: o.signal,
        // к /files — с cookie и по редиректу; к хранилищу — без cookie
        credentials: viaFiles ? 'same-origin' : 'omit', mode: 'cors', redirect: 'follow',
        cache: viaFiles && fresh ? 'no-store' : 'default',
      });
    } catch (e) {
      if (o.signal?.aborted) throw new DownloadError('aborted');
      await backoff(++fails, e);
      continue;
    }
    if (res.status === 404 || res.status === 410) throw new DownloadError('not_found');
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      // ссылка истекла (или кэш браузера отдал старый редирект): новая — мимо кэша
      if (++refreshes > MAX_REFRESH) throw new DownloadError('forbidden');
      direct = null; fresh = true;
      continue;
    }
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      await res.body?.cancel().catch(() => {});
      await backoff(++fails, new Error('HTTP ' + res.status));
      continue;
    }
    if (res.status !== 206 && res.status !== 200) throw new DownloadError('bad_response', 'HTTP ' + res.status);
    if (viaFiles && res.redirected && res.url) { direct = res.url; fresh = false; }
    if (res.status === 200) {
      // диапазон не поняли — пришёл весь файл: начинаем с нуля
      parts.length = 0; offset = 0;
      const len = Number(res.headers.get('content-length'));
      if (len > 0) total = len;
    } else if (total < 0) {
      const m = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
      if (m) total = Number(m[1]);
    }
    const before = offset;
    try {
      offset += await readBody(res, parts, (n) => o.onProgress?.(offset + n, Math.max(total, offset + n)), o.signal);
    } catch (e) {
      if (o.signal?.aborted) throw new DownloadError('aborted');
      // оборвалось посреди части: что успели — уже в parts (readBody кладёт и неполное)
      offset += (e as { got?: number }).got ?? 0;
      if (offset > before) { fails = 0; refreshes = 0; }
      await backoff(++fails, e);
      continue;
    }
    if (offset > before) { fails = 0; refreshes = 0; }
    o.onProgress?.(offset, Math.max(total, offset));
    if (res.status === 200) { total = offset; break; }
    // хранилище не знает размер, а часть пришла короче — это конец файла
    if (total < 0 && offset - before < end - before + 1) { total = offset; break; }
    if (offset === before) await backoff(++fails, new Error('empty part'));
  }
  return new Blob(parts, { type: o.type || 'application/octet-stream' });

  async function backoff(n: number, cause: unknown) {
    const wait = online();
    if (wait) {
      // нет сети — это не неудача: ждём её сколько угодно (пока не отменят)
      o.onWaiting?.(true);
      fails = 0;
      await Promise.race([wait, new Promise<void>((_, rej) => o.signal?.addEventListener('abort', () => rej(new DownloadError('aborted')), { once: true }))]);
      o.onWaiting?.(false);
      return;
    }
    if (n > MAX_FAILS) throw new DownloadError('network', String((cause as Error)?.message ?? cause));
    await sleep(Math.min(10_000, 400 * 2 ** (n - 1)), o.signal);
  }
}

/** Читает тело потоком: прогресс по ходу, при обрыве кладёт полученное в parts и бросает ошибку с полем got. */
async function readBody(res: Response, parts: Blob[], progress: (n: number) => void, signal?: AbortSignal): Promise<number> {
  if (!res.body) { const b = await res.blob(); parts.push(b); return b.size; }
  const reader = res.body.getReader();
  const pieces: Uint8Array[] = [];
  let got = 0;
  const flush = () => { if (pieces.length) { parts.push(new Blob(pieces as BlobPart[])); pieces.length = 0; } };
  try {
    for (;;) {
      if (signal?.aborted) { await reader.cancel().catch(() => {}); throw new DownloadError('aborted'); }
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push(value); got += value.byteLength;
      progress(got);
    }
  } catch (e) {
    flush();
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { got });
  }
  flush();
  return got;
}

/* ---------- менеджер: одна загрузка на файл, состояние для пузырей ---------- */

export type DownloadStatus = 'idle' | 'loading' | 'done' | 'error';
export interface DownloadState { status: DownloadStatus; loaded: number; total: number; waiting?: boolean; cached?: boolean; error?: string }
/** key — ключ зашифрованного файла (base64); нет — берётся из реестра ключей страницы (fileKeys.ts). */
export interface DownloadFile { id: string; name: string; mime: string; size: number; key?: string }

const IDLE: DownloadState = { status: 'idle', loaded: 0, total: 0 };
const states = new Map<string, DownloadState>();
const jobs = new Map<string, { ctrl: AbortController; promise: Promise<Blob | null> }>();
const listeners = new Map<string, Set<() => void>>();
/** Какие файлы лежат на устройстве и в каком ящике — из индекса; null — ещё не прочитали. */
let onDevice: Map<string, AttachmentBucket> | null = null;
let onDeviceLoading: Promise<void> | null = null;
const anyListeners = new Set<() => void>();

function set(id: string, s: DownloadState): void {
  states.set(id, s);
  listeners.get(id)?.forEach((f) => f());
}

export function getDownload(id: string): DownloadState {
  const s = states.get(id);
  if (s) return s;
  return onDevice?.has(id) ? { status: 'done', loaded: 0, total: 0, cached: true } : IDLE;
}

/** Список файлов на устройстве — из индекса (одна выборка, тела не трогаем). force — перечитать (сообщила другая вкладка или SW). */
function loadOnDevice(force = false): Promise<void> {
  if (typeof indexedDB === 'undefined') { onDevice ??= new Map(); return Promise.resolve(); }
  if (onDevice && !force) return Promise.resolve();
  if (!onDeviceLoading) {
    onDeviceLoading = (async () => {
      const map = new Map<string, AttachmentBucket>();
      try { for (const r of await deviceStore().index.all()) map.set(r.fileId, r.bucket); } catch { /* индекс недоступен — ничего не знаем */ }
      const was = onDevice;
      onDevice = map;
      // файла больше нет на устройстве — и «скачано» у пузыря тоже нет
      if (was) for (const id of was.keys()) if (!map.has(id) && states.get(id)?.status === 'done') states.delete(id);
      anyListeners.forEach((f) => f());
    })().finally(() => { onDeviceLoading = null; });
  }
  return onDeviceLoading;
}

// другая вкладка или Service Worker положили/удалили файлы — перечитываем список
try { new BroadcastChannel(ON_DEVICE_CHANNEL).onmessage = () => { if (onDevice) void loadOnDevice(true); }; } catch { /* нет BroadcastChannel */ }

/** Лежит ли файл целиком на устройстве; null — ещё не знаем (индекс читается). */
export function isCached(id: string): boolean | null {
  return onDevice ? onDevice.has(id) : null;
}
/** Прочитать индекс заранее (лента открылась): к нажатию на видео ответ уже готов. */
export function warmCached(): Promise<void> { return loadOnDevice(); }

/** Файлы вложений стёрли (Данные и память, выход): забываем, что там было. */
export function forgetCached(): void {
  onDevice = new Map();
  for (const u of objectUrls.values()) URL.revokeObjectURL(u);
  objectUrls.clear();
  for (const [id, s] of states) if (s.status === 'done') states.delete(id);
  anyListeners.forEach((f) => f());
}

async function readCached(id: string): Promise<Blob | null> {
  if (typeof caches === 'undefined') return null;
  let blob: Blob | null = null;
  try { blob = await readAttachment(deviceStore(), id); } catch { /* промах */ }
  // в индексе был, а файла нет (вытеснил браузер) — больше не считаем его скачанным
  if (!blob && onDevice?.delete(id)) { if (states.get(id)?.status === 'done') states.delete(id); anyListeners.forEach((f) => f()); }
  return blob;
}

/**
 * Положить скачанный файл на устройство. Кнопкой «Скачать» — в saved-by-user (сам не удалится, браузер просим
 * не стирать хранилище); молча (просмотренное видео, автозагрузка) — в auto-evictable, если укладывается в лимит.
 */
async function keepOnDevice(id: string, blob: Blob, bucket: AttachmentBucket, maxMb: number): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  if (bucket === 'auto-evictable' && maxMb > 0 && blob.size > maxMb * 1024 * 1024) return false;
  if (bucket === 'saved-by-user') void requestPersistentStorage();
  try {
    if (!(await putAttachment(deviceStore(), id, blob, bucket))) return false;
  } catch { return false; }
  onDevice?.set(id, bucket);
  if (bucket === 'auto-evictable') void navigator.serviceWorker?.ready.then((r) => r.active?.postMessage({ type: 'attachments:sweep-auto' })).catch(() => {});
  return true;
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface StartOptions {
  /** отдать пользователю, когда скачается (кнопка «Скачать») — и в saved-by-user; false — молча в auto-evictable (автозагрузка, просмотренное видео) */
  save?: boolean;
  /** лимит кэша, МБ (prefs.media.maxMb) */
  maxMb?: number;
}

/**
 * Скачать (или взять из кэша) и, если save, отдать пользователю. Повторный вызов на тот же файл присоединяется
 * к идущей загрузке. Ошибку не бросает: она в состоянии (status 'error'), пузырь покажет «повторить».
 */
export function startDownload(f: DownloadFile, opts: StartOptions = {}): Promise<Blob | null> {
  const running = jobs.get(f.id);
  if (running) {
    if (opts.save) void running.promise.then((b) => { if (b) saveBlob(b, f.name); });
    return running.promise;
  }
  const ctrl = new AbortController();
  const promise = (async (): Promise<Blob | null> => {
    await loadOnDevice();
    const local = onDevice?.has(f.id) ? await readCached(f.id) : null;
    if (local) {
      set(f.id, { status: 'done', loaded: local.size, total: local.size, cached: true });
      // лежал в auto-evictable, а теперь его скачали кнопкой — переносим в saved-by-user
      if (opts.save && onDevice?.get(f.id) === 'auto-evictable') void keepOnDevice(f.id, local, 'saved-by-user', 0);
      if (opts.save) saveBlob(local, f.name);
      return local;
    }
    if (onDevice?.has(f.id)) onDevice.delete(f.id);   // запись была, а файла уже нет (вытеснили)
    set(f.id, { status: 'loading', loaded: 0, total: f.size });
    let shown = 0;
    try {
      // зашифрованный файл: качаем шифр (он больше на заголовок и теги кусков) и открываем ключом из сообщения
      const keyB64 = f.key ?? keyFor(f.id) ?? await fileKeysStore.get(f.id).catch(() => undefined);
      const sealed = await downloadChunks({
        url: `/files/${f.id}?download=1`, size: keyB64 ? encryptedSize(f.size) : f.size, type: keyB64 ? 'application/octet-stream' : f.mime, signal: ctrl.signal,
        // кольцу хватает 10 раз в секунду: куски по 16–64 КБ иначе дали бы тысячи перерисовок
        onProgress: (loaded, total) => {
          const now = performance.now();
          if (now - shown < 100 && loaded < total) return;
          shown = now;
          set(f.id, { status: 'loading', loaded, total, waiting: states.get(f.id)?.waiting });
        },
        onWaiting: (waiting) => { const s = states.get(f.id) ?? IDLE; set(f.id, { ...s, waiting }); },
      });
      const blob = keyB64 ? await openFile(sealed, await importFileKey(fromBase64(keyB64)), f.mime) : sealed;
      const cached = await keepOnDevice(f.id, blob, opts.save ? 'saved-by-user' : 'auto-evictable', opts.maxMb ?? 0);
      set(f.id, { status: cached ? 'done' : 'idle', loaded: blob.size, total: blob.size, cached });
      if (opts.save) saveBlob(blob, f.name);
      return blob;
    } catch (e) {
      const code = e instanceof DownloadError ? e.code : 'network';
      set(f.id, code === 'aborted' ? IDLE : { status: 'error', loaded: states.get(f.id)?.loaded ?? 0, total: f.size, error: code });
      return null;
    } finally {
      jobs.delete(f.id);
    }
  })();
  jobs.set(f.id, { ctrl, promise });
  return promise;
}

export function cancelDownload(id: string): void {
  jobs.get(id)?.ctrl.abort();
}

/** Видео/аудио просмотрели — тихо докачиваем целиком в кэш (по одному, чтобы не мешать ленте), если влезает. */
const background: DownloadFile[] = [];
let backgroundBusy = false;
const OFFLINE_MAX_MB = 1024;   // кэш без лимита — всё равно не тянем молча файлы больше гигабайта
export function keepOffline(f: DownloadFile, maxMb: number): void {
  if (!f.id || getDownload(f.id).status !== 'idle' || jobs.has(f.id) || background.some((x) => x.id === f.id)) return;
  if (f.size > (maxMb > 0 ? Math.min(maxMb, OFFLINE_MAX_MB) : OFFLINE_MAX_MB) * 1024 * 1024) return;
  background.push(f);
  void pump(maxMb);
}
async function pump(maxMb: number): Promise<void> {
  if (backgroundBusy) return;
  backgroundBusy = true;
  try {
    while (background.length) {
      const f = background.shift()!;
      await loadOnDevice();
      if (!onDevice?.has(f.id)) await startDownload(f, { maxMb });
    }
  } finally { backgroundBusy = false; }
}

/* ---------- голосовые и кружки ----------
   Как в Telegram: они маленькие и их переслушивают — держим файл на устройстве (auto-evictable) и играем оттуда.
   Плеер и <video> просят файл кусками (Range), такие ответы кэш не хранит — поэтому файл докачивается целиком
   отдельно, а играется по blob: (мгновенно, без сети, с перемоткой; см. useOfflineUrl ниже). */

/** Своё только что отправленное: файл уже в памяти (локальная копия) — кладём его на устройство, второй раз не качаем. */
async function keepLocalCopy(id: string, localUrl: string, maxMb: number): Promise<void> {
  try { await keepOnDevice(id, await (await fetch(localUrl)).blob(), 'auto-evictable', maxMb); } catch { /* копия уже отозвана — скачается обычным путём */ }
  anyListeners.forEach((f) => f());
}
const keepingLocal = new Set<string>();

/**
 * Источник для голосового или кружка.
 *  - на устройстве — blob: этого файла;
 *  - нет — сетевой адрес; lock — решение «сеть» не меняется, пока строка на экране (смена src перезапустила бы
 *    идущее видео); без lock (голосовое: адрес берётся только в момент нажатия) — докачалось, и уже играем с устройства;
 *  - local — своя локальная копия (только что отправили): она и играет, и она же ложится на устройство.
 * prefetch — докачать заранее (настройки автозагрузки); keep() — докачать сейчас (начали слушать).
 */
export function useKeptMedia(f: DownloadFile | null, network: string | undefined, o: { prefetch: boolean; lock: boolean; local?: string; maxMb: number }): { src: string | undefined; keep: () => void } {
  const id = f?.id || undefined;
  useDownload(id);   // перерисовка, когда индекс прочитан или файл докачался
  const onDev = id ? isCached(id) : false;
  const decided = useRef<'device' | 'network' | null>(null);
  if (decided.current === null && onDev !== null) decided.current = onDev ? 'device' : 'network';
  if (decided.current === 'device' && onDev === false) decided.current = 'network';   // файл вытеснили
  if (!o.lock && onDev) decided.current = 'device';
  const offline = useOfflineUrl(decided.current === 'device' ? id : undefined);
  useEffect(() => {
    if (!id || onDev !== false) return;
    if (o.local) { if (!keepingLocal.has(id)) { keepingLocal.add(id); void keepLocalCopy(id, o.local, o.maxMb).finally(() => keepingLocal.delete(id)); } return; }
    if (o.prefetch) keepOffline(f!, o.maxMb);
  }, [id, onDev, o.prefetch, o.local]);
  const keep = () => { if (f?.id && isCached(f.id) === false && !o.local) keepOffline(f, o.maxMb); };
  const src = o.local ?? (decided.current === 'device' ? offline : decided.current === 'network' ? network : undefined);
  return { src, keep };
}

/* ---------- видео с устройства ----------
   Скачанное целиком видео играем по blob:-адресу файла из кэша: так оно открывается мгновенно, без сети и
   перематывается (отдавать его плееру из SW нельзя — Chrome не перематывает такие ответы, см. mediaCache.ts).
   Адрес держим до конца вкладки: blob из Cache Storage лежит на диске, память он не занимает. */
const objectUrls = new Map<string, string>();
const resolving = new Map<string, Promise<void>>();

/** blob:-адрес файла, если его уже прочитали с устройства в этой вкладке (для очереди плеера: без ожидания). */
export function offlineUrlNow(id: string | undefined): string | undefined { return id ? objectUrls.get(id) : undefined; }

/** blob:-адрес скачанного файла; не скачан — undefined (играем по сети). */
export function useOfflineUrl(id: string | undefined): string | undefined {
  const st = useDownload(id);
  const [, tick] = useState(0);
  const want = !!id && (st.cached || (st.status === 'done' && onDevice?.has(id) === true));
  useEffect(() => {
    if (!id || !want || objectUrls.has(id)) return undefined;
    let alive = true;
    if (!resolving.has(id)) resolving.set(id, readCached(id).then((b) => { if (b && !objectUrls.has(id)) objectUrls.set(id, URL.createObjectURL(b)); }).finally(() => resolving.delete(id)));
    void resolving.get(id)!.then(() => { if (alive) tick((n) => n + 1); });
    return () => { alive = false; };
  }, [id, want]);
  return id ? objectUrls.get(id) : undefined;
}

/** Состояние загрузки файла для пузыря; перерисовывает при изменении. */
export function useDownload(id: string | undefined): DownloadState {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!id) return undefined;
    const f = () => tick((n) => n + 1);
    let set = listeners.get(id);
    if (!set) listeners.set(id, (set = new Set()));
    set.add(f); anyListeners.add(f);
    if (!onDevice) void loadOnDevice();
    return () => { set!.delete(f); anyListeners.delete(f); if (!set!.size) listeners.delete(id); };
  }, [id]);
  return id ? getDownload(id) : IDLE;
}
