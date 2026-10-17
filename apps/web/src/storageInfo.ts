// Память устройства: оценка браузера и кэши медиа (Cache Storage, имена `relay-media*`).
// Оболочку приложения (`relay-shell-*`) не трогаем: без неё не откроется офлайн.
export const MEDIA_CACHE = /^relay-media/;

export function formatBytes(n: number): string {
  if (!(n > 0)) return '0 Б';
  const u: [number, string][] = [[1024 ** 3, 'ГБ'], [1024 ** 2, 'МБ'], [1024, 'КБ']];
  for (const [d, t] of u) if (n >= d) return (Math.round((n / d) * 10) / 10).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' ' + t;
  return Math.round(n) + ' Б';
}

/** exact: браузер разделил IndexedDB и кэши (usageDetails); иначе db — «всё остальное». approx: у части записей кэша нет длины. */
export interface StorageInfo { used: number; quota: number; db: number; media: number; exact: boolean; approx: boolean }

async function mediaCaches(): Promise<Cache[]> {
  if (typeof caches === 'undefined') return [];
  try { return await Promise.all((await caches.keys()).filter((k) => MEDIA_CACHE.test(k)).map((k) => caches.open(k))); } catch { return []; }
}

const idle = (): Promise<void> => new Promise((r) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) ric(() => r()); else setTimeout(r, 0);
});

let cached: { bytes: number; unknown: number } | null = null;

/** Размер медиа-кэшей по content-length; тела не читаем. Записи без длины считаем неизвестными. Результат живёт, пока открыта страница. */
export async function mediaCacheSize(): Promise<{ bytes: number; unknown: number }> {
  if (cached) return cached;
  let bytes = 0, unknown = 0, n = 0;
  for (const c of await mediaCaches()) {
    for (const req of await c.keys()) {
      const res = await c.match(req);
      if (!res) continue;
      const len = Number(res.headers.get('content-length'));
      if (len > 0) bytes += len; else unknown++;
      if (++n % 50 === 0) await idle();   // пачками, в простое
    }
  }
  return (cached = { bytes, unknown });
}

export async function clearMediaCaches(): Promise<void> {
  cached = null;
  if (typeof caches === 'undefined') return;
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
  return { used: Math.max(used, m.bytes), quota, db, media: m.bytes, exact, approx: m.unknown > 0 };
}
