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
 *  Колесо или касание посреди пути — прокрутка отдаётся человеку, done сразу. Возвращает отмену (без done). */
export function animateScroll(el: HTMLElement, top: number, ms: number, instant: boolean, done: () => void): () => void {
  if (instant) { el.scrollTop = top; done(); return () => {}; }
  const from = el.scrollTop;
  let start = 0, raf = 0;
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; el.removeEventListener('wheel', grab); el.removeEventListener('touchstart', grab); };
  const finish = () => { stop(); done(); };
  function grab() { finish(); }
  const step = (now: number) => {
    if (!start) start = now;
    el.scrollTop = scrollAt(from, top, ms, now - start);
    if (now - start >= ms) { finish(); return; }
    raf = requestAnimationFrame(step);
  };
  el.addEventListener('wheel', grab, { passive: true });
  el.addEventListener('touchstart', grab, { passive: true });
  raf = requestAnimationFrame(step);
  return stop;
}

/** Сетка «Медиа» в виртуальном списке: строки по cols плиток (последняя может быть короче). */
export function gridRows<T>(items: T[], cols: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  return rows;
}

export const GRID_COLS = 3, GRID_GAP = 1;
/** Квадратная плитка по ширине сетки (3 в ряд через 1 px); row — шаг строки вместе с зазором под ней. */
export function gridMetrics(width: number): { cell: number; row: number } {
  if (width <= 0) return { cell: 0, row: 0 };
  const cell = (width - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
  return { cell, row: cell + GRID_GAP };
}

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
