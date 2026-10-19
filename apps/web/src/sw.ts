/// <reference lib="webworker" />
// Cache Storage этого приложения:
//   relay-app-shell@<сборка>          — код, стили, воркеры, звуки: холодный старт без сети;
//   relay-attachments-auto-evictable  — вложения, подгруженные сами (уходят по сроку, лимиту и при нехватке места);
//   relay-attachments-saved-by-user   — вложения, скачанные кнопкой (сами не удаляются).
// Сведения о вложениях — в IndexedDB relay-attachments-on-device (mediaCache.ts, attachmentsOnDevice.ts).
// Остальной API и WebSocket — только сеть.
import type { AutoCleanupPolicy } from './attachmentsOnDevice';
import {
  CACHE_APP_SHELL_PREFIX, deviceStore, fetchMedia, isMediaRangeRequest, isMediaRequest, LEGACY_CACHES,
  loadPolicy, migrateLegacyCaches, savePolicy, serveMedia, sweepAuto,
} from './mediaCache';
declare const __BUILD__: string;
const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = CACHE_APP_SHELL_PREFIX + __BUILD__;
const store = deviceStore();
declare const __SHELL__: string[];   // код и стили этой сборки с хэшем в имени (build.ts)
const SHELL = ['/', ...__SHELL__, '/dotlottie-player.wasm', '/sounds/message.mp3', '/sounds/sent.mp3'];   // звуки сообщений — и без сети
const API = /^\/(health|me|users|contacts|settings|privacy|blocks|chats|presence|search|uploads|files|push|sessions|ws|dev|logout|auth|link-preview|groups|join)(\/|$)/;

sw.addEventListener('install', (e) => {
  // мимо HTTP-кэша браузера: новая сборка не должна положить к себе файл прежней
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' })))).then(() => sw.skipWaiting()));
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
  if (d?.type !== 'attachments:set-auto-cleanup-policy') return;
  const p: AutoCleanupPolicy = { keepAutoDays: Math.max(0, Number(d.keepAutoDays) || 0), maxAutoMb: Math.max(0, Number(d.maxAutoMb) || 0) };
  e.waitUntil(savePolicy(store, p).then(() => sweep(p)).catch(() => {}));
});

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

sw.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (isMediaRequest(e.request, location.origin) && e.request.mode !== 'navigate') {
    e.respondWith(serveMedia(store, e.request, (r) => fetchMedia(r)).then(({ response, background, stored: put }) => {
      if (background) e.waitUntil(background.then(() => { if (put && ++stored % SWEEP_EVERY === 0) return sweep(); }));
      return response;
    }));
    return;
  }
  // часть видео/аудио — в сеть как есть, через /files/<id>: плеер не застрянет на истёкшей ссылке хранилища
  // (без SW Chrome после перемотки идёт прямо по старой ссылке). Части не кэшируем: в кэше только целые файлы.
  if (isMediaRangeRequest(e.request, location.origin)) {
    e.respondWith(fetch(e.request));
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
      const res = await fetch(e.request);
      if (res.ok && res.status === 200) e.waitUntil(c.put(e.request, res.clone()));
      return res;
    }).catch(() => Response.error()),
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
  e.waitUntil((async () => {
    const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins[0] as WindowClient | undefined;
    if (win) {
      await win.focus();
      if (chatId) win.postMessage({ type: 'openChat', chatId });
    } else await sw.clients.openWindow(chatId ? '/#chat=' + chatId : '/');
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
