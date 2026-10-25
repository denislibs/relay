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
  onEnd?: (reason: 'done' | 'cancel') => void;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
};
export type Drive = { cancel: () => void; readonly active: boolean };

const ease = (p: number) => 1 - (1 - p) ** 3;   // ease-out cubic — близко к cubic-bezier(.2, 0, 0, 1)

export function driveScroll(root: { scrollTop: number }, o: DriveOpts): Drive {
  const raf = o.raf ?? ((cb) => requestAnimationFrame(cb)), caf = o.caf ?? ((id) => cancelAnimationFrame(id));
  const now = o.now ?? (() => performance.now());
  let id = 0, t0 = -1, from = 0, lastTo = NaN, active = true;
  const finish = (reason: 'done' | 'cancel') => { if (!active) return; active = false; caf(id); o.onEnd?.(reason); };
  const frame = () => {
    if (!active) return;
    forceMeasure(() => {
      if (t0 < 0) {   // первый кадр: прыжок, если просили, и точка старта
        t0 = now();
        if (o.start != null) root.scrollTop = o.start;
        from = root.scrollTop;
        lastTo = o.target();
        id = raf(frame);
        return;
      }
      const to = o.target();
      // цель сдвинулась (пришло ещё сообщение, подросла картинка) — новая кривая от текущего места, без скачка
      if (to !== lastTo) { from = root.scrollTop; t0 = now(); lastTo = to; }
      const p = Math.min(1, (now() - t0) / o.ms);
      root.scrollTop = p >= 1 ? to : from + (to - from) * ease(p);
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
