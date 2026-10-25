// Полный пикер реакций — по шеврону панели быстрых реакций, как в Telegram Web K: окно 382×420 «вырастает»
// из места панели; сверху поиск с рядом категорий, затем первые 16 из быстрого порядка и «Часто используемые».
// Иконки статичные (webp), при наведении играет select; в чате с ограниченным набором — только сетка.
import type { ReactionAsset } from '@relay/protocol';
import { Icon, IconButton, StickerView, beginHeavyAnimation, reducedMotion } from '@relay/ui';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { catalogFor, quickReactions } from '../reactions';
import { moveFocus, panelPosition, panelSections, PANEL_H } from '../reactionsPanelModel';
import { EMOJI, searchEmoji } from './stickers/emojiData';

const COLS = 8;
const coarse = () => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } };

type Props = {
  bar: { left: number; top: number };   // прямоугольник панели быстрых реакций — откуда «вырастает» окно
  allowed?: readonly string[] | null;   // набор чата («некоторые») — без поиска и категорий
  selected?: string;                    // моя реакция (ключ)
  animated: boolean;                    // select при наведении (иначе только картинки)
  onPick(key: string): void;
  onClose(): void;
};

export function ReactionsPanel({ bar, allowed, selected, animated, onPick, onClose }: Props) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const catalog = useMemo(() => catalogFor(allowed), [allowed]);
  const quick = useMemo(() => quickReactions(allowed, 32), [allowed]);
  const limited = !!allowed;
  const sections = useMemo(() => panelSections(catalog, quick, {
    allowed, q: limited ? '' : q, category: !limited && cat != null ? EMOJI[cat].list : null, found: q ? searchEmoji(q) : null,
  }), [catalog, quick, allowed, q, cat, limited]);
  const pos = panelPosition(bar, document.documentElement.clientWidth, window.innerHeight);
  const cells = sections.flatMap((s) => s.items);

  // открытие — тяжёлая анимация (лента и стикеры подождут 200 ms); фокус в поиск, кроме тач-экранов
  useEffect(() => { const end = beginHeavyAnimation(200); if (!coarse() && !limited) input.current?.focus(); return end; }, []);
  useLayoutEffect(() => { root.current?.style.setProperty('--rpanel-h', limited ? 'auto' : PANEL_H + 'px'); }, [limited]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (!e.key.startsWith('Arrow')) return;
    const btns = [...(root.current?.querySelectorAll<HTMLButtonElement>('.app-rpanel-cell') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const j = moveFocus(i < 0 ? 0 : i, e.key, COLS, btns.length);
    if (j >= 0) { e.preventDefault(); btns[j].focus(); }
  };

  const cell = (r: ReactionAsset) => (
    <button key={r.key} type="button" class={'app-rpanel-cell' + (selected === r.key ? ' is-on' : '')} title={r.title} aria-label={'Реакция ' + r.title} aria-pressed={selected === r.key}
      onClick={() => onPick(r.key)} onMouseEnter={() => { if (animated && r.select) setHover(r.key); }} onMouseLeave={() => setHover((h) => (h === r.key ? null : h))}>
      {r.static ? <img src={r.static} alt="" draggable={false} decoding="async" /> : <span>{r.key}</span>}
      {hover === r.key ? <StickerView src={r.select} w={512} h={512} size={36} group="menu" force loop={false} play={!reducedMotion()} onEnded={() => setHover((h) => (h === r.key ? null : h))} /> : null}
    </button>
  );

  return createPortal(
    <div class="rl app-rpanel-root" onKeyDown={onKey}>
      <div class="rl-pop-scrim" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={root} class={'app-sym app-rpanel' + (limited ? ' is-shrink' : '')} role="dialog" aria-label="Реакции" style={{ left: pos.left + 'px', top: pos.top + 'px', width: pos.width + 'px' }}>
        {!limited ? (
          <div class={'app-sym-search' + (q ? ' is-typing' : '')}>
            {cat != null
              ? <button type="button" class="app-sym-search-icon is-back" aria-label="Назад" onClick={() => setCat(null)}><Icon name="arrowLeft" size={20} /></button>
              : <span class="app-sym-search-icon" aria-hidden="true"><Icon name="search" size={20} /></span>}
            <input ref={input} type="text" placeholder="Поиск" value={q} aria-label="Поиск реакций" onInput={(e) => { setCat(null); setQ((e.target as HTMLInputElement).value); }} />
            {q ? <IconButton icon="close" label="Очистить" size={18} onClick={() => setQ('')} /> : (
              <div class="app-sym-chips">
                {EMOJI.map((c, i) => (
                  <button key={c.id} type="button" class={'app-sym-chip' + (cat === i ? ' is-on' : '')} aria-label={c.title} title={c.title} onClick={() => setCat(cat === i ? null : i)}>
                    <Icon name={c.icon} size={20} />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
        <div class="app-rpanel-body">
          {cells.length ? sections.map((s, i) => (
            <section key={i} class="app-rpanel-sec">
              {s.title ? <h4>{s.title}</h4> : null}
              <div class="app-emoji-grid">{s.items.map(cell)}</div>
            </section>
          )) : <p class="app-sym-empty">Ничего не найдено</p>}
        </div>
      </div>
    </div>, document.body);
}
