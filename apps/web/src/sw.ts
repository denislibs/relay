/// <reference lib="webworker" />
// Кэш оболочки приложения: холодный старт без сети. Вложения (/files/<id> → 302 на подписанную ссылку хранилища) —
// свой кэш relay-media (mediaCache.ts), ключ — /files/<id>, сама ссылка в кэш не попадает. Остальной API и WebSocket — только сеть.
import { fetchMedia, isMediaRequest, loadPolicy, savePolicy, serveMedia, sweepMedia, type MediaPolicy } from './mediaCache';
declare const __BUILD__: string;
const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = 'relay-shell-' + __BUILD__;
const SHELL = ['/', '/main.js', '/relay.css', '/tokens.css', '/app.css', '/shared.worker.js', '/dedicated.worker.js', '/spoiler.worker.js', '/dotlottie-player.wasm', '/sounds/message.mp3', '/sounds/sent.mp3'];   // звуки сообщений — и без сети
const API = /^\/(health|me|users|contacts|settings|privacy|blocks|chats|presence|search|uploads|files|push|sessions|ws|dev|logout)(\/|$)/;

sw.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('relay-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim())
      .then(() => sweep()),
  );
});

// Очистка медиа: при старте SW, раз в SWEEP_EVERY новых записей и когда страница меняет политику.
const SWEEP_EVERY = 20;
let stored = 0;
let sweeping: Promise<unknown> | null = null;
function sweep(policy?: MediaPolicy): Promise<unknown> {
  sweeping ??= (async () => sweepMedia(caches, policy ?? await loadPolicy(caches)))().catch(() => {}).finally(() => { sweeping = null; });
  return sweeping;
}

sw.addEventListener('message', (e) => {
  const d = e.data as { type?: string; keepDays?: number; maxMb?: number } | null;
  if (d?.type !== 'mediaPolicy') return;
  const p: MediaPolicy = { keepDays: Math.max(0, Number(d.keepDays) || 0), maxMb: Math.max(0, Number(d.maxMb) || 0) };
  e.waitUntil(savePolicy(caches, p).then(() => sweep(p)).catch(() => {}));
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
    e.respondWith(serveMedia(caches, e.request, (r) => fetchMedia(r)).then(({ response, background, stored: put }) => {
      if (background) e.waitUntil(background.then(() => { if (put && ++stored % SWEEP_EVERY === 0) return sweep(); }));
      return response;
    }));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin || API.test(url.pathname) || url.pathname === '/version.json') return;
  if (e.request.mode === 'navigate') {
    // свежая разметка, но плохая сеть не держит дольше 3 с — тогда оболочка из кэша
    e.respondWith(networkFirst(e.request, async () => caches.match('/')).catch(() => Response.error()));
    return;
  }
  // имена файлов без хэша: сначала сеть (свежая сборка), кэш — когда сети нет
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(async () => (await caches.match(e.request)) ?? Response.error()),
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
