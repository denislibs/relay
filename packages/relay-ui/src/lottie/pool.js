// Пул воркеров рендера Lottie. Одна анимация (адрес + сторона в пикселях) = один рендерер на всё приложение:
// сколько бы одинаковых стикеров ни было на экране — один экземпляр WASM, один кэш кадров.
// Ключ всегда попадает в один и тот же воркер (хэш), воркеров — не больше четырёх, создаются по требованию.

let config = null;           // { workerUrl, wasm: { simd, noSimd } }
let makeWorker = (url) => new Worker(url, { type: 'module', name: 'relay-lottie' });
const workers = [];
const renderers = new Map(); // key → Renderer
let nextId = 1;

// Бюджет памяти кадров. Кадр — px×px×4 байт: 200 px в ленте при 2× (400 физ.) — 640 КБ, 180 кадров — 115 МБ,
// а первый цикл и так рисуется на лету (воркеры успевают 60 кадров/с на стикер). Поэтому:
// — от NO_CACHE_PX физических пикселей не кэшируем вовсе: рисуем на лету, на два кадра вперёд (заготовки);
// — все кэши вместе — не больше budget, одна анимация — не больше восьмой части. Нет места — сначала освобождаем
//   кэши простаивающих (давно не просили кадров), иначе кадр просто не кэшируется. Кэшируется «что влезло первым»,
//   без вытеснения внутри цикла: у зацикленной анимации LRU по кругу давал бы ноль попаданий.
const NO_CACHE_PX = 256;
const IDLE_MS = 1000;            // не просила кадров дольше — простаивает, её кэш можно освободить
const EVICT_EVERY_MS = 500;      // при полном бюджете не перебираем рендереры на каждом кадре
const LOOSE_MAX = 3;             // заготовки: на два шага вперёд + запас
let budget = 32 << 20;
let cachedBytes = 0;
let evictedAt = -Infinity;

/** Тесты: сменить бюджет кэша кадров (байты). */
export function __setFrameBudget(bytes) { budget = bytes; evictedAt = -Infinity; }

/** Где лежат воркер и WASM (адреса из сборки). Без вызова стикеры остаются статичными. */
export function configureLottie(opts) { config = opts; }

/** Тесты: подменить конструктор воркера и сбросить состояние. */
export function __setWorkerFactory(fn) {
  makeWorker = fn;
  workers.length = 0;
  renderers.clear();
  cachedBytes = 0;
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

/** Освободить кэши простаивающих рендереров (давние — первыми), пока не найдётся need байт. */
function evictIdle(need) {
  const now = performance.now();
  if (now - evictedAt < EVICT_EVERY_MS) return;
  evictedAt = now;
  const idle = [];
  for (const r of renderers.values()) if (r.bytes && now - r.used > IDLE_MS) idle.push(r);
  idle.sort((a, b) => a.used - b.used);
  for (const r of idle) {
    if (cachedBytes + need <= budget) break;
    r.trim(-1);
  }
}

class Renderer {
  constructor(key, url, px) {
    this.key = key; this.px = px; this.refs = 1; this.id = nextId++;
    this.size = px * px * 4;     // байт на кадр
    this.bytes = 0;              // байт в кэше
    this.used = performance.now();   // последний запрос кадра (простой → кэш можно освободить)
    this.cache = new Map();      // i → ImageBitmap
    this.loose = new Map();      // некэшируемые кадры, отрисованные заранее: отдаются один раз (владелец закрывает)
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
    this.used = performance.now();
    const hit = this.cache.get(i);
    if (hit) return Promise.resolve(hit);
    const ahead = this.loose.get(i);
    if (ahead) { this.loose.delete(i); return Promise.resolve(ahead); }
    const inflight = this.pending.get(i);
    if (inflight) return inflight;
    const slot = this.slot.waiting.get(this.id);
    if (!slot) return Promise.reject(new Error('closed'));
    const p = new Promise((resolve, reject) => slot.frames.set(i, { resolve, reject })).then((bmp) => {
      this.pending.delete(i);
      if (this.refs > 0 && bmp && this.admit()) { this.cache.set(i, bmp); this.bytes += this.size; cachedBytes += this.size; }
      return bmp;
    }, (err) => { this.pending.delete(i); throw err; });
    this.pending.set(i, p);
    this.slot.w.postMessage({ t: 'frame', id: this.id, i });
    return p;
  }

  /** Есть ли место для ещё одного кадра в кэше (см. бюджет в начале файла). */
  admit() {
    if (this.px >= NO_CACHE_PX || this.bytes + this.size > budget / 8) return false;
    if (cachedBytes + this.size > budget) evictIdle(this.size);
    return cachedBytes + this.size <= budget;
  }

  /** Отрисовать заранее (следующий кадр): кэшируемый ляжет в кэш, остальной — в «заготовку» до первого запроса. */
  prefetch(i) {
    if (this.cache.has(i) || this.loose.has(i) || this.pending.has(i)) return;
    this.frame(i).then((bmp) => {
      if (!bmp || this.cache.get(i) === bmp) return;
      if (this.refs <= 0) { bmp.close?.(); return; }
      this.loose.set(i, bmp);
      while (this.loose.size > LOOSE_MAX) { const [k, b] = this.loose.entries().next().value; this.loose.delete(k); b.close?.(); }
    }, () => {});
  }

  /** Владелец закончил с кадром: некэшированный — освободить. */
  done(i, bmp) {
    if (!bmp || this.cache.get(i) === bmp) return;
    if (this.loose.get(i) === bmp) this.loose.delete(i);   // показали заготовку раньше, чем её взяли
    bmp.close?.();
  }

  /** Пауза: оставить в памяти только показанный кадр. */
  trim(keep) {
    for (const [i, bmp] of this.cache) {
      if (i === keep) continue;
      bmp.close?.(); this.cache.delete(i);
      this.bytes -= this.size; cachedBytes -= this.size;
    }
  }

  /** Ушёл из вида: кадры больше не нужны. */
  drop() {
    this.trim(-1);
    for (const b of this.loose.values()) b.close?.();
    this.loose.clear();
  }

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

/**
 * Для раздела разработчика: рендереры, их кадры в памяти (кэш и заготовки, байты ≈ ширина×высота×4), бюджет кэша и нагрузка
 * на воркеры — сколько кадров каждый сейчас рисует.
 */
export function lottieStats() {
  let cached = 0, loose = 0, pending = 0, bytes = 0;
  const px = (b) => (b && b.width ? b.width * b.height * 4 : 0);
  for (const r of renderers.values()) {
    cached += r.cache.size; loose += r.loose.size; pending += r.pending.size;
    for (const b of r.cache.values()) bytes += px(b);
    for (const b of r.loose.values()) bytes += px(b);
  }
  const pool = Array.from({ length: poolSize() }, (_, i) => workers[i]).map((w, i) => {
    if (!w) return { index: i, started: false, renderers: 0, inflight: 0 };
    let inflight = 0;
    for (const slot of w.waiting.values()) inflight += slot.frames.size;
    return { index: i, started: true, renderers: w.waiting.size, inflight };
  });
  return { renderers: renderers.size, cachedFrames: cached, looseFrames: loose, pendingFrames: pending, bytes, budget, workers: pool, poolSize: poolSize() };
}
