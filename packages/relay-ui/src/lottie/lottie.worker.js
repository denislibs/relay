// Воркер рендера Lottie на tlottie (WASM). Только рисует: кадры отдаёт ImageBitmap (передача без копии),
// кэш и часы — в основном потоке (pool.js / player.js). Операции одной анимации идут строго по очереди.
/// <reference lib="webworker" />

const MAX_JSON = 8 << 20;   // распакованный .tgs больше 8 МиБ — отказ (защита от zip-бомбы)
const FPS_CAP = 60, SMALL_FPS_CAP = 30, SMALL_PX = 100;

let wasm = null;            // Promise<exports>
const items = new Map();    // id → { inst, px, data: ImageData, queue: Promise }

// крошечный модуль с инструкцией SIMD: validate() — есть ли поддержка
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

async function instantiate(url) {
  const res = await fetch(url);
  try { return (await WebAssembly.instantiateStreaming(res.clone(), {})).instance.exports; }
  catch { return (await WebAssembly.instantiate(await res.arrayBuffer(), {})).instance.exports; }   // сервер без application/wasm
}

async function readJson(url) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error('fetch ' + res.status);
  const plain = url.endsWith('.json') || (res.headers.get('content-type') ?? '').startsWith('application/json');
  const reader = (plain ? res.body : res.body.pipeThrough(new DecompressionStream('gzip'))).getReader();
  const parts = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_JSON) { reader.cancel(); throw new Error('too large'); }
    parts.push(value);
  }
  const out = new Uint8Array(size); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function open(id, url, px) {
  const t = await wasm;
  const json = await readJson(url);
  const ptr = t.tlottie_alloc(json.length);
  if (!ptr) throw new Error('alloc');
  new Uint8Array(t.memory.buffer).set(json, ptr);
  const inst = t.tlottie_new(ptr, json.length);
  t.tlottie_free(ptr, json.length);
  if (!inst) throw new Error('bad lottie');
  const srcFps = Math.max(1, Math.min(FPS_CAP, Math.round(t.tlottie_frame_rate(inst)) || 60));
  // мелкие — 30 fps прореживанием, если исходные делятся нацело (60 → каждый второй кадр)
  const cap = px < SMALL_PX ? SMALL_FPS_CAP : FPS_CAP;
  const step = srcFps > cap && srcFps % cap === 0 ? srcFps / cap : 1;
  items.set(id, { inst, px, data: new ImageData(px, px) });
  return { frames: t.tlottie_frame_count(inst), fps: srcFps, step };
}

async function frame(id, i) {
  const t = await wasm, it = items.get(id);
  if (!it) return null;
  const ptr = t.tlottie_render(it.inst, i, it.px, it.px, 1);
  if (!ptr) throw new Error('render');
  it.data.data.set(new Uint8ClampedArray(t.memory.buffer, ptr, it.px * it.px * 4));
  return createImageBitmap(it.data);
}

async function close(id) {
  const t = await wasm, it = items.get(id);
  if (!it) return;
  items.delete(id);
  t.tlottie_drop(it.inst);
}

const queues = new Map();
function enqueue(id, fn) {
  const next = (queues.get(id) ?? Promise.resolve()).then(fn, fn);
  queues.set(id, next.catch(() => {}));
  next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => {});
  return next;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'init') {
    wasm ??= instantiate(WebAssembly.validate(SIMD_PROBE) ? m.simd : m.noSimd);
    return;
  }
  if (m.t === 'open') {
    enqueue(m.id, () => open(m.id, m.url, m.px))
      .then((info) => postMessage({ t: 'opened', id: m.id, ...info }), (err) => postMessage({ t: 'error', id: m.id, error: String(err?.message ?? err) }));
  } else if (m.t === 'frame') {
    enqueue(m.id, () => frame(m.id, m.i))
      .then((bmp) => bmp ? postMessage({ t: 'frame', id: m.id, i: m.i, bmp }, [bmp]) : postMessage({ t: 'frame', id: m.id, i: m.i, bmp: null }),
        (err) => postMessage({ t: 'error', id: m.id, i: m.i, error: String(err?.message ?? err) }));
  } else if (m.t === 'close') {
    enqueue(m.id, () => close(m.id));
  }
};
