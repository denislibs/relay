// Раздел «Для разработчиков» → «Кадры»: запись «нажал → сделал действие → стоп». Пока идёт запись, каждый кадр
// (requestAnimationFrame) кладёт свою длину и то, что в нём шло: тяжёлая анимация, программная прокрутка ленты,
// сколько стикеров играет, какие CSS/WAAPI-анимации активны. Долгие задачи — PerformanceObserver('longtask').
// Ничего не работает, пока запись не начата; запись сама останавливается через MAX_MS.

import { isHeavyAnimating, stickerStats } from '@relay/ui';
import { activeDrives } from '../ui/scrollDrive';

export interface RecFrame {
  t: number;           // мс от начала записи (конец кадра)
  ms: number;          // длина кадра
  heavy: boolean;      // isHeavyAnimating
  drive: boolean;      // программная прокрутка ленты
  stickers: number;    // играющих стикеров
  anims: string[];     // активные анимации (имя CSS-анимации / свойство перехода / класс цели WAAPI)
}
export interface Recording { startedAt: number; frames: RecFrame[]; longTasks: { t: number; ms: number }[] }

export const MAX_MS = 30_000;
export const SLOW_MS = 25;      // 60 Гц: кадр дольше полутора кадров заметен глазом
const ANIMS_MAX = 6;

let rec: Recording | null = null;
let rafId = 0, last = 0, t0 = 0, observer: PerformanceObserver | null = null;
let lastResult: Recording | null = null;
const subs = new Set<() => void>();
const emit = () => { for (const fn of subs) { try { fn(); } catch { /* подписчик не ломает запись */ } } };

/** Имя анимации для отметки кадра: что именно двигается. */
export function animLabel(a: Animation): string | null {
  if (a.playState !== 'running') return null;
  const css = a as Animation & { animationName?: string; transitionProperty?: string };
  if (css.animationName) return css.animationName;
  if (css.transitionProperty) return 'transition ' + css.transitionProperty;
  const target = (a.effect as KeyframeEffect | null)?.target as Element | null | undefined;
  const cls = target?.classList?.[0];
  return cls ? cls + ' (waapi)' : 'waapi';
}

function frame(now: number): void {
  if (!rec) return;
  const ms = now - last;
  last = now;
  const anims: string[] = [];
  for (const a of document.getAnimations()) {
    const n = animLabel(a);
    if (n && !anims.includes(n)) { anims.push(n); if (anims.length >= ANIMS_MAX) break; }
  }
  rec.frames.push({ t: Math.round(now - t0), ms: Math.round(ms * 10) / 10, heavy: isHeavyAnimating(), drive: activeDrives() > 0, stickers: stickerStats().playing, anims });
  if (now - t0 >= MAX_MS) { stopRecording(); return; }
  rafId = requestAnimationFrame(frame);
  if (rec.frames.length % 15 === 0) emit();   // счётчик в интерфейсе — раз в ~250 мс, не каждый кадр
}

export function startRecording(): void {
  if (rec) return;
  t0 = last = performance.now();
  rec = { startedAt: Date.now(), frames: [], longTasks: [] };
  try {
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) rec?.longTasks.push({ t: Math.round(e.startTime - t0), ms: Math.round(e.duration) });
      });
      observer.observe({ type: 'longtask' });
    }
  } catch { observer = null; }
  rafId = requestAnimationFrame(frame);
  emit();
}

export function stopRecording(): Recording | null {
  if (!rec) return lastResult;
  cancelAnimationFrame(rafId);
  rafId = 0;
  observer?.disconnect();
  observer = null;
  lastResult = rec;
  rec = null;
  emit();
  return lastResult;
}

export const isRecording = (): boolean => rec != null;
/** Идущая запись (для счётчика) или последняя законченная. */
export const currentRecording = (): Recording | null => rec ?? lastResult;
export function clearRecording(): void { if (rec) return; lastResult = null; emit(); }
export function subscribeRecording(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; }

export interface Summary {
  frames: number; durationMs: number; fps: number;
  p50: number; p95: number; max: number;
  slow: number; jank: number;           // > SLOW_MS и > 50 мс
  slowest: RecFrame[];                  // самые долгие (до 30), по убыванию
  longTasks: number; longTasksMs: number;
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0);

/** Сводка записи — чистая функция (тесты). Первый кадр не считаем: он меряет время до старта, а не кадр. */
export function summarize(r: Recording): Summary {
  const fr = r.frames.slice(1);
  const durs = fr.map((f) => f.ms).sort((a, b) => a - b);
  const durationMs = r.frames.length ? r.frames[r.frames.length - 1].t : 0;
  return {
    frames: fr.length,
    durationMs,
    fps: durationMs > 0 ? Math.round((fr.length * 1000) / durationMs) : 0,
    p50: pct(durs, 0.5), p95: pct(durs, 0.95), max: durs.length ? durs[durs.length - 1] : 0,
    slow: fr.filter((f) => f.ms > SLOW_MS).length,
    jank: fr.filter((f) => f.ms > 50).length,
    slowest: fr.filter((f) => f.ms > SLOW_MS).sort((a, b) => b.ms - a.ms).slice(0, 30),
    longTasks: r.longTasks.length,
    longTasksMs: r.longTasks.reduce((s, x) => s + x.ms, 0),
  };
}

/** Что шло в кадре — коротко, для строки списка. */
export function frameTags(f: RecFrame): string[] {
  const tags: string[] = [];
  if (f.drive) tags.push('прокрутка ленты');
  if (f.heavy) tags.push('тяжёлая анимация');
  if (f.stickers) tags.push(`стикеров играет: ${f.stickers}`);
  return tags.concat(f.anims);
}
