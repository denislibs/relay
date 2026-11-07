import { asset } from '../assets';

/**
 * Размытие фона в звонке (этап 3 docs/plans/2026-11-07-relay-calls-features.md). Всё на устройстве: MediaPipe Selfie
 * Segmentation (Apache-2.0, файлы — со своего адреса с хэшем, build.ts) отделяет человека, фон размывается на холсте,
 * собеседник получает уже размытую дорожку (canvas.captureStream). Сервер и пересыльщики размытия не делают.
 *
 * Кадры — по таймеру, не по requestAnimationFrame: во время звонка вкладка звучит, и таймеры в скрытой вкладке не
 * замедляются, а rAF в ней стоит бы — собеседник увидел бы застывший кадр. Исходный кадр без размытия наружу не уходит
 * никогда: пока маски нет, на выходе только размытый кадр целиком.
 */

const FPS = 24;
const BLUR_PX = 14;
const SLOW_MS = 30;          // дольше на кадр три секунды подряд — сегментация реже (через кадр)

type Results = { image: CanvasImageSource; segmentationMask: CanvasImageSource };
type Segmenter = {
  setOptions(o: { modelSelection: number; selfieMode?: boolean }): void;
  onResults(cb: (r: Results) => void): void;
  initialize(): Promise<void>;
  send(i: { image: HTMLVideoElement }): Promise<void>;
  close(): Promise<void>;
};

let shared: Promise<{ seg: Segmenter; draw: (r: Results) => void; set(fn: (r: Results) => void): void }> | null = null;

/** Один сегментатор на вкладку (модель и wasm грузятся один раз); результаты — текущему потребителю. */
function segmenter() {
  return shared ??= (async () => {
    const mod = await import('@mediapipe/selfie_segmentation') as { SelfieSegmentation?: new (c: { locateFile: (f: string) => string }) => Segmenter };
    const Ctor = mod.SelfieSegmentation ?? (globalThis as { SelfieSegmentation?: typeof mod.SelfieSegmentation }).SelfieSegmentation;
    if (!Ctor) throw new Error('selfie segmentation: no constructor');
    const seg = new Ctor({ locateFile: (f) => asset('mediapipe/' + f) });
    seg.setOptions({ modelSelection: 1, selfieMode: false });   // 1 — «пейзажная» модель (256×144): быстрее, для видеозвонка
    let sink: (r: Results) => void = () => {};
    seg.onResults((r) => sink(r));
    await seg.initialize();
    return { seg, draw: (r: Results) => sink(r), set(fn: (r: Results) => void) { sink = fn; } };
  })().catch((e) => { shared = null; throw e; });
}

/** Подгрузить заранее (настройки, кнопка в звонке), чтобы включение было без паузы. */
export function warmBackground(): void { void segmenter().catch(() => {}); }

/**
 * Размытая копия дорожки камеры. stop() у результата останавливает обработку и исходную камеру (кто взял камеру,
 * тот и останавливает — дальше она не нужна). Ошибка загрузки модели — исключение: вызывающий берёт камеру как есть.
 */
export async function blurredCamera(src: MediaStreamTrack, o: { ownSource?: boolean } = {}): Promise<MediaStreamTrack> {
  const own = o.ownSource !== false;
  const { seg, set } = await segmenter();
  const s = src.getSettings();
  const w = s.width ?? 640, h = s.height ?? 480;
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  video.srcObject = new MediaStream([src]);
  await video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d')!;
  const out = canvas.captureStream(FPS).getVideoTracks()[0];

  // кадр: маска → человек (source-in) → под ним размытый кадр (destination-over)
  const paint = (r: Results) => {
    g.save();
    g.clearRect(0, 0, w, h);
    g.filter = 'none';
    g.globalCompositeOperation = 'copy';
    g.drawImage(r.segmentationMask, 0, 0, w, h);
    g.globalCompositeOperation = 'source-in';
    g.drawImage(r.image, 0, 0, w, h);
    g.globalCompositeOperation = 'destination-over';
    g.filter = `blur(${BLUR_PX}px)`;
    g.drawImage(r.image, 0, 0, w, h);
    g.restore();
  };
  const blurAll = () => { g.save(); g.filter = `blur(${BLUR_PX}px)`; g.drawImage(video, 0, 0, w, h); g.restore(); };

  let stopped = false, slowSince = 0, skip = false, odd = false;
  const tick = async () => {
    if (stopped) return;
    const t0 = performance.now();
    if (video.readyState >= 2) {
      odd = !odd;
      if (skip && odd) blurAll();   // медленное устройство: через кадр — без маски, но всё равно размыто
      else {
        set(paint);
        try { await seg.send({ image: video }); } catch { blurAll(); }
      }
    }
    const spent = performance.now() - t0;
    if (spent > SLOW_MS) { slowSince ||= t0; if (t0 - slowSince > 3000) skip = true; } else slowSince = 0;
    if (!stopped) setTimeout(() => void tick(), Math.max(0, 1000 / FPS - spent));
  };
  void tick();

  const stopOut = out.stop.bind(out);
  out.stop = () => { stopped = true; stopOut(); if (own) src.stop(); video.srcObject = null; };
  // камеру отключили снаружи (выдернули, отозвали разрешение) — выход тоже кончается
  src.addEventListener('ended', () => out.stop(), { once: true });
  return out;
}

/**
 * Обработчик дорожки для LiveKit (групповой звонок): камерой владеет LiveKit, размытие — поверх неё
 * (LocalVideoTrack.setProcessor). Исходную камеру не останавливаем — это делает LiveKit.
 */
export function blurProcessor() {
  let out: MediaStreamTrack | undefined;
  const p = {
    name: 'relay-blur',
    processedTrack: undefined as MediaStreamTrack | undefined,
    async init(opts: { track: MediaStreamTrack }) { out = await blurredCamera(opts.track, { ownSource: false }); p.processedTrack = out; },
    async restart(opts: { track: MediaStreamTrack }) { out?.stop(); await p.init(opts); },
    async destroy() { out?.stop(); out = undefined; p.processedTrack = undefined; },
  };
  return p;
}
