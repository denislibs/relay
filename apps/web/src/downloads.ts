// Менеджер загрузок вложений, как в Telegram: большой файл качается частями (Range), кольцо с процентом и ×,
// обрыв сети — продолжаем с последнего полученного байта, истёкшая подписанная ссылка — берём новую у /files/<id>.
// Готовый файл отдаём пользователю (сохранить) и кладём целиком в кэш relay-media: второй раз «открыть» — мгновенно
// и без сети (SW отдаёт оттуда и картинки, и части видео). Ядро (downloadChunks) не знает про браузер — тесты гоняют
// его с подставным fetch.
import { useEffect, useState } from 'preact/hooks';
import { MEDIA_CACHE, mediaKey, storeMedia } from './mediaCache';

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
export interface DownloadFile { id: string; name: string; mime: string; size: number }

const IDLE: DownloadState = { status: 'idle', loaded: 0, total: 0 };
const states = new Map<string, DownloadState>();
const jobs = new Map<string, { ctrl: AbortController; promise: Promise<Blob | null> }>();
const listeners = new Map<string, Set<() => void>>();
let cachedIds: Set<string> | null = null;
let cachedLoading: Promise<void> | null = null;
const anyListeners = new Set<() => void>();

function set(id: string, s: DownloadState): void {
  states.set(id, s);
  listeners.get(id)?.forEach((f) => f());
}

export function getDownload(id: string): DownloadState {
  const s = states.get(id);
  if (s) return s;
  return cachedIds?.has(id) ? { status: 'done', loaded: 0, total: 0, cached: true } : IDLE;
}

/** Какие файлы уже лежат в кэше целиком: один раз читаем ключи (тела не трогаем). */
function loadCachedIds(): Promise<void> {
  if (cachedIds || typeof caches === 'undefined') return Promise.resolve();
  cachedLoading ??= (async () => {
    const ids = new Set<string>();
    try {
      for (const req of await (await caches.open(MEDIA_CACHE)).keys()) {
        const m = /\/files\/([0-9a-f-]{36})$/.exec(new URL(req.url).pathname);
        if (m) ids.add(m[1]);
      }
    } catch { /* кэш недоступен — просто ничего не знаем */ }
    cachedIds = ids;
    anyListeners.forEach((f) => f());
  })();
  return cachedLoading;
}

/** Лежит ли файл целиком на устройстве; null — ещё не знаем (ключи кэша читаются). */
export function isCached(id: string): boolean | null {
  return cachedIds ? cachedIds.has(id) : null;
}
/** Прочитать ключи кэша заранее (лента открылась): к нажатию на видео ответ уже готов. */
export function warmCached(): Promise<void> { return loadCachedIds(); }

/** Кэш медиа очистили (Данные и память, выход): забываем, что там было. */
export function forgetCached(): void {
  cachedIds = new Set();
  for (const u of objectUrls.values()) URL.revokeObjectURL(u);
  objectUrls.clear();
  for (const [id, s] of states) if (s.status === 'done') states.delete(id);
  anyListeners.forEach((f) => f());
}

async function readCached(id: string): Promise<Blob | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const hit = await (await caches.open(MEDIA_CACHE)).match(mediaKey(id));
    return hit ? await hit.blob() : null;
  } catch { return null; }
}

/** Хватит ли места положить файл в кэш: лимит из «Данные и память» (0 — без лимита) и свободное место браузера. */
async function fits(size: number, maxMb: number): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  if (maxMb > 0 && size > maxMb * 1024 * 1024) return false;
  try {
    const e = await navigator.storage.estimate();
    if (e.quota && e.usage != null) return e.quota - e.usage > size + 64 * 1024 * 1024;
  } catch { /* оценки нет — пробуем: Cache API сам откажет при нехватке */ }
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
  /** отдать пользователю, когда скачается (кнопка «Скачать»); false — молча в кэш (автозагрузка, просмотренное видео) */
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
    await loadCachedIds();
    const local = cachedIds?.has(f.id) ? await readCached(f.id) : null;
    if (local) {
      set(f.id, { status: 'done', loaded: local.size, total: local.size, cached: true });
      if (opts.save) saveBlob(local, f.name);
      return local;
    }
    if (cachedIds?.has(f.id)) cachedIds.delete(f.id);   // ключ был, а файла уже нет (вытеснили)
    set(f.id, { status: 'loading', loaded: 0, total: f.size });
    let shown = 0;
    try {
      const blob = await downloadChunks({
        url: `/files/${f.id}?download=1`, size: f.size, type: f.mime, signal: ctrl.signal,
        // кольцу хватает 10 раз в секунду: куски по 16–64 КБ иначе дали бы тысячи перерисовок
        onProgress: (loaded, total) => {
          const now = performance.now();
          if (now - shown < 100 && loaded < total) return;
          shown = now;
          set(f.id, { status: 'loading', loaded, total, waiting: states.get(f.id)?.waiting });
        },
        onWaiting: (waiting) => { const s = states.get(f.id) ?? IDLE; set(f.id, { ...s, waiting }); },
      });
      let cached = false;
      if (await fits(blob.size, opts.maxMb ?? 0)) {
        try {
          await storeMedia(caches, f.id, blob);
          cached = true;
          cachedIds?.add(f.id);
          void navigator.serviceWorker?.ready.then((r) => r.active?.postMessage({ type: 'mediaSweep' })).catch(() => {});
        } catch { /* не влезло — просто не кэшируем */ }
      }
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
      await loadCachedIds();
      if (!cachedIds?.has(f.id)) await startDownload(f, { maxMb });
    }
  } finally { backgroundBusy = false; }
}

/* ---------- видео с устройства ----------
   Скачанное целиком видео играем по blob:-адресу файла из кэша: так оно открывается мгновенно, без сети и
   перематывается (отдавать его плееру из SW нельзя — Chrome не перематывает такие ответы, см. mediaCache.ts).
   Адрес держим до конца вкладки: blob из Cache Storage лежит на диске, память он не занимает. */
const objectUrls = new Map<string, string>();
const resolving = new Map<string, Promise<void>>();

/** blob:-адрес скачанного файла; не скачан — undefined (играем по сети). */
export function useOfflineUrl(id: string | undefined): string | undefined {
  const st = useDownload(id);
  const [, tick] = useState(0);
  const want = !!id && (st.cached || (st.status === 'done' && cachedIds?.has(id) === true));
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
    if (!cachedIds) void loadCachedIds();
    return () => { set!.delete(f); anyListeners.delete(f); if (!set!.size) listeners.delete(id); };
  }, [id]);
  return id ? getDownload(id) : IDLE;
}
