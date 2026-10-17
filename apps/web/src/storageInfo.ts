// Память устройства: оценка браузера и кэши медиа (Cache Storage, имена `relay-media*`).
// Оболочку приложения (`relay-shell-*`) не трогаем: без неё не откроется офлайн.
export const MEDIA_CACHE = /^relay-media/;

export function formatBytes(n: number): string {
  if (!(n > 0)) return '0 Б';
  const u: [number, string][] = [[1024 ** 3, 'ГБ'], [1024 ** 2, 'МБ'], [1024, 'КБ']];
  for (const [d, t] of u) if (n >= d) return (Math.round((n / d) * 10) / 10).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' ' + t;
  return Math.round(n) + ' Б';
}

export interface StorageInfo { used: number; quota: number; db: number; media: number }

async function mediaCaches(): Promise<Cache[]> {
  if (typeof caches === 'undefined') return [];
  try { return await Promise.all((await caches.keys()).filter((k) => MEDIA_CACHE.test(k)).map((k) => caches.open(k))); } catch { return []; }
}

/** Размер медиа-кэшей: content-length, а если заголовка нет — размер тела. Между записями отдаём управление. */
export async function mediaCacheSize(): Promise<number> {
  let sum = 0;
  for (const c of await mediaCaches()) {
    for (const req of await c.keys()) {
      const res = await c.match(req);
      if (!res) continue;
      const len = Number(res.headers.get('content-length'));
      sum += len > 0 ? len : (await res.blob()).size;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return sum;
}

export async function clearMediaCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  await Promise.all((await caches.keys()).filter((k) => MEDIA_CACHE.test(k)).map((k) => caches.delete(k)));
}

export async function readStorage(): Promise<StorageInfo> {
  const media = await mediaCacheSize();
  let used = 0, quota = 0, db = 0;
  try {
    const e = (await navigator.storage.estimate()) as StorageEstimate & { usageDetails?: { indexedDB?: number; caches?: number } };
    used = e.usage ?? 0; quota = e.quota ?? 0;
    db = e.usageDetails?.indexedDB ?? Math.max(0, used - (e.usageDetails?.caches ?? media));
  } catch { /* оценка недоступна */ }
  return { used: Math.max(used, media), quota, db, media };
}
