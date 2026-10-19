// Отдельный бандл (build.ts → videoTranscode.js): Mediabunny (MPL-2.0) + WebCodecs, грузится при первом сжатии видео.
// Пережимает в MP4 H.264 + AAC: короткая сторона — 720 или 1080 px, moov в начале (видео играет, пока докачивается).
// null — сжимать незачем (уже не больше нужного и битрейт невысокий) или нечем (браузер не умеет кодек): шлём оригинал.
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } from 'mediabunny';

export interface TranscodeOpts { short: number; onProgress?: (p: number) => void; signal?: AbortSignal }

/** Битрейт видео по короткой стороне (как у Telegram примерно: 720p ≈ 2.5 Мбит/с, 1080p ≈ 5). */
const BITRATE: Record<number, number> = { 720: 2_500_000, 1080: 5_000_000 };
/** Дольше — не трогаем: выход держится в памяти вкладки. */
const MAX_SECONDS = 30 * 60;

export async function transcode(file: Blob, o: TranscodeOpts): Promise<Blob | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const duration = await input.computeDuration();
    if (!duration || duration > MAX_SECONDS) return null;
    const w = track.displayWidth, h = track.displayHeight;
    const bitrate = BITRATE[o.short] ?? BITRATE[720];
    // уже маленькое и не тяжёлое — перекодирование только потеряет качество
    if (Math.min(w, h) <= o.short && file.size * 8 / duration <= bitrate * 1.4) return null;
    const scale = Math.min(1, o.short / Math.min(w, h));
    // чётные стороны: H.264 4:2:0 иначе не кодируется
    const even = (n: number) => Math.max(2, Math.round(n * scale / 2) * 2);
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conv = await Conversion.init({
      input, output, showWarnings: false,
      video: { width: even(w), height: even(h), fit: 'contain', codec: 'avc', bitrate, hardwareAcceleration: 'prefer-hardware' },
      audio: { codec: 'aac', bitrate: 128_000 },
    });
    if (!conv.isValid || conv.discardedTracks.some((t) => t.track.isVideoTrack())) return null;
    if (o.onProgress) conv.onProgress = (p) => o.onProgress!(p);
    const abort = () => { void conv.cancel(); };
    if (o.signal?.aborted) return null;
    o.signal?.addEventListener('abort', abort, { once: true });
    try { await conv.execute(); } finally { o.signal?.removeEventListener('abort', abort); }
    if (!target.buffer) return null;
    const out = new Blob([target.buffer], { type: 'video/mp4' });
    return out.size < file.size ? out : null;
  } finally {
    input.dispose();
  }
}
