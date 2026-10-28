// Протяжка мышью в режиме выбора чатов: от строки, где нажали, до строки под курсором — отметить (или снять,
// если начали с отмеченной). Как у выбора сообщений (Feed.onSelectDown): до 5 px — ещё клик, у края — автопрокрутка.
// Индексы — из списка (в окне WindowList есть не все строки), строка под курсором — elementFromPoint по середине.
import type { Item } from '@relay/sync-engine/src/types';
import { getGlobal } from '../global';
import { setChatSelectIds } from '../chatSelect';

/** Новый набор выбранных: диапазон [start..cur] (в любую сторону) добавляется к base или вычитается из него. */
export function dragRangeIds(ids: readonly number[], start: number, cur: number, base: readonly number[], add: boolean): number[] {
  const [a, b] = start <= cur ? [start, cur] : [cur, start];
  const range = new Set(ids.slice(a, b + 1));
  return add ? [...new Set([...base, ...range])] : base.filter((id) => !range.has(id));
}

let swallowClick = false;
/** click после протягивания не должен переключить строку ещё раз (onClickCapture обёртки). */
export function dragClickGuard(e: MouseEvent): void { if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); } }

export function chatSelectDrag(e: PointerEvent, rows: readonly Item[], scroller: HTMLElement): void {
  if (e.button !== 0 || e.pointerType === 'touch') return;
  const ids = rows.map((c) => c.id as number);
  const indexOf = (el: Element | null | undefined) => {
    const id = el?.closest<HTMLElement>('[data-chat-id]')?.dataset.chatId;
    return id == null ? -1 : ids.findIndex((x) => String(x) === id);
  };
  const start = indexOf(e.target as Element);
  if (start < 0) return;
  const base = getGlobal().chatSelect?.ids ?? [];
  const add = !base.includes(ids[start]);
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false, y = y0, raf = 0;
  const at = (py: number) => {
    const r = scroller.getBoundingClientRect();
    return indexOf(document.elementFromPoint(r.left + r.width / 2, Math.max(r.top + 1, Math.min(r.bottom - 1, py))));
  };
  const apply = () => {
    const i = at(y); if (i < 0) return;
    setChatSelectIds(dragRangeIds(ids, start, i, base, add));
  };
  const tick = () => {
    const r = scroller.getBoundingClientRect(), edge = 48;
    const v = y < r.top + edge ? -Math.ceil((r.top + edge - y) / 4) : y > r.bottom - edge ? Math.ceil((y - (r.bottom - edge)) / 4) : 0;
    if (v) { scroller.scrollTop += v; apply(); }
    raf = requestAnimationFrame(tick);
  };
  const move = (ev: PointerEvent) => {
    y = ev.clientY;
    if (!moved) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;   // дрожание при клике — ещё не протягивание
      moved = true; raf = requestAnimationFrame(tick);
    }
    apply();
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    cancelAnimationFrame(raf);
    if (moved) { swallowClick = true; setTimeout(() => { swallowClick = false; }, 0); }   // следом придёт click
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}
