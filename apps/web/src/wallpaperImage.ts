// Своя картинка обоев: хранится только на этом устройстве (IndexedDB), по одной на тему.
// В настройках — лишь её id: новая картинка = новый id, поэтому вкладки и кэш URL не путают старую с новой.
import { useEffect, useState } from 'preact/hooks';

import type { Base } from './themes/presets';

/** Картинка — у каждой темы своя. Прежние версии хранили по «светлая/тёмная»: это Классическая и Ночь. */
export type ThemeKey = Base;
const LEGACY: Partial<Record<ThemeKey, string>> = { classic: 'light', night: 'dark' };

const DB = 'relay-wallpaper', STORE = 'images', MAX_SIDE = 2560;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

/** Картинка → JPEG не больше 2560 px по длинной стороне: обоям хватает, а 20-мегапиксельное фото не держим в памяти. */
async function shrink(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  try {
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.9));
  } finally { bmp.close(); }
}

/** Сохранить картинку темы; возвращает новый id для настроек. Не картинка — исключение. */
export async function saveImage(key: ThemeKey, file: Blob): Promise<string> {
  const blob = await shrink(file);
  const id = Date.now().toString(36);
  await tx('readwrite', (s) => s.put({ id, blob }, key));
  urls.delete(key);
  return id;
}

export async function deleteImage(key: ThemeKey): Promise<void> {
  await tx('readwrite', (s) => s.delete(key));
  const old = LEGACY[key];
  if (old) await tx('readwrite', (s) => s.delete(old)).catch(() => {});
  const u = urls.get(key);
  if (u) { URL.revokeObjectURL(u.url); urls.delete(key); }
}

// object URL на тему: один на id, старый отзывается, когда id сменился
const urls = new Map<ThemeKey, { id: string; url: string }>();

async function urlFor(key: ThemeKey, id: string): Promise<string | null> {
  const have = urls.get(key);
  if (have?.id === id) return have.url;
  let rec = await tx<{ id: string; blob: Blob } | undefined>('readonly', (s) => s.get(key));
  const old = LEGACY[key];
  if (!rec && old) rec = await tx<{ id: string; blob: Blob } | undefined>('readonly', (s) => s.get(old));   // картинка прежней версии
  if (!rec || rec.id !== id) return null;   // настройки и база разошлись (другая вкладка уже заменила) — без картинки
  if (have) URL.revokeObjectURL(have.url);
  const url = URL.createObjectURL(rec.blob);
  urls.set(key, { id, url });
  return url;
}

/** URL картинки обоев темы или null (картинки нет или ещё читается). */
export function useWallpaperImage(key: ThemeKey, id: string | null): string | null {
  const cached = id ? urls.get(key) : undefined;
  const [url, setUrl] = useState<string | null>(cached?.id === id ? cached.url : null);
  useEffect(() => {
    if (!id) { setUrl(null); return; }
    let alive = true;
    urlFor(key, id).then((u) => { if (alive) setUrl(u); }, () => { if (alive) setUrl(null); });
    return () => { alive = false; };
  }, [key, id]);
  return id ? url : null;
}
