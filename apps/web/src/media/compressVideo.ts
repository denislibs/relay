import { asset } from '../assets';
import type { FromWorker, ToWorker } from './videoTranscode.worker';

/** «Качество» в окне отправки видео: пережать в браузере до 720p/1080p или отправить как есть. */
export type VideoQuality = 'original' | '720' | '1080';

type Mod = { transcode(file: Blob, o: { short: number; onProgress?: (p: number) => void; signal?: AbortSignal }): Promise<Blob | null> };
let modP: Promise<Mod> | null = null;
/** Mediabunny в странице — запасной путь, если поток не поднялся или в нём нет WebCodecs (адрес — не литерал: сборщик не втягивает его в основной бандл). */
function load(): Promise<Mod> {
  const url = asset('videoTranscode.js');
  return (modP ??= (import(/* @vite-ignore */ url) as Promise<Mod>).catch((e) => { modP = null; throw e; }));
}

/** Поток не годится (не загрузился, нет WebCodecs) — сжимаем в странице. */
const UNSUPPORTED = Symbol('unsupported');
/** После первого отказа потока не пробуем его снова: браузер тот же. */
let workerBroken = false;

/**
 * Сжатие в отдельном Worker: главный поток свободен, лента и ввод не дёргаются. Новый поток на каждое видео —
 * отмена мгновенная (terminate), а память Mediabunny уходит вместе с потоком.
 */
export function transcodeInWorker(file: Blob, short: number, onProgress?: (p: number) => void, signal?: AbortSignal,
  spawn: () => Worker = () => new Worker(asset('videoTranscode.worker.js'), { type: 'module' })): Promise<Blob | null | typeof UNSUPPORTED> {
  if (workerBroken) return Promise.resolve(UNSUPPORTED);
  return new Promise((resolve, reject) => {
    let w: Worker;
    try { w = spawn(); } catch { workerBroken = true; resolve(UNSUPPORTED); return; }
    let started = false;
    const finish = () => { signal?.removeEventListener('abort', abort); w.terminate(); };
    const abort = () => { finish(); resolve(null); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      started = true;
      if (m.type === 'progress') onProgress?.(m.p);
      else if (m.type === 'done') { finish(); resolve(m.out); }
      else if (m.type === 'error') { finish(); reject(new Error(m.message)); }
      else if (m.type === 'unsupported') { workerBroken = true; finish(); resolve(UNSUPPORTED); }
    };
    // скрипт потока не загрузился (CSP, сеть, старый браузер) — это не ошибка видео: пусть сожмёт страница
    w.onerror = (e) => { e.preventDefault?.(); finish(); if (started) reject(new Error('video worker failed')); else { workerBroken = true; resolve(UNSUPPORTED); } };
    w.postMessage({ type: 'run', file, short } satisfies ToWorker);
  });
}

/** Для тестов: снова пробовать поток. */
export function resetVideoWorkerForTests(): void { workerBroken = false; }

let supportP: Promise<boolean> | null = null;
/**
 * Умеет ли браузер кодировать H.264 через WebCodecs (Chrome, Edge, Safari 17+; Firefox — нет на части систем).
 * Нет — в окне отправки не предлагаем «Качество», видео уходит оригиналом. Замер: 30 с 1080p → 720p за ~3,4 с (M-серия, аппаратный кодек).
 */
export function videoCompressSupported(): Promise<boolean> {
  return (supportP ??= (async () => {
    if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined' || typeof AudioEncoder === 'undefined') return false;
    try {
      const v = await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1280, height: 720, bitrate: 2_500_000, framerate: 30 });
      const a = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 });
      return !!v.supported && !!a.supported;
    } catch { return false; }
  })());
}

/**
 * Пережать видео перед отправкой. Не умеет браузер, сжатие не помогло или файл уже лёгкий — тот же файл.
 * onProgress — 0…1 (плашка «Сжатие видео · N%»), signal — отмена из плашки (тогда AbortError: не отправлять).
 */
export async function compressVideo(file: File, quality: VideoQuality, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<File> {
  if (quality === 'original' || !(await videoCompressSupported())) return file;
  const short = Number(quality);
  let out = await transcodeInWorker(file, short, onProgress, signal);
  if (out === UNSUPPORTED) out = await (await load()).transcode(file, { short, onProgress, signal });
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
  if (!out) return file;
  return new File([out], (file.name || 'video').replace(/\.[a-z0-9]{2,5}$/i, '') + '.mp4', { type: 'video/mp4', lastModified: file.lastModified });
}
