/** @jsxImportSource preact */
import type { StickerRef } from '@relay/protocol';
import { StickerView, setStickerGroupExclusive, stickerGroupExclusive } from '@relay/ui';
import type { ComponentChildren } from 'preact';
import { render } from 'preact';

// Удержание на стикере (как в Telegram): через 125 мс — крупный просмотр поверх затемнения, эмодзи под ним.
// Ведём палец/мышь по другим стикерам — просмотр переключается; отпустили — закрылся, а клик после него не
// отправляет стикер. Пока открыт — играет только он.
const HOLD_MS = 125;
const SIZE = 360;

const known = new Map<string, StickerRef>();   // data-stk → стикер (для переключения при ведении)
let host: HTMLDivElement | null = null;
let shown: StickerRef | null = null;
let prevGroup: string | null = null;

function show(s: StickerRef | null) {
  if (shown?.id === s?.id) return;
  shown = s;
  host ??= Object.assign(document.createElement('div'), { className: 'app-stkview-host' });
  if (!host.isConnected) document.body.append(host);
  render(s ? (
    <div class="app-stkview" role="dialog" aria-label={'Стикер ' + s.emoji}>
      <div class="app-stkview-card" key={s.id}>
        <StickerView src={s.url} outline={s.outline} w={s.w} h={s.h} size={SIZE} group="preview" loop />
        <div class="app-stkview-emoji">{s.emoji}</div>
      </div>
    </div>
  ) : null, host);
}

function start(e: PointerEvent, s: StickerRef) {
  if (e.button !== 0) return;
  let opened = false;
  const timer = setTimeout(() => {
    opened = true;
    prevGroup = stickerGroupExclusive();
    setStickerGroupExclusive('preview');
    show(s);
  }, HOLD_MS);
  const move = (ev: PointerEvent) => {
    if (!opened) return;
    const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-stk]');
    const next = el ? known.get(el.dataset.stk!) : null;
    if (next) show(next);
  };
  const end = () => {
    clearTimeout(timer);
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    if (!opened) return;
    show(null);
    setStickerGroupExclusive(prevGroup);
    // клик, который придёт следом за отпусканием, не должен отправить стикер
    const eat = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
    addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', eat, { capture: true }), 50);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}

/** Обёртка ячейки стикера: удержание открывает крупный просмотр. */
export function StickerPreviewHold({ sticker, children }: { sticker: StickerRef; children: ComponentChildren }) {
  const key = String(sticker.id);
  known.set(key, sticker);
  return (
    <div class="app-stkhold" data-stk={key} onPointerDown={(e) => start(e as unknown as PointerEvent, sticker)} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>
  );
}
