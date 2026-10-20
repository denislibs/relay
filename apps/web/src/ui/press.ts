import type { Prepared } from '../data';

// Нажатие мышью готовит чат заранее (data.prepareChat / prepareUserChat), клик показывает. Заготовка одна на
// всё приложение и живёт вне рендера: строка за время нажатия перерисовывается (подсветка, рябь).
// Только мышь: на тач-экране нажатие часто — начало прокрутки.
let current: Prepared | null = null;

export function pressOpen(prepare: () => Prepared | null, open: () => void) {
  return {
    onPointerDown(e: PointerEvent) {
      if (e.pointerType !== 'mouse' || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      current?.cancel();
      const mine = current = prepare();
      if (!mine) return;
      // клик приходит сразу за отпусканием; не пришёл (увели курсор со строки) — заготовку выбросить
      const end = () => { removeEventListener('pointerup', end); removeEventListener('pointercancel', end); setTimeout(() => { if (current === mine) { current = null; mine.cancel(); } }, 100); };
      addEventListener('pointerup', end);
      addEventListener('pointercancel', end);
    },
    onClick() {
      const p = current;
      current = null;
      if (p) p.commit(); else open();
    },
  };
}
