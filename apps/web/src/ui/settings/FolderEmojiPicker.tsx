// Выбор иконки папки — как в Telegram Web K: кнопка-смайлик в поле названия открывает окно эмодзи 382×420
// (поиск, «Часто используемые», категории). Под курсором эмодзи из анимированного набора играет. Окно «вырастает»
// от кнопки и может выходить за колонку слева (портал в body), Esc и клик мимо закрывают.
import { beginHeavyAnimation, reducedMotion } from '@relay/ui';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { animatedEmojiUrl, useAnimatedEmoji } from '../../animatedEmoji';
import { EmojiTab } from '../stickers/SymbolMenu';

const W = 382, H = 420, GAP = 8, MARGIN = 8;

/** Где встать окну у кнопки: под ней, левым краем к кнопке; не влезает снизу — над ней; всегда в окне браузера. */
export function pickerPosition(btn: { left: number; top: number; bottom: number }, vw: number, vh: number): { left: number; top: number; up: boolean } {
  const left = Math.max(MARGIN, Math.min(btn.left - 12, vw - W - MARGIN));
  const below = btn.bottom + GAP;
  if (below + H <= vh - MARGIN) return { left, top: below, up: false };
  const above = btn.top - GAP - H;
  if (above >= MARGIN) return { left, top: above, up: true };
  return { left, top: Math.max(MARGIN, vh - H - MARGIN), up: false };
}

const animKey = (e: string) => e.replace(/\uFE0F/g, '');   // ключи каталога — без FE0F

const EXIT_MS = 150;

export function FolderEmojiPicker({ open, at, selected, onPick, onClose }: { open: boolean; at: { left: number; top: number; up: boolean } | null; selected: string | null; onPick(e: string): void; onClose(): void }) {
  // закрытие — с анимацией: окно ещё EXIT_MS в DOM (data-state="closing"), место — последнее открытое
  const [mounted, setMounted] = useState(open);
  const last = useRef(at); if (open && at) last.current = at;
  useEffect(() => {
    const end = beginHeavyAnimation(open ? 200 : EXIT_MS);
    if (open) { setMounted(true); return end; }
    const t = setTimeout(() => setMounted(false), reducedMotion() ? 0 : EXIT_MS);
    return () => { clearTimeout(t); end(); };
  }, [open]);
  const close = useRef(onClose); close.current = onClose;
  // Esc — у окна: глобальный «назад» иначе ушёл бы со страницы папки
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); } };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [open]);
  const pos = last.current;
  if (!(mounted || open) || !pos) return null;
  return createPortal(
    <div class="rl app-folder-sym-root" data-state={open ? 'open' : 'closing'}>
      {open ? <div class="rl-pop-scrim" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} /> : null}
      <div class={'app-sym app-folder-sym' + (pos.up ? ' is-up' : '')} role="dialog" aria-modal="true" aria-label="Иконка папки" data-esc-layer={open ? '' : undefined} inert={!open || undefined}
        style={{ left: pos.left + 'px', top: pos.top + 'px' }}>
        <Picker selected={selected} onPick={onPick} />
      </div>
    </div>, document.body);
}

function Picker({ selected, onPick }: { selected: string | null; onPick(e: string): void }) {
  useAnimatedEmoji(true);   // каталог анимаций: пришёл — ячейки под курсором начинают играть
  return <EmojiTab selected={selected} animate={(e) => animatedEmojiUrl(animKey(e))} onPick={onPick} />;
}
