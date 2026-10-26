// Первый кадр стикера, сохранённый с прошлого показа: со второго раза вместо силуэта сразу картинка.
// На диске — Cache Storage (переживает перезагрузку), в памяти — до 64 адресов blob: (старые освобождаем).
import { isHeavyAnimating, onHeavyAnimationEnd } from '../schedule.js';

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
// кодирование PNG идёт в главном потоке: по одному кадру за простой и только если в нём есть время —
// иначе первая прокрутка панели стикеров кодировала десятки превью посреди кадров
const toEncode = [];
let encodeScheduled = false;
const idle = (fn) => (self.requestIdleCallback ? self.requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(() => fn({ timeRemaining: () => 50, didTimeout: true }), 200));
function encodeOne(deadline) {
  encodeScheduled = false;
  // кодирование одного PNG длиннее остатка простоя (≈30 мс при слабом CPU): во время тяжёлой анимации его не начинаем
  if (toEncode.length && isHeavyAnimating()) { encodeScheduled = true; onHeavyAnimationEnd(() => idle(encodeOne)); return; }
  if (toEncode.length && (deadline.didTimeout || deadline.timeRemaining() > 12)) {
    const { key, c } = toEncode.shift();
    c.convertToBlob({ type: 'image/png' })
      .then((blob) => caches.open(CACHE).then((cache) => cache.put(req(key), new Response(blob, { headers: { 'content-type': 'image/png' } }))))
      .catch(() => saved.delete(key));
  }
  if (toEncode.length) { encodeScheduled = true; idle(encodeOne); }
}

export function savePreview(key, bmp) {
  if (saved.has(key) || typeof caches === 'undefined' || typeof OffscreenCanvas === 'undefined') return;
  saved.add(key);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  toEncode.push({ key, c });
  if (!encodeScheduled) { encodeScheduled = true; idle(encodeOne); }
}
