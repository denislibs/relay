// Сжатие видео в отдельном потоке (build.ts → videoTranscode.worker.js): Mediabunny разбирает, масштабирует
// и кодирует кадры — в странице это занимало главный поток почти целиком (замер ×4: 5,8 с из 6,6 с) и лента дёргалась.
// Протокол: { type: 'run', file, short } → { type: 'progress', p }…, затем { type: 'done', out } | { type: 'error', message };
// { type: 'unsupported' } — в потоке нет WebCodecs: страница сожмёт сама (прежний путь). Отмена — terminate() со стороны страницы.
import { transcode } from './videoTranscode';

export type ToWorker = { type: 'run'; file: Blob; short: number };
export type FromWorker =
  | { type: 'progress'; p: number }
  | { type: 'done'; out: Blob | null }
  | { type: 'error'; message: string }
  | { type: 'unsupported' };

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m?.type !== 'run') return;
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined' || typeof AudioEncoder === 'undefined') { post({ type: 'unsupported' }); return; }
  let last = 0;
  try {
    const out = await transcode(m.file, {
      short: m.short,
      // прогресс — не чаще 20 раз в секунду: каждое сообщение будит главный поток
      onProgress: (p) => { const now = performance.now(); if (now - last < 50) return; last = now; post({ type: 'progress', p }); },
    });
    post({ type: 'done', out });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
