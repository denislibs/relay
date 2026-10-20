// Чистые расчёты для вкладок «Общих медиа» (ui/SharedMedia.tsx): названия вкладок, какой адрес грузит плитка.
import type { MediaTab } from '@relay/protocol';

type Variant = { name: string; w: number; h: number; size: number };
export type TileAtt = { id: string; kind: string; mime: string; preview?: Variant | null };

/** Плитка фото: маленькая копия сервера (jobs/photo.ts, до 480 px), пока её нет — оригинал. */
export const tileSrc = (a: TileAtt): string => (a.preview ? `/files/${a.id}/preview` : `/files/${a.id}`);

/** Кадр видео без миниатюры: короткий немой ролик сервера (jobs/video.ts, 360p), пока его нет — оригинал;
 *  #t=0.1 — не чёрный самый первый кадр. */
export const videoFrameSrc = (a: TileAtt): string => (a.preview ? `/files/${a.id}/preview` : `/files/${a.id}`) + '#t=0.1';

export type SharedTab = MediaTab | 'members';
export const TAB_LABEL: Record<SharedTab, string> = { members: 'Участники', media: 'Медиа', file: 'Файлы', link: 'Ссылки', audio: 'Музыка', voice: 'Голосовые' };
/** Название вкладки: на самой вкладке и в шапке панели, когда вкладки прилипли к верху (как в Telegram). */
export const tabLabel = (t: SharedTab): string => TAB_LABEL[t];

/** Клик по вкладке, пока над ней ещё виден профиль: куда прокрутить панель, чтобы вкладки доехали до верха.
 *  offset — расстояние от верха области прокрутки до вкладок, max — предел прокрутки. null — уже прилипли, ехать некуда. */
export function tabScrollTarget(p: { scrollTop: number; offset: number; max: number }): number | null {
  if (p.offset <= 1) return null;
  const to = Math.min(p.scrollTop + p.offset, p.max);
  return to - p.scrollTop > 1 ? to : null;
}

/** Положение прокрутки в момент t (мс) плавного переезда from → to за ms: мягкий разгон и торможение. */
export function scrollAt(from: number, to: number, ms: number, t: number): number {
  if (t >= ms) return to;
  const x = Math.max(0, t / ms);
  const k = x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  return from + (to - from) * k;
}

/** Плавная прокрутка el до top за ms (нативная smooth не задаёт длительность). Без анимации — сразу.
 *  Колесо, касание, нажатие или клавиша посреди пути — прокрутка отдаётся человеку, done сразу. Возвращает отмену (без done). */
export function animateScroll(el: HTMLElement, top: number, ms: number, instant: boolean, done: () => void): () => void {
  if (instant) { el.scrollTop = top; done(); return () => {}; }
  const from = el.scrollTop;
  let start = 0, raf = 0;
  const GRAB = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; for (const t of GRAB) el.removeEventListener(t, grab); };
  const finish = () => { stop(); done(); };
  function grab() { finish(); }
  const step = (now: number) => {
    if (!start) start = now;
    el.scrollTop = scrollAt(from, top, ms, now - start);
    if (now - start >= ms) { finish(); return; }
    raf = requestAnimationFrame(step);
  };
  for (const t of GRAB) el.addEventListener(t, grab, { passive: true });
  raf = requestAnimationFrame(step);
  return stop;
}

export const GRID_COLS = 3;

/** Скруглённые углы плитки i из n — только внешние углы всей сетки (как в Telegram), как это делали
 *  :nth-child у обычной CSS-сетки: tl, tr, bl, br через пробел. */
export function gridCorners(i: number, n: number): string {
  const last = i === n - 1, tail = i >= n - GRID_COLS, col = i % GRID_COLS;
  const out: string[] = [];
  if (i === 0) out.push('tl');
  if (i === GRID_COLS - 1 || (last && i < GRID_COLS - 1)) out.push('tr');
  if (col === 0 && tail) out.push('bl');
  if (last || (col === GRID_COLS - 1 && tail)) out.push('br');
  return out.join(' ');
}
