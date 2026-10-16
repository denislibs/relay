/// <reference lib="webworker" />
// Кэш оболочки приложения: холодный старт без сети. API и WebSocket — только сеть.
declare const __BUILD__: string;
const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = 'relay-shell-' + __BUILD__;
const SHELL = ['/', '/main.js', '/relay.css', '/tokens.css', '/app.css', '/shared.worker.js', '/dedicated.worker.js'];
const API = /^\/(health|me|chats|ws|dev)(\/|$)/;

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
  e.respondWith(
    caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })),
  );
});
