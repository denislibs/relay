// Модель полного пикера реакций (чистые функции): секции, фильтры, положение окна — как в Telegram Web K.
import { emojiKey, type ReactionAsset } from '@relay/protocol';

export const PANEL_W = 382;
export const PANEL_H = 420;
export const PANEL_MARGIN = 8;
export const TOP_COUNT = 16;

export type PanelSection = { title?: string; items: ReactionAsset[] };

/**
 * Секции: первые TOP_COUNT из «быстрого» порядка (недавние вперёд) без заголовка, затем «Часто используемые» —
 * остальной каталог. Фильтр по категории (список эмодзи) или по тексту (найденные эмодзи + название латиницей)
 * даёт одну секцию без заголовка. allowed («некоторые» реакции чата) ограничивает всё.
 */
export function panelSections(catalog: ReactionAsset[], quick: string[], opts: { allowed?: readonly string[] | null; q?: string; category?: readonly string[] | null; found?: readonly string[] | null }): PanelSection[] {
  const ok = opts.allowed ? new Set(opts.allowed.map(emojiKey)) : null;
  const pool = ok ? catalog.filter((r) => ok.has(r.key)) : catalog;
  const byKey = new Map(pool.map((r) => [r.key, r]));
  const q = (opts.q ?? '').trim().toLowerCase();
  if (opts.category) {
    const want = new Set(opts.category.map(emojiKey));
    return [{ items: pool.filter((r) => want.has(r.key)) }];
  }
  if (q) {
    const hit = new Set((opts.found ?? []).map(emojiKey));
    return [{ items: pool.filter((r) => hit.has(r.key) || r.title.toLowerCase().includes(q)) }];
  }
  const top: ReactionAsset[] = [];
  for (const k of quick) { const r = byKey.get(k); if (r && !top.includes(r) && top.length < TOP_COUNT) top.push(r); }
  const rest = pool.filter((r) => !top.includes(r));
  // набор чата ограничен — одна сетка в быстром порядке, без заголовков (пикер «сжимается», как в Telegram)
  if (ok) return [{ items: [...top, ...rest] }];
  return rest.length ? [{ items: top }, { title: 'Часто используемые', items: rest }] : [{ items: top }];
}

/** Положение окна от прямоугольника панели быстрых реакций: влево 10.5, вверх 60.5, зажим в экран с полями. */
export function panelPosition(bar: { left: number; top: number }, vw: number, vh: number, w = PANEL_W, h = PANEL_H): { left: number; top: number; width: number } {
  const narrow = vw < w + 2 * PANEL_MARGIN;
  const width = narrow ? vw - 2 * PANEL_MARGIN : w;
  let left = narrow ? PANEL_MARGIN : bar.left - 10.5;
  let top = bar.top - 60.5;
  left = Math.max(PANEL_MARGIN, Math.min(left, vw - width - PANEL_MARGIN));
  top = Math.max(PANEL_MARGIN, Math.min(top, vh - h - PANEL_MARGIN));
  return { left: Math.round(left), top: Math.round(top), width };
}

/** Соседняя ячейка для стрелок: cols — колонок в сетке, n — всего ячеек. */
export function moveFocus(i: number, key: string, cols: number, n: number): number {
  if (!n) return -1;
  let j = i;
  if (key === 'ArrowRight') j = i + 1;
  else if (key === 'ArrowLeft') j = i - 1;
  else if (key === 'ArrowDown') j = i + cols;
  else if (key === 'ArrowUp') j = i - cols;
  else return i;
  return Math.max(0, Math.min(n - 1, j));
}
