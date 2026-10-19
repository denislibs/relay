// Память устройства: оценка браузера и файлы вложений (индекс relay-attachments-on-device + ящики
// relay-attachments-*). Оболочку приложения (relay-app-shell@*) не трогаем: без неё не откроется офлайн.
import { forgetCached } from './downloads';
import { clearAllAttachments, deviceStore } from './mediaCache';

export function formatBytes(n: number): string {
  if (!(n > 0)) return '0 Б';
  const u: [number, string][] = [[1024 ** 3, 'ГБ'], [1024 ** 2, 'МБ'], [1024, 'КБ']];
  for (const [d, t] of u) if (n >= d) return (Math.round((n / d) * 10) / 10).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' ' + t;
  return Math.round(n) + ' Б';
}

/**
 * exact: браузер разделил IndexedDB и кэши (usageDetails); иначе db — «всё остальное». approx: у части файлов размер неизвестен.
 * media/files — все вложения на устройстве; savedBytes/savedFiles — из них скачанные кнопкой (сами не удаляются).
 * persisted: браузер обещал не стирать хранилище при нехватке места.
 */
export interface StorageInfo {
  used: number; quota: number; db: number; media: number; exact: boolean; approx: boolean;
  files?: number; savedBytes?: number; savedFiles?: number; persisted?: boolean;
}

/** Размер вложений по индексу — без обхода кэша и без чтения файлов. */
export async function mediaCacheSize(): Promise<{ bytes: number; unknown: number; files: number; savedBytes: number; savedFiles: number }> {
  let bytes = 0, unknown = 0, files = 0, savedBytes = 0, savedFiles = 0;
  if (typeof indexedDB === 'undefined') return { bytes, unknown, files, savedBytes, savedFiles };
  try {
    for (const r of await deviceStore().index.all()) {
      if (r.sizeBytes > 0) bytes += r.sizeBytes; else unknown++;
      if (r.chunkOf) continue;   // кусок начала видео: место занимает, но отдельным файлом не считается
      files++;   // целый файл: открывается без сети
      if (r.bucket === 'saved-by-user') { savedFiles++; savedBytes += r.sizeBytes; }
    }
  } catch { /* индекс недоступен */ }
  return { bytes, unknown, files, savedBytes, savedFiles };
}

/** Стереть все файлы вложений — и само подгруженное, и скачанное кнопкой. */
export async function clearMediaCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  forgetCached();   // менеджер загрузок больше не считает эти файлы скачанными
  await clearAllAttachments(deviceStore());
}

/**
 * Попросить браузер не стирать хранилище при нехватке места (иначе он может удалить разом и переписку,
 * и файлы). Chrome решает сам, без вопроса; Firefox спрашивает пользователя — поэтому при старте не просим
 * в Firefox, только когда вы сами сохраняете файл.
 */
export async function requestPersistentStorage(atStartup = false): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    if (atStartup && /firefox/i.test(navigator.userAgent)) return false;
    return await navigator.storage.persist();
  } catch { return false; }
}

export async function readStorage(): Promise<StorageInfo> {
  const m = await mediaCacheSize();
  const persisted = await navigator.storage?.persisted?.().catch(() => false) ?? false;
  let used = 0, quota = 0, db = 0, exact = false;
  try {
    const e = (await navigator.storage.estimate()) as StorageEstimate & { usageDetails?: { indexedDB?: number; caches?: number } };
    used = e.usage ?? 0; quota = e.quota ?? 0;
    exact = e.usageDetails?.indexedDB != null;
    db = e.usageDetails?.indexedDB ?? Math.max(0, used - (e.usageDetails?.caches ?? m.bytes));
  } catch { /* оценка недоступна */ }
  return { used: Math.max(used, m.bytes), quota, db, media: m.bytes, exact, approx: m.unknown > 0, files: m.files, savedBytes: m.savedBytes, savedFiles: m.savedFiles, persisted };
}

const OWNER_KEY = 'relay.mediaOwner';

/** Кэш вложений принадлежит одному пользователю: вошёл другой — прежний кэш стираем. */
export async function claimMediaCache(userId: number): Promise<void> {
  let owner: string | null = null;
  try { owner = localStorage.getItem(OWNER_KEY); } catch { /* приватный режим */ }
  void requestPersistentStorage(true);
  if (owner === String(userId)) return;
  await clearMediaCaches().catch(() => {});
  try { localStorage.setItem(OWNER_KEY, String(userId)); } catch { /* */ }
}

/** Выход: кэш вложений больше никому не принадлежит. */
export async function releaseMediaCache(): Promise<void> {
  try { localStorage.removeItem(OWNER_KEY); } catch { /* */ }
  await clearMediaCaches().catch(() => {});
}

/** Срок хранения и лимит для auto-evictable — Service Worker'у: он сохраняет их в индекс и сразу чистит по ним. */
export function sendMediaPolicy(p: { keepDays: number; maxMb: number }): void {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: 'attachments:set-auto-cleanup-policy', keepAutoDays: p.keepDays, maxAutoMb: p.maxMb })).catch(() => {});
}
