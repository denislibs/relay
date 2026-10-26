import { forceMeasure } from '@relay/ui';

/**
 * Программная прокрутка ленты со своим таймингом (как animateScroll в Telegram), а не behavior:'smooth':
 * у браузерной «плавной» ни длительность не задаётся, ни цель на ходу не меняется. Цель — функция: читается
 * каждый кадр, так что пока едем к низу, пришедшее сообщение сдвигает цель, и мы доезжаем до нового низа без
 * перезапуска. Кадр — одно чтение и одна запись (осознанное исключение, forceMeasure): это сама анимация.
 */
export const DRIVE_MS = 300;       // чужое сообщение, кнопка «вниз», переход к сообщению
export const DRIVE_OWN_MS = 200;   // своё сообщение: отправил — сразу видишь

export type DriveOpts = {
  ms: number;
  target: () => number;             // куда едем (читается каждый кадр)
  start?: number;                   // прыжок перед доездом (далеко — сначала на экран от цели)
  since?: number;                   // момент старта (performance.now): первый кадр уже едет, а не только засекает время
  curve?: readonly [number, number, number, number];   // своя кривая cubic-bezier (полёт отправленного — sendFlight)
  onEnd?: (reason: 'done' | 'cancel') => void;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
};
export type Drive = { cancel: () => void; readonly active: boolean };

const ease = (p: number) => 1 - (1 - p) ** 3;   // ease-out cubic — близко к cubic-bezier(.2, 0, 0, 1)

/** cubic-bezier(x1, y1, x2, y2) как функция времени: x(t) обращаем Ньютоном (с запасным делением пополам). */
export function bezier(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t, sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (p: number) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 8; i++) { const e = sx(t) - p, d = dx(t); if (Math.abs(e) < 1e-6) return sy(t); if (Math.abs(d) < 1e-6) break; t -= e / d; }
    let lo = 0, hi = 1; t = p;
    for (let i = 0; i < 30; i++) { const v = sx(t); if (Math.abs(v - p) < 1e-6) break; if (v < p) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sy(t);
  };
}

let drives = 0;
/** Сколько программных прокруток едет сейчас (запись кадров в разделе разработчика помечает ими кадры). */
export const activeDrives = (): number => drives;

export function driveScroll(root: { scrollTop: number }, o: DriveOpts): Drive {
  const raf = o.raf ?? ((cb) => requestAnimationFrame(cb)), caf = o.caf ?? ((id) => cancelAnimationFrame(id));
  const now = o.now ?? (() => performance.now());
  let id = 0, t0 = -1, from = 0, lastTo = NaN, active = true;
  const curve = o.curve ? bezier(...o.curve) : ease;
  drives++;
  const finish = (reason: 'done' | 'cancel') => { if (!active) return; active = false; drives--; caf(id); o.onEnd?.(reason); };
  const frame = () => {
    if (!active) return;
    forceMeasure(() => {
      if (t0 < 0) {   // первый кадр: прыжок, если просили, и точка старта
        t0 = o.since ?? now();
        if (o.start != null) root.scrollTop = o.start;
        from = root.scrollTop;
        lastTo = o.target();
        // старт задан заранее (строка появилась кадр назад, а поле ввода уже сжимается) — едем с этого же кадра
        if (o.since == null) { id = raf(frame); return; }
      }
      const to = o.target();
      // цель сдвинулась (пришло ещё сообщение, подросла картинка) — новая кривая от текущего места, без скачка
      if (to !== lastTo) { from = root.scrollTop; t0 = now(); lastTo = to; }
      const p = Math.min(1, (now() - t0) / o.ms);
      root.scrollTop = p >= 1 ? to : from + (to - from) * curve(p);
      if (p >= 1) finish('done'); else id = raf(frame);
    });
  };
  id = raf(frame);
  return { cancel: () => finish('cancel'), get active() { return active; } };
}

/** Серия сообщений подряд: анимируем первые maxMs серии, дальше — мгновенно, пока не будет паузы gapMs. */
export type Burst = { since: number; last: number };
export function burstAnimates(b: Burst, now: number, maxMs = 600, gapMs = 300): boolean {
  if (!b.last || now - b.last > gapMs) b.since = now;   // пауза — новая серия
  b.last = now;
  return now - b.since <= maxMs;
}

/** Далеко (больше двух экранов) — сначала прыжок на экран от цели с ближней стороны, плавно — только последний экран. */
export function jumpNear(from: number, to: number, screen: number): number | null {
  if (Math.abs(to - from) <= screen * 2) return null;
  return to > from ? to - screen : to + screen;
}
