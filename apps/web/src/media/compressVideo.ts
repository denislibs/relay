import { asset } from '../assets';

/** «Качество» в окне отправки видео: пережать в браузере до 720p/1080p или отправить как есть. */
export type VideoQuality = 'original' | '720' | '1080';

type Mod = { transcode(file: Blob, o: { short: number; onProgress?: (p: number) => void; signal?: AbortSignal }): Promise<Blob | null> };
let modP: Promise<Mod> | null = null;
/** Mediabunny — отдельным бандлом, при первом сжатии (адрес — не литерал: сборщик не втягивает его в основной бандл). */
function load(): Promise<Mod> {
  const url = asset('videoTranscode.js');
  return (modP ??= (import(/* @vite-ignore */ url) as Promise<Mod>).catch((e) => { modP = null; throw e; }));
}

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
  const mod = await load();
  const out = await mod.transcode(file, { short: Number(quality), onProgress, signal });
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
  if (!out) return file;
  return new File([out], (file.name || 'video').replace(/\.[a-z0-9]{2,5}$/i, '') + '.mp4', { type: 'video/mp4', lastModified: file.lastModified });
}
