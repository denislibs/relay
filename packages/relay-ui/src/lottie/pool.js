// Пул воркеров рендера Lottie. Одна анимация (адрес + сторона в пикселях) = один рендерер на всё приложение:
// сколько бы одинаковых стикеров ни было на экране — один экземпляр WASM, один кэш кадров.
// Ключ всегда попадает в один и тот же воркер (хэш), воркеров — не больше четырёх, создаются по требованию.

let config = null;           // { workerUrl, wasm: { simd, noSimd } }
let makeWorker = (url) => new Worker(url, { type: 'module', name: 'relay-lottie' });
const workers = [];
const renderers = new Map(); // key → Renderer
let nextId = 1;

/** Где лежат воркер и WASM (адреса из сборки). Без вызова стикеры остаются статичными. */
export function configureLottie(opts) { config = opts; }

/** Тесты: подменить конструктор воркера и сбросить состояние. */
export function __setWorkerFactory(fn) {
  makeWorker = fn;
  workers.length = 0;
  renderers.clear();
}

export const lottieAvailable = () => !!config;

const poolSize = () => Math.max(1, Math.min(4, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4));

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function workerFor(key) {
  const n = hash(key) % poolSize();
  if (!workers[n]) {
    const w = makeWorker(config.workerUrl);
    const waiting = new Map();   // id → { opened, frames: Map<i, resolve> }
    w.onmessage = (e) => {
      const m = e.data, slot = waiting.get(m.id);
      if (!slot) { m.bmp?.close?.(); return; }   // рендерер уже закрыт — поздний кадр выбрасываем
      if (m.t === 'opened') slot.opened.resolve(m);
      else if (m.t === 'frame') { const r = slot.frames.get(m.i); slot.frames.delete(m.i); if (r) r.resolve(m.bmp); else m.bmp?.close?.(); }
      else if (m.t === 'error') {
        if (m.i == null) slot.opened.reject(new Error(m.error));
        else { const r = slot.frames.get(m.i); slot.frames.delete(m.i); r?.reject(new Error(m.error)); }
      }
    };
    w.postMessage({ t: 'init', simd: config.wasm.simd, noSimd: config.wasm.noSimd });
    workers[n] = { w, waiting };
  }
  return workers[n];
}

/** Доля кэша: мелкие держим целиком, у крупных выбрасываем каждый четвёртый кадр (память ограничена, пересчёт редкий). */
const keepFrame = (px, i) => px < 100 || i === 0 || i % 4 !== 0;

class Renderer {
  constructor(key, url, px) {
    this.key = key; this.px = px; this.refs = 1; this.id = nextId++;
    this.cache = new Map();      // i → ImageBitmap
    this.pending = new Map();    // i → Promise<ImageBitmap>
    this.slot = workerFor(key);
    let resolve, reject;
    const opened = new Promise((a, b) => { resolve = a; reject = b; });
    this.slot.waiting.set(this.id, { opened: { resolve, reject }, frames: new Map() });
    this.slot.w.postMessage({ t: 'open', id: this.id, url, px });
    this.ready = opened.then((info) => { this.frames = info.frames; this.fps = info.fps; this.step = info.step; return this; });
  }

  /** Кадр i (из кэша или из воркера). Одновременные запросы одного кадра — один рендер. */
  frame(i) {
    const hit = this.cache.get(i);
    if (hit) return Promise.resolve(hit);
    const inflight = this.pending.get(i);
    if (inflight) return inflight;
    const slot = this.slot.waiting.get(this.id);
    if (!slot) return Promise.reject(new Error('closed'));
    const p = new Promise((resolve, reject) => slot.frames.set(i, { resolve, reject })).then((bmp) => {
      this.pending.delete(i);
      if (this.refs > 0 && bmp && keepFrame(this.px, i)) this.cache.set(i, bmp);
      return bmp;
    }, (err) => { this.pending.delete(i); throw err; });
    this.pending.set(i, p);
    this.slot.w.postMessage({ t: 'frame', id: this.id, i });
    return p;
  }

  /** Пауза: оставить в памяти только показанный кадр. */
  trim(keep) {
    for (const [i, bmp] of this.cache) if (i !== keep) { bmp.close?.(); this.cache.delete(i); }
  }

  /** Ушёл из вида: кадры больше не нужны. */
  drop() { this.trim(-1); }

  release() {
    if (--this.refs > 0) return;
    renderers.delete(this.key);
    this.drop();
    this.slot.waiting.delete(this.id);
    this.slot.w.postMessage({ t: 'close', id: this.id });
  }
}

/**
 * Рендерер анимации url в квадрате px×px (физические пиксели). Одинаковый ключ — общий экземпляр;
 * каждый вызов обязан закончиться release().
 */
export function openRenderer({ url, px }) {
  if (!config) return Promise.reject(new Error('lottie is not configured'));
  const key = url + '|' + px;
  const hit = renderers.get(key);
  if (hit) { hit.refs++; return hit.ready; }
  const r = new Renderer(key, url, px);
  renderers.set(key, r);
  r.ready.catch(() => { if (renderers.get(key) === r) renderers.delete(key); });
  return r.ready;
}

/** Отладка и тесты: живые рендереры. */
export const liveRenderers = () => renderers.size;
