/// <reference lib="webworker" />
// Кэш оболочки приложения: холодный старт без сети. API и WebSocket — только сеть.
declare const __BUILD__: string;
const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = 'relay-shell-' + __BUILD__;
const SHELL = ['/', '/main.js', '/relay.css', '/tokens.css', '/app.css', '/shared.worker.js', '/dedicated.worker.js'];
const API = /^\/(health|me|users|contacts|settings|chats|presence|search|upload|files|push|ws|dev)(\/|$)/;

sw.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('relay-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || API.test(url.pathname)) return;
  if (e.request.mode === 'navigate') {
    // свежая разметка при сети, кэш — без неё
    e.respondWith(fetch(e.request).catch(async () => (await caches.match('/')) ?? Response.error()));
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

// Web Push: сервер шлёт, когда у пользователя нет ни одной живой вкладки. Окно в фокусе — не мешаем.
sw.addEventListener('push', (e) => {
  const d = (() => { try { return e.data?.json() as { chatId: number; id: number; title: string; body: string }; } catch { return null; } })();
  if (!d) return;
  e.waitUntil((async () => {
    const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => (w as WindowClient).focused)) return;
    await sw.registration.showNotification(d.title, { body: d.body, tag: 'chat-' + d.chatId, data: { chatId: d.chatId } });
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
    await fetch('/push/subscription', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
  })().catch(() => {}));
});
