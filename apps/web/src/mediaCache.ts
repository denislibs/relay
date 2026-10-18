// Кэш вложений в Service Worker (Cache Storage `relay-media`): /files/<id> не меняется по id,
// поэтому сначала кэш, потом сеть. У каждой записи свои заголовки — когда сохранили, когда
// последний раз отдавали, сколько весит: по ним работают очистка по сроку и по размеру и экран
// «Данные и память». Чужой пользователь на этом устройстве кэш не увидит: при выходе и при входе
// другим пользователем страница стирает его целиком (storageInfo.clearMediaCaches).

export const MEDIA_CACHE = 'relay-media';
const META_CACHE = 'relay-meta';
const POLICY_KEY = '/__relay/media-policy';
export const MAX_ITEM = 20 * 1024 * 1024;     // крупнее — только HTTP-кэш браузера
const SAVED = 'x-relay-saved', USED = 'x-relay-used';
const TOUCH_MS = 24 * 3600_000;                // время доступа обновляем не чаще раза в сутки (это перезапись)
const OP_MS = 5000;                            // Cache API бывает задумчив (Safari): дольше — считаем промахом

/** keepDays: 0 — хранить, пока не очистят; maxMb: 0 — без ограничения. */
export interface MediaPolicy { keepDays: number; maxMb: number }
export const DEFAULT_POLICY: MediaPolicy = { keepDays: 30, maxMb: 0 };

type Caches = Pick<CacheStorage, 'open'>;

const withTimeout = <T>(p: Promise<T>, ms = OP_MS): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('cache timeout')), ms))]);

/** Что кэшируем: GET вложения без параметров (download=1 — сохранение на диск) и без Range. */
export function isMediaRequest(req: Request, origin: string): boolean {
  if (req.method !== 'GET' || req.headers.has('range')) return false;
  const u = new URL(req.url);
  return u.origin === origin && !u.search && /^\/files\/[0-9a-f-]{36}$/.test(u.pathname);
}

const stamp = (body: Blob, res: Response, saved: number, used: number): Response => {
  const h = new Headers(res.headers);
  h.set(SAVED, String(saved));
  h.set(USED, String(used));
  h.set('content-length', String(body.size));
  return new Response(body, { status: 200, statusText: 'OK', headers: h });
};

/**
 * Ответ на запрос вложения. background — то, что SW должен дождаться (event.waitUntil): запись в кэш
 * или отметка о доступе. Любая ошибка кэша — промах, идём в сеть.
 */
export async function serveMedia(caches: Caches, req: Request, net: (r: Request) => Promise<Response>, now = Date.now()):
  Promise<{ response: Response; background: Promise<unknown> | null; stored: boolean }> {
  const key = new URL(req.url).pathname;
  const cache = await withTimeout(caches.open(MEDIA_CACHE)).catch(() => null);
  const hit = cache ? await withTimeout(cache.match(key)).catch(() => undefined) : undefined;
  if (hit) {
    const used = Number(hit.headers.get(USED) ?? 0);
    if (now - used < TOUCH_MS) return { response: hit, background: null, stored: false };
    const body = await hit.blob();
    const saved = Number(hit.headers.get(SAVED));
    const fresh = stamp(body, hit, Number.isFinite(saved) && hit.headers.has(SAVED) ? saved : now, now);
    return { response: fresh.clone(), background: cache!.put(key, fresh).catch(() => {}), stored: false };
  }
  const res = await net(req);
  const len = Number(res.headers.get('content-length'));
  if (!cache || res.status !== 200 || res.type === 'opaque' || !(len > 0) || len > MAX_ITEM) return { response: res, background: null, stored: false };
  const copy = res.clone();
  const background = copy.blob().then((b) => (b.size <= MAX_ITEM ? withTimeout(cache.put(key, stamp(b, copy, now, now)), 30_000) : undefined)).catch(() => {});
  return { response: res, background, stored: true };
}

/**
 * Очистка: сначала всё, к чему не обращались дольше keepDays, затем — самые давно нужные,
 * пока кэш не уложится в maxMb. Возвращает сколько удалили и сколько осталось.
 */
export async function sweepMedia(caches: Caches, policy: MediaPolicy, now = Date.now()): Promise<{ removed: number; bytes: number }> {
  const cache = await withTimeout(caches.open(MEDIA_CACHE)).catch(() => null);
  if (!cache) return { removed: 0, bytes: 0 };
  const items: { key: Request; used: number; size: number }[] = [];
  for (const key of await cache.keys()) {
    const res = await cache.match(key);
    if (!res) continue;
    items.push({ key, used: Number(res.headers.get(USED) ?? res.headers.get(SAVED) ?? 0) || 0, size: Number(res.headers.get('content-length')) || 0 });
  }
  let removed = 0;
  const drop = async (i: { key: Request }) => { if (await cache.delete(i.key)) removed++; };
  const ttl = policy.keepDays > 0 ? policy.keepDays * 24 * 3600_000 : Infinity;
  const live = [];
  for (const i of items) { if (now - i.used > ttl) await drop(i); else live.push(i); }
  let bytes = live.reduce((n, i) => n + i.size, 0);
  const max = policy.maxMb > 0 ? policy.maxMb * 1024 * 1024 : Infinity;
  if (bytes > max) {
    live.sort((a, b) => a.used - b.used);
    for (const i of live) { if (bytes <= max) break; await drop(i); bytes -= i.size; }
  }
  return { removed, bytes };
}

/** Политика живёт в Cache Storage: SW могут остановить в любой момент, а localStorage ему недоступен. */
export async function savePolicy(caches: Caches, p: MediaPolicy): Promise<void> {
  const c = await caches.open(META_CACHE);
  await c.put(POLICY_KEY, new Response(JSON.stringify(p), { headers: { 'content-type': 'application/json' } }));
}

export async function loadPolicy(caches: Caches): Promise<MediaPolicy> {
  try {
    const res = await (await caches.open(META_CACHE)).match(POLICY_KEY);
    const p = res ? (await res.json()) as Partial<MediaPolicy> : {};
    return { keepDays: Number(p.keepDays) >= 0 ? Number(p.keepDays) : DEFAULT_POLICY.keepDays, maxMb: Number(p.maxMb) >= 0 ? Number(p.maxMb) : DEFAULT_POLICY.maxMb };
  } catch { return DEFAULT_POLICY; }
}
