/// <reference lib="webworker" />
// Cache Storage этого приложения:
//   relay-app-shell@<сборка>          — код, стили, воркеры, звуки: холодный старт без сети;
//   relay-attachments-auto-evictable  — вложения, подгруженные сами (уходят по сроку, лимиту и при нехватке места);
//   relay-attachments-saved-by-user   — вложения, скачанные кнопкой (сами не удаляются);
//   relay-stickers                    — файлы стикеров /stk/… и реакций /rx/… (адрес с хэшем содержимого: неизменны, живут между сборками).
// Сведения о вложениях — в IndexedDB relay-attachments-on-device (mediaCache.ts, attachmentsOnDevice.ts).
// Остальной API и WebSocket — только сеть.
import type { AutoCleanupPolicy } from './attachmentsOnDevice';
import {
  CACHE_APP_SHELL_PREFIX, deviceStore, fetchMedia, isMediaRangeRequest, isMediaRequest, LEGACY_CACHES,
  fileKeyOf, loadPolicy, migrateLegacyCaches, resetFileKeyCache, savePolicy, serveEncryptedRange, serveMedia, serveVideoRange, sweepAuto,
} from './mediaCache';
import { installDeviceFetch } from './deviceAuth';
import { verified } from './buildIntegrity';
declare const __BUILD__: string;
const sw = self as unknown as ServiceWorkerGlobalScope;
// файлы и API из SW: 401 «обнови доступ» (сеанс привязан к устройству) — подпись ключом устройства и повтор
installDeviceFetch(sw as never);
const CACHE = CACHE_APP_SHELL_PREFIX + __BUILD__;
const store = deviceStore();
// ключа файла ещё нет в IndexedDB (страница только что получила сообщение) — спросить открытую вкладку
store.askKey = async (id: string) => {
  const wins = await sw.clients.matchAll({ type: 'window' });
  for (const w of wins) {
    const ch = new MessageChannel();
    const answer = new Promise<string | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 1000);
      ch.port1.onmessage = (e) => { clearTimeout(t); resolve((e.data as { key?: string | null })?.key ?? null); };
    });
    w.postMessage({ type: 'attachments:need-key', id }, [ch.port2]);
    const key = await answer;
    if (key) return key;
  }
  return null;
};
const fileIdFrom = (url: string) => /^\/files\/([0-9a-f-]{36}(?:\/(?:preview|720|medium))?)$/.exec(new URL(url).pathname)?.[1] ?? '';
declare const __SHELL__: string[];   // код и стили этой сборки с хэшем в имени (build.ts)
declare const __INTEGRITY__: Record<string, string>;   // файл с хэшем в имени → SHA-256 его байтов (build.ts)
const INTEGRITY: Record<string, string> = __INTEGRITY__;
const SHELL = ['/', ...__SHELL__, '/sounds/message.mp3', '/sounds/sent.mp3'];   // звуки сообщений — и без сети
const API = /^\/(health|me|users|contacts|settings|privacy|blocks|chats|presence|search|uploads|files|push|sessions|session|ws|dev|logout|auth|link-preview|groups|join|sticker-sets|my-stickers|stickers-by-emoji|stickers|reactions)(\/|$)/;

sw.addEventListener('install', (e) => {
  // мимо HTTP-кэша браузера: новая сборка не должна положить к себе файл прежней; чужие байты — установка не удаётся,
  // остаётся прежний SW со своей проверенной оболочкой
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map(async (u) => {
    const res = await fetch(new Request(u, { cache: 'no-cache' }));
    if (!res.ok) throw new Error(`shell ${u}: ${res.status}`);
    await c.put(u, await verified(res, u, INTEGRITY));
  }))).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys
      .filter((k) => (k.startsWith(CACHE_APP_SHELL_PREFIX) || k.startsWith(LEGACY_CACHES.shellPrefix)) && k !== CACHE)
      .map((k) => caches.delete(k))))
      .then(() => sw.clients.claim())
      .then(() => migrateLegacyCaches(store).catch(() => 0))
      .then(() => sweep()),
  );
});

// Очистка auto-evictable: при старте SW, раз в SWEEP_EVERY новых файлов и когда страница меняет политику.
const SWEEP_EVERY = 20;
let stored = 0;
let sweeping: Promise<unknown> | null = null;
function sweep(policy?: AutoCleanupPolicy): Promise<unknown> {
  sweeping ??= (async () => sweepAuto(store, policy ?? await loadPolicy(store)))().catch(() => {}).finally(() => { sweeping = null; });
  return sweeping;
}

sw.addEventListener('message', (e) => {
  const d = e.data as { type?: string; keepAutoDays?: number; maxAutoMb?: number } | null;
  // страница положила файл в auto-evictable (менеджер загрузок) — проверить лимит
  if (d?.type === 'attachments:sweep-auto') { e.waitUntil(sweep()); return; }
  if (d?.type === 'attachments:forget-keys') { resetFileKeyCache(); return; }   // выход: ключи файлов — из памяти тоже
  if (d?.type !== 'attachments:set-auto-cleanup-policy') return;
  const p: AutoCleanupPolicy = { keepAutoDays: Math.max(0, Number(d.keepAutoDays) || 0), maxAutoMb: Math.max(0, Number(d.maxAutoMb) || 0) };
  e.waitUntil(savePolicy(store, p).then(() => sweep(p)).catch(() => {}));
});

/** Кусок вложения из сети в режиме cors: байты и Content-Range читаются (хранилище их открывает). */
const corsRange = (url: string, range: string) => fetch(new Request(url, { mode: 'cors', credentials: 'same-origin', headers: { range } }));

/**
 * Часть видео из сети — тоже своим ответом (поток, не читаем в память): все части одного видео плеер получает
 * одинаковыми, а не вперемешку «наш ответ» и «непрозрачный чужой» — Chrome такую смесь не играет.
 * cors не прошёл (хранилище без CORS) — исходный запрос как есть, без кэша начала.
 */
async function rangeFromNetwork(req: Request): Promise<Response> {
  let res: Response;
  try { res = await corsRange(req.url, req.headers.get('range') ?? 'bytes=0-'); } catch { return fetch(req); }
  const h = new Headers();
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = res.headers.get(k); if (v) h.set(k, v); }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/** Сеть, но не дольше ms: потом — кэш, если он есть (иначе продолжаем ждать сеть). */
function networkFirst(req: Request, fallback: () => Promise<Response | undefined>, ms = 3000): Promise<Response> {
  const net = fetch(req);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (r: Response) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => { void fallback().then((r) => { if (r) finish(r); }); }, ms);
    net.then((r) => { clearTimeout(timer); finish(r); }, async () => {
      clearTimeout(timer);
      const r = await fallback();
      if (r) finish(r); else if (!done) { done = true; reject(new Error('offline')); }
    });
  });
}

// Стикеры и реакции: сначала кэш (файл по адресу не меняется никогда), иначе сеть и в кэш. Предел — по числу файлов:
// при переполнении уходят самые давно положенные (порядок ключей Cache Storage — порядок добавления).
const STICKERS_CACHE = 'relay-stickers';
const STICKER_PREFIXES = ['/stk/', '/rx/'];
const STICKERS_MAX = 6000;   // ≈ 60–120 МБ при 10–20 КБ на .tgs
let stickerPuts = 0;
async function serveSticker(req: Request): Promise<Response> {
  const c = await caches.open(STICKERS_CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200) {
    await c.put(req, res.clone());
    if (++stickerPuts % 100 === 0) {
      const keys = await c.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - STICKERS_MAX))) await c.delete(k);
    }
  }
  return res;
}

sw.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'GET' && url.origin === location.origin && STICKER_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    e.respondWith(serveSticker(e.request).catch(() => Response.error()));
    return;
  }
  if (isMediaRequest(e.request, location.origin) && e.request.mode !== 'navigate') {
    e.respondWith(fileKeyOf(store, fileIdFrom(e.request.url)).catch(() => null).then((raw) => serveMedia(store, e.request, (r) => fetchMedia(r), Date.now(), raw)).then(({ response, background, stored: put }) => {
      if (background) e.waitUntil(background.then(() => { if (put && ++stored % SWEEP_EVERY === 0) return sweep(); }));
      return response;
    }));
    return;
  }
  // часть видео/аудио — через /files/…: плеер не застрянет на истёкшей ссылке хранилища (без SW Chrome после
  // перемотки идёт прямо по старой ссылке). Начало видео — из кэша кусков (serveVideoRange), остальное — сеть.
  if (isMediaRangeRequest(e.request, location.origin)) {
    e.respondWith(fileKeyOf(store, fileIdFrom(e.request.url)).catch(() => null)
      .then((raw) => (raw ? serveEncryptedRange(store, e.request, raw, (u, range) => corsRange(u, range)) : serveVideoRange(store, e.request, rangeFromNetwork, (u, range) => corsRange(u, range))))
      .then(({ response, background }) => { if (background) e.waitUntil(background); return response; })
      .catch(() => fetch(e.request)));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin || API.test(url.pathname) || url.pathname === '/version.json' || url.pathname === '/sw.js') return;
  if (e.request.mode === 'navigate') {
    // свежая разметка, но плохая сеть не держит дольше 3 с — тогда оболочка из кэша
    e.respondWith(networkFirst(e.request, async () => (await caches.open(CACHE)).match('/')).catch(() => Response.error()));
    return;
  }
  // Сначала кэш этой сборки. Он и есть версия: имя CACHE содержит __BUILD__, новая сборка меняет sw.js →
  // ставится новый SW со своим кэшем, старый удаляется в activate. Поэтому в пределах сборки файл не меняется,
  // и перекачивать его на каждой загрузке (как было при «сначала сеть») незачем. Чего нет в кэше — из сети и в кэш.
  if (url.search) return;   // с параметрами — разовые адреса: только сеть, в кэш оболочки не копим
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await verified(await fetch(e.request), url.pathname, INTEGRITY);   // в кэш и странице — только проверенное
      if (res.ok && res.status === 200) e.waitUntil(c.put(e.request, res.clone()));
      return res;
    }).catch((err) => { console.error('sw:', err); return Response.error(); }),
  );
});

/** Иконка уведомлений служебного чата Relay (официальный аккаунт). */
const SYSTEM_ICON = '/relay-logo-192.png';

// Web Push: сервер шлёт, когда у пользователя нет ни одной живой вкладки. Окно в фокусе — не мешаем.
sw.addEventListener('push', (e) => {
  const d = (() => { try { return e.data?.json() as { chatId: number; id: number; title: string; body: string; system?: boolean }; } catch { return null; } })();
  if (!d) return;
  e.waitUntil((async () => {
    const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => (w as WindowClient).focused)) return;
    await sw.registration.showNotification(d.title, { body: d.body, tag: 'chat-' + d.chatId, data: { chatId: d.chatId }, ...(d.system ? { icon: SYSTEM_ICON } : {}) });
  })());
});

// клик: есть вкладка — поднимаем её и открываем чат, нет — новая вкладка сразу на чате
sw.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const chatId = Number(e.notification.data?.chatId) || null;
  const threadId = Number(e.notification.data?.threadId) || null;   // комментарий в треде — открыть тред
  e.waitUntil((async () => {
    const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins[0] as WindowClient | undefined;
    if (win) {
      await win.focus();
      if (chatId) win.postMessage({ type: 'openChat', chatId, ...(threadId ? { threadId } : {}) });
    } else await sw.clients.openWindow(chatId ? '/#chat=' + chatId + (threadId ? '&thread=' + threadId : '') : '/');
  })());
});

// браузер сменил подписку (истекла / ключи) — переподписываемся и сообщаем серверу; cookie сессии уходит сам
sw.addEventListener('pushsubscriptionchange', (ev) => {
  const e = ev as ExtendableEvent;
  e.waitUntil((async () => {
    const { key } = await (await fetch('/push/key')).json() as { key: string };
    const bytes = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = await sw.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    // muted / hideText сервер переносит с прежнего endpoint
    const oldEndpoint = (e as ExtendableEvent & { oldSubscription?: PushSubscription | null }).oldSubscription?.endpoint;
    await fetch('/push/subscription', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...sub.toJSON(), oldEndpoint }) });
  })().catch(() => {}));
});
