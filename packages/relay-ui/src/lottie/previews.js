// Первый кадр стикера, сохранённый с прошлого показа: со второго раза вместо силуэта сразу картинка.
// На диске — Cache Storage (переживает перезагрузку), в памяти — до 64 адресов blob: (старые освобождаем).
const CACHE = 'relay-sticker-previews';
const MAX_URLS = 64;
const urls = new Map();       // ключ → objectURL (порядок вставки = давность)
const pending = new Map();    // ключ → Promise<string|null>
const saved = new Set();      // уже сохранены в этой сессии

const req = (key) => new Request('/__sticker-preview/' + encodeURIComponent(key));

function remember(key, url) {
  urls.delete(key);
  urls.set(key, url);
  while (urls.size > MAX_URLS) { const [k, u] = urls.entries().next().value; urls.delete(k); URL.revokeObjectURL(u); }
  return url;
}

/** Сохранённое превью — адрес для <img> или null. */
export function getPreview(key) {
  const hit = urls.get(key);
  if (hit) { urls.delete(key); urls.set(key, hit); return Promise.resolve(hit); }
  if (typeof caches === 'undefined') return Promise.resolve(null);
  let p = pending.get(key);
  if (!p) {
    p = caches.open(CACHE).then((c) => c.match(req(key))).then((r) => r ? r.blob() : null)
      .then((b) => b ? remember(key, URL.createObjectURL(b)) : null).catch(() => null)
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

/** Первый показанный кадр → PNG в кэш (один раз на ключ, в простое). */
export function savePreview(key, bmp) {
  if (saved.has(key) || typeof caches === 'undefined' || typeof OffscreenCanvas === 'undefined') return;
  saved.add(key);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  const idle = self.requestIdleCallback ?? ((fn) => setTimeout(fn, 200));
  idle(() => {
    c.convertToBlob({ type: 'image/png' })
      .then((blob) => caches.open(CACHE).then((cache) => cache.put(req(key), new Response(blob, { headers: { 'content-type': 'image/png' } }))))
      .catch(() => saved.delete(key));
  });
}
