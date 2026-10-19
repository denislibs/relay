// Память устройства: оценка браузера и кэши медиа (Cache Storage, имена `relay-media*`).
// Оболочку приложения (`relay-shell-*`) не трогаем: без неё не откроется офлайн.
import { forgetCached } from './downloads';

export const MEDIA_CACHE = /^relay-media/;

export function formatBytes(n: number): string {
  if (!(n > 0)) return '0 Б';
  const u: [number, string][] = [[1024 ** 3, 'ГБ'], [1024 ** 2, 'МБ'], [1024, 'КБ']];
  for (const [d, t] of u) if (n >= d) return (Math.round((n / d) * 10) / 10).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' ' + t;
  return Math.round(n) + ' Б';
}

/** exact: браузер разделил IndexedDB и кэши (usageDetails); иначе db — «всё остальное». approx: у части записей кэша нет длины. */
export interface StorageInfo { used: number; quota: number; db: number; media: number; exact: boolean; approx: boolean; files?: number }

async function mediaCaches(): Promise<Cache[]> {
  if (typeof caches === 'undefined') return [];
  try { return await Promise.all((await caches.keys()).filter((k) => MEDIA_CACHE.test(k)).map((k) => caches.open(k))); } catch { return []; }
}

const idle = (): Promise<void> => new Promise((r) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) ric(() => r()); else setTimeout(r, 0);
});

/** Размер медиа-кэшей по content-length; тела не читаем. Записи без длины считаем неизвестными. */
export async function mediaCacheSize(): Promise<{ bytes: number; unknown: number; files: number }> {
  let bytes = 0, unknown = 0, n = 0, files = 0;
  for (const c of await mediaCaches()) {
    for (const req of await c.keys()) {
      const res = await c.match(req);
      if (!res) continue;
      const len = Number(res.headers.get('content-length'));
      if (len > 0) bytes += len; else unknown++;
      files++;   // каждая запись — целый файл (части в кэш не попадают): всё это открывается без сети
      if (++n % 50 === 0) await idle();   // пачками, в простое
    }
  }
  return { bytes, unknown, files };
}

export async function clearMediaCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  forgetCached();   // менеджер загрузок больше не считает эти файлы скачанными
  await Promise.all((await caches.keys()).filter((k) => MEDIA_CACHE.test(k)).map((k) => caches.delete(k)));
}

export async function readStorage(): Promise<StorageInfo> {
  const m = await mediaCacheSize();
  let used = 0, quota = 0, db = 0, exact = false;
  try {
    const e = (await navigator.storage.estimate()) as StorageEstimate & { usageDetails?: { indexedDB?: number; caches?: number } };
    used = e.usage ?? 0; quota = e.quota ?? 0;
    exact = e.usageDetails?.indexedDB != null;
    db = e.usageDetails?.indexedDB ?? Math.max(0, used - (e.usageDetails?.caches ?? m.bytes));
  } catch { /* оценка недоступна */ }
  return { used: Math.max(used, m.bytes), quota, db, media: m.bytes, exact, approx: m.unknown > 0, files: m.files };
}

const OWNER_KEY = 'relay.mediaOwner';

/** Кэш вложений принадлежит одному пользователю: вошёл другой — прежний кэш стираем. */
export async function claimMediaCache(userId: number): Promise<void> {
  let owner: string | null = null;
  try { owner = localStorage.getItem(OWNER_KEY); } catch { /* приватный режим */ }
  if (owner === String(userId)) return;
  await clearMediaCaches().catch(() => {});
  try { localStorage.setItem(OWNER_KEY, String(userId)); } catch { /* */ }
}

/** Выход: кэш вложений больше никому не принадлежит. */
export async function releaseMediaCache(): Promise<void> {
  try { localStorage.removeItem(OWNER_KEY); } catch { /* */ }
  await clearMediaCaches().catch(() => {});
}

/** Срок хранения и лимит — Service Worker'у: localStorage ему недоступен, он хранит их у себя. */
export function sendMediaPolicy(p: { keepDays: number; maxMb: number }): void {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: 'mediaPolicy', keepDays: p.keepDays, maxMb: p.maxMb })).catch(() => {});
}
