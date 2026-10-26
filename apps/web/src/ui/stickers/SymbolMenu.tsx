/** @jsxImportSource preact */
import type { StickerRef, StickerSetInfo } from '@relay/protocol';
import { Icon, IconButton, MenuPopover, StickerView, beginHeavyAnimation, confirmModal, reducedMotion, requestMeasure, requestMutation } from '@relay/ui';
import type { ComponentChildren } from 'preact';
import { memo } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { clearRecentStickers, faveSticker, loadStickerSet, openStickerSet, searchSets, stickersByEmoji, useMyStickers } from '../../stickers';
import { EMOJI, QUICK, pushRecentEmoji, recentEmoji, searchEmoji } from './emojiData';
import { useEmojiGroups } from '../../emojiGroups';
import { StickerPreviewHold } from './StickerPreview';
import { EmojiGlyph } from './emojiImage';

// Панель эмодзи и стикеров над полем ввода — по образцу Telegram Web K: полоса категорий сверху (49 px),
// строка поиска с контурными фильтрами прокручивается вместе с содержимым, заголовки секций по центру,
// вкладки внизу. Панель живёт в DOM и после закрытия (composer.js), поэтому «Недавние» обновляются только
// когда она закрыта — под курсором ничего не перестраивается.
type Tab = 'emoji' | 'stickers';
const TAB_KEY = 'relay.symbols.tab';
const CLOSE_MS = 180;   // закрытие панели (composer.js, relay.css .rl-symbols-pop.is-closing)
const SLIDE_MS = 200;   // смена вкладки: обе едут вместе (app.css .app-sym-slide-*)
const EMOJI_COLS = 8, EMOJI_ROW = 42;      // ячейка эмодзи 42 px (глиф 34)
const STK_COLS = 5, STK_ROW = 76;          // ячейка стикера 72 px + 4 px зазор

export interface SymbolMenuProps {
  open: boolean;
  onEmoji(e: string): void;
  onBackspace(): void;
  onSticker(s: StickerRef): void;
  onSearch(): void;   // правая панель «Стикеры»
}

export function SymbolMenu(p: SymbolMenuProps) {
  const [tab, setTab] = useState<Tab>(() => { try { return (localStorage.getItem(TAB_KEY) as Tab) || 'emoji'; } catch { return 'emoji'; } });
  // как в Telegram Web K: обе вкладки, раз построенные, живут в DOM (скрытая — display: none, её стикеры стоят).
  // Переключение — только показ: без перерисовки сетки, новых плееров стикеров и сборки мусора от старых
  const [built, setBuilt] = useState<Record<Tab, boolean>>(() => ({ emoji: tab === 'emoji', stickers: tab === 'stickers' }));
  // Смена вкладки — как в Telegram Web K: уходящая и новая едут вместе на всю ширину, без прозрачности (затухание
  // показывало пустой фон панели — «вспышку белым»). Два шага: prep — новая вкладка в раскладке, но невидима
  // (впервые построенная сетка и показ из display: none не попадают в кадр анимации); следующим кадром — slide.
  const [prep, setPrep] = useState<Tab | null>(null);
  const [slide, setSlide] = useState<{ from: Tab; dir: 'l' | 'r' } | null>(null);
  // закрыли панель — со следующего открытия «Недавние» свежие: вкладки пересоздаются, но уже после
  // анимации закрытия (иначе новое содержимое въезжало бы в исчезающую панель)
  const [epoch, setEpoch] = useState(0);
  const wasOpen = useRef(p.open);
  useEffect(() => {
    const closed = wasOpen.current && !p.open;
    wasOpen.current = p.open;
    if (!closed) return;
    const t = setTimeout(() => { setSlide(null); setEpoch((n) => n + 1); }, CLOSE_MS + 50);
    return () => clearTimeout(t);
  }, [p.open]);
  const pick = (t: Tab) => {
    if (t === tab || t === prep) return;
    setBuilt((b) => (b[t] ? b : { ...b, [t]: true }));
    try { localStorage.setItem(TAB_KEY, t); } catch { /* ok */ }
    if (reducedMotion()) { setSlide(null); setTab(t); return; }
    setPrep(t);
  };
  // prep отрисован и разложен — со следующей фазы записи обе вкладки едут; уходящая прячется по окончании
  useEffect(() => {
    if (!prep) return;
    let live = true;
    requestMeasure(() => requestMutation(() => {
      if (!live) return;
      beginHeavyAnimation(SLIDE_MS + 50);
      setSlide({ from: tab, dir: prep === 'stickers' ? 'r' : 'l' });
      setTab(prep);
      setPrep(null);
    }));
    return () => { live = false; };
  }, [prep]);
  useEffect(() => {
    if (!slide) return;
    const t = setTimeout(() => setSlide(null), SLIDE_MS + 30);
    return () => clearTimeout(t);
  }, [slide]);
  // содержимое вкладок не зависит от шагов переключения: memo + постоянные обработчики — смена классов
  // не перерисовывает сотни стикеров и эмодзи (без этого кадр старта длился ~50 мс)
  const handlers = useRef(p);
  handlers.current = p;
  const stable = useRef({ emoji: (e: string) => handlers.current.onEmoji(e), sticker: (s: StickerRef) => handlers.current.onSticker(s) }).current;
  const body = (t: Tab) => {
    if (!built[t]) return null;
    const cls = t === prep ? ' is-prep'
      : slide && t === tab ? ' app-sym-slide-in-' + slide.dir
      : slide && t === slide.from ? ' app-sym-slide-out-' + slide.dir : '';
    return (
      <div class={'app-sym-body' + cls} key={t + ':' + epoch} hidden={t !== tab && t !== prep && t !== slide?.from} inert={t !== tab}>
        {t === 'emoji' ? <EmojiTabMemo onPick={stable.emoji} /> : <StickersTabMemo onPick={stable.sticker} />}
      </div>
    );
  };
  return (
    <div class="app-sym">
      {body('emoji')}
      {body('stickers')}
      {/* вкладки — маленькой «пилюлей» поверх содержимого, как в Telegram для macOS; по бокам — круглые кнопки */}
      <div class="app-sym-bar">
        {tab === 'stickers' ? <IconButton class="app-sym-bar-btn app-sym-bar-left" icon="search" size={20} label="Найти стикеры" onClick={p.onSearch} /> : null}
        <div class="app-sym-tabs" role="tablist" style={{ '--sym-at': tab === 'emoji' ? 0 : 1 }}>
          <span class="app-sym-tabs-pill" aria-hidden="true" />
          <button type="button" role="tab" aria-selected={tab === 'emoji'} class={'app-sym-tab' + (tab === 'emoji' ? ' is-on' : '')} onClick={() => pick('emoji')}>Эмодзи</button>
          <button type="button" role="tab" aria-selected={tab === 'stickers'} class={'app-sym-tab' + (tab === 'stickers' ? ' is-on' : '')} onClick={() => pick('stickers')}>Стикеры</button>
          <button type="button" role="tab" aria-selected={false} class="app-sym-tab" disabled title="GIF — скоро">GIF</button>
        </div>
        {tab === 'emoji' ? <IconButton class="app-sym-bar-btn app-sym-bar-right" icon="backspace" size={20} label="Стереть" onClick={p.onBackspace} /> : null}
      </div>
    </div>
  );
}

/** Полоса сверху: активная — по прокрутке (центруется), нажатие — плавно к секции. Граница снизу — только когда прокручено. */
/* Активная секция и «прокручено ли» живут не в состоянии вкладки, а в маленьком хранилище, на которое подписана
 * только полоса: смена секции при прокрутке перерисовывает одну полосу, а не всю сетку (343 стикера — ~40% времени
 * прокрутки при 4× замедлении). */
interface SectionsState { active: number; top: boolean; subs: Set<() => void> }
function useSections(count: number) {
  const scroller = useRef<HTMLDivElement>(null);
  const state = useRef<SectionsState>({ active: 0, top: true, subs: new Set() }).current;
  const set = (active: number, top: boolean) => {
    if (active === state.active && top === state.top) return;
    state.active = active; state.top = top;
    state.subs.forEach((f) => f());
  };
  const onScroll = () => requestMeasure(() => {
    const el = scroller.current;
    if (!el) return;
    const secs = el.querySelectorAll<HTMLElement>('[data-sec]');
    let cur = 0;
    secs.forEach((s, i) => { if (s.offsetTop - el.offsetTop <= el.scrollTop + 8) cur = i; });
    const atTop = el.scrollTop <= 0;
    requestMutation(() => set(cur, atTop));
  });
  const go = (i: number) => requestMeasure(() => {
    const el = scroller.current, sec = el?.querySelectorAll<HTMLElement>('[data-sec]')[i];
    if (!el || !sec) return;
    const y = i === 0 ? 0 : sec.offsetTop - el.offsetTop;
    requestMutation(() => { el.scrollTo({ top: y, behavior: 'smooth' }); set(i, state.top); });
  });
  useEffect(() => { if (state.active >= count) set(0, state.top); }, [count]);
  return { scroller, state, onScroll, go };
}

function Strip({ items, state, go }: { items: ComponentChildren[]; state: SectionsState; go(i: number): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [, redraw] = useState(0);
  useEffect(() => { const f = () => redraw((n) => n + 1); state.subs.add(f); return () => { state.subs.delete(f); }; }, [state]);
  const { active, top } = state;
  // центрируем активную кнопку прокруткой только самой полосы: scrollIntoView прокрутил бы и всех предков —
  // вплоть до корня приложения (он сдвигался вбок посреди выезда правой панели)
  useEffect(() => requestMeasure(() => {
    const strip = ref.current, el = strip?.children[active] as HTMLElement | undefined;
    if (!strip || !el || !strip.clientWidth) return;
    const left = Math.max(0, el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2);
    if (Math.abs(strip.scrollLeft - left) > 1) requestMutation(() => strip.scrollTo({ left, behavior: 'smooth' }));
  }), [active]);
  return (
    <div class={'app-sym-strip' + (!top ? ' has-border' : '')} ref={ref} role="tablist">
      {items.map((it, i) => <button key={i} type="button" role="tab" aria-selected={i === active} class={'app-sym-strip-btn' + (i === active ? ' is-on' : '')} onClick={() => go(i)}>{it}</button>)}
    </div>
  );
}

/** Фильтр в строке поиска: группа эмодзи Telegram (анимированная иконка) или запасной контурный (QUICK). */
interface Chip { key: string; label: string; icon?: string; tg?: string; emoticons: string[]; query: string }

/** Чипы вкладки: undefined — группы ещё в пути (строка без чипов), иначе группы Telegram или, без них, свои. */
function useChips(kind: 'emoji' | 'sticker'): Chip[] | undefined {
  const groups = useEmojiGroups(kind);
  if (groups === undefined) return undefined;
  if (groups.length) return groups.map((g) => ({ key: g.icon, label: g.title, tg: g.icon, emoticons: g.emoticons, query: g.emoticons.join('') }));
  return QUICK.map((c) => ({ key: c.icon, label: c.label, icon: c.icon, emoticons: c.group, query: c.emoji }));
}

/** Иконка группы — белая анимация Telegram (подкрашивается в CSS). Она «вырастает» из нуля, поэтому в покое стоит
 *  на последнем кадре; при наведении проигрывается с начала один раз. */
function ChipIcon({ src }: { src: string }) {
  const [replay, setReplay] = useState(0);
  return (
    <span class="app-sym-chip-tg" onPointerEnter={() => setReplay((n) => n + 1)}>
      <StickerView src={src} w={512} h={512} size={20} group="panel" play={replay > 0} loop={false} replay={replay} atEnd shared={false} />
    </span>
  );
}

/** Строка поиска с фильтрами справа; выбранный фильтр — стрелка «назад» вместо лупы. */
function SearchRow({ placeholder, q, setQ, group, setGroup, chips, onFocus }: { placeholder: string; q: string; setQ(v: string): void; group: number | null; setGroup(i: number | null): void; chips: Chip[] | undefined; onFocus(on: boolean): void }) {
  return (
    <div class={'app-sym-search' + (q ? ' is-typing' : '')}>
      {group != null
        ? <button type="button" class="app-sym-search-icon is-back" aria-label="Назад" onClick={() => setGroup(null)}><Icon name="arrowLeft" size={20} /></button>
        : <span class="app-sym-search-icon" aria-hidden="true"><Icon name="search" size={20} /></span>}
      <input type="text" placeholder={placeholder} value={q} aria-label={placeholder} onFocus={() => onFocus(true)} onBlur={() => onFocus(false)} onInput={(e) => { setGroup(null); setQ((e.target as HTMLInputElement).value); }} />
      {q ? <IconButton icon="close" label="Очистить" size={18} onClick={() => setQ('')} /> : (
        chips ? <div class="app-sym-chips">
          {chips.map((c, i) => (
            <button key={c.key} type="button" class={'app-sym-chip' + (group === i ? ' is-on' : '')} aria-label={c.label} title={c.label} onClick={() => setGroup(group === i ? null : i)}>
              {c.tg ? <ChipIcon src={c.tg} /> : <Icon name={c.icon!} size={20} />}
            </button>
          ))}
        </div> : null
      )}
    </div>
  );
}

/** Вкладка эмодзи (поиск, «Часто используемые», категории) — и для выбора иконки папки (FolderEmojiPicker). */
// animate(e) — адрес анимации эмодзи: под курсором она играет поверх глифа (как реакции в полном пикере);
// selected — выбранный эмодзи подсвечен
export function EmojiTab({ onPick, animate, selected }: { onPick(e: string): void; animate?: (e: string) => string | undefined; selected?: string | null }) {
  const [recent] = useState(recentEmoji);
  const [hover, setHover] = useState<string | null>(null);
  const [drawn, setDrawn] = useState<string | null>(null);   // у анимации под курсором есть первый кадр — глиф под ней прячем
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const chips = useChips('emoji');
  const chip = group != null ? chips?.[group] : undefined;
  const found = chip ? chip.emoticons : q.trim() ? searchEmoji(q) : null;
  const base = recent.length ? [{ id: 'recent', title: 'Часто используемые', icon: 'clock', list: recent }, ...EMOJI] : EMOJI;
  const cats = found ? [{ id: 'found', title: chip ? chip.label : 'Найдено', icon: 'search', list: found }] : base;
  const s = useSections(cats.length);
  const pick = (e: string) => { pushRecentEmoji(e); onPick(e); };
  return (
    <div class={'app-sym-pane' + (focused || found ? ' is-searching' : '')}>
      {/* полоса при поиске уезжает вверх с прежними иконками — не пустеет на лету */}
      <Strip items={base.map((c) => <Icon name={c.icon} size={24} />)} state={s.state} go={s.go} />
      <div class="app-sym-scroll" ref={s.scroller} onScroll={s.onScroll}>
        <SearchRow placeholder="Поиск эмодзи" q={q} setQ={setQ} group={group} setGroup={setGroup} chips={chips} onFocus={setFocused} />
        {cats.map((c, i) => <EmojiSection key={c.id} cat={c} eager={i < 2} root={s.scroller} onPick={pick} cell={animate ? (e) => (
          <button key={e} type="button" class={'app-emoji' + (selected === e ? ' is-on' : '')} aria-pressed={selected === e} onClick={() => pick(e)}
            onMouseEnter={() => { if (animate(e)) { setDrawn(null); setHover(e); } }} onMouseLeave={() => setHover((h) => (h === e ? null : h))}>
            <span class={hover === e && drawn === e ? 'is-under' : undefined}><EmojiGlyph e={e} /></span>
            {hover === e && !reducedMotion() ? <StickerView src={animate(e)!} w={512} h={512} size={34} group="menu" force loop={false} onFirstFrame={() => setDrawn(e)} onEnded={() => setHover((h) => (h === e ? null : h))} /> : null}
          </button>
        ) : undefined} />)}
        {found && !found.length ? <p class="app-sym-empty">Эмодзи не найдены</p> : null}
      </div>
    </div>
  );
}

// эмодзи-глифы дороги в отрисовке (≈1500 штук — 100+ мс): категория наполняется, когда подъехала к экрану,
// а её высота зарезервирована заранее — прокрутка не прыгает
function EmojiSection({ cat, eager, root, onPick, cell }: { cat: { id: string; title: string; list: string[] }; eager: boolean; root: { current: HTMLDivElement | null }; onPick(e: string): void; cell?: (e: string) => ComponentChildren }) {
  const el = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(eager);
  useEffect(() => {
    if (shown || !el.current) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); setShown(true); } }, { root: root.current, rootMargin: '300px 0px' });
    io.observe(el.current);
    return () => io.disconnect();
  }, [shown]);
  return (
    <section ref={el} data-sec class="app-sym-sec">
      <h4>{cat.title}</h4>
      <div class="app-emoji-grid" style={{ minHeight: Math.ceil(cat.list.length / EMOJI_COLS) * EMOJI_ROW + 'px' }}>
        {shown ? cat.list.map((e) => (cell ? cell(e) : <button key={e} type="button" class="app-emoji" aria-label={e} onClick={() => onPick(e)}><EmojiGlyph e={e} /></button>)) : null}
      </div>
    </section>
  );
}

type Section = { key: string; title: string; set?: StickerSetInfo; stickers?: StickerRef[]; count: number; clear?: boolean };

function StickersTab({ onPick }: { onPick(s: StickerRef): void }) {
  const mine = useMyStickers();
  // «Недавние» — снимок на время показа (вкладка пересоздаётся после закрытия панели)
  const frozen = useRef<StickerRef[] | null>(null);
  if (!frozen.current && (mine.recent.length || mine.sets.length)) frozen.current = mine.recent;
  const recent = frozen.current ?? mine.recent;
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const chips = useChips('sticker');
  const chip = group != null ? chips?.[group] : undefined;
  const [found, setFound] = useState<{ stickers?: StickerRef[]; sets?: StickerSetInfo[] } | null>(null);
  const [menu, setMenu] = useState<{ s: StickerRef; el: HTMLElement; recent: boolean } | null>(null);

  // поиск: фильтр или эмодзи — стикеры с ним (свои паки первыми); текст — паки по названию
  useEffect(() => {
    // фильтр: стикеры с любым эмодзи группы
    const text = chip ? chip.query : q.trim();
    if (!text) { setFound(null); return; }
    let live = true;
    const t = setTimeout(() => {
      const isEmoji = /\p{Extended_Pictographic}/u.test(text);
      (isEmoji ? stickersByEmoji(text).then((stickers) => ({ stickers })) : searchSets(text).then((sets) => ({ sets })))
        .then((r) => { if (live) setFound(r); }, () => { if (live) setFound({ stickers: [] }); });
    }, group != null ? 0 : 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, group, chip?.query]);

  const own: Section[] = [
    ...(mine.faved.length ? [{ key: 'faved', title: 'Избранное', stickers: mine.faved, count: mine.faved.length }] : []),
    ...(recent.length ? [{ key: 'recent', title: 'Недавние', stickers: recent, count: recent.length, clear: true }] : []),
  ];
  const setSection = (set: StickerSetInfo): Section => ({ key: 'set' + set.id, title: set.title, set, count: set.count });
  const base: Section[] = [...own, ...mine.sets.filter((x) => x.kind === 'sticker').map(setSection)];
  const sections: Section[] = found?.stickers ? [{ key: 'found', title: chip ? chip.label : 'Найдено', stickers: found.stickers, count: found.stickers.length }]
    : found?.sets ? found.sets.filter((x) => x.kind === 'sticker').map(setSection)
    : base;
  const s = useSections(sections.length);
  const stripItems = base.map((sec) => sec.key === 'faved' ? <Icon name="bookmark" size={24} /> : sec.key === 'recent' ? <Icon name="clock" size={24} />
    : sec.set?.cover ? <StickerView src={sec.set.cover.url} outline={sec.set.cover.outline} w={512} h={512} size={30} play={false} group="panel" title={sec.title} /> : <Icon name="sticker" size={24} />);

  const clearRecent = async () => {
    if (await confirmModal({ title: 'Очистить недавние стикеры?', confirm: 'Очистить', danger: true })) {
      frozen.current = [];
      void clearRecentStickers();
    }
  };

  return (
    <div class={'app-sym-pane' + (focused || q.trim() || group != null ? ' is-searching' : '')}>
      <Strip items={stripItems} state={s.state} go={s.go} />
      <div class="app-sym-scroll" ref={s.scroller} onScroll={s.onScroll}>
        <SearchRow placeholder="Поиск стикеров" q={q} setQ={setQ} group={group} setGroup={setGroup} chips={chips} onFocus={setFocused} />
        {sections.map((sec, i) => (
          <StickerSection key={sec.key} sec={sec} root={s.scroller} eager={i < 2} onPick={onPick}
            onClear={sec.clear ? clearRecent : undefined}
            onMenu={(st, el) => setMenu({ s: st, el, recent: sec.key === 'recent' })} />
        ))}
        {found && !sections.some((x) => x.count) ? <p class="app-sym-empty">Стикеры не найдены</p> : null}
      </div>
      <MenuPopover open={!!menu} anchor={menu?.el ?? null} placement="top-start" onClose={() => setMenu(null)} items={menu ? [
        mine.faved.some((f) => f.id === menu.s.id)
          ? { icon: 'star', label: 'Убрать из избранного', onClick: () => void faveSticker(menu.s, false) }
          : { icon: 'star', label: 'В избранное', onClick: () => void faveSticker(menu.s, true) },
        menu.recent ? { icon: 'trash', label: 'Убрать из недавних', onClick: () => { frozen.current = (frozen.current ?? []).filter((x) => x.id !== menu.s.id); void clearRecentStickers(menu.s.id); } } : null,
        { icon: 'sticker', label: 'Открыть пак', onClick: () => openStickerSet(menu.s.setId) },
      ].filter(Boolean) : []} />
    </div>
  );
}

/**
 * Секция рядом с видимой областью (±300 px)? Как в Telegram Web K: стикеры есть в DOM только у таких наборов —
 * ушедший набор отпускает свои плееры и холсты, вернувшийся встаёт сохранёнными первыми кадрами, затем оживает.
 * Пока вкладка скрыта (display: none), наблюдатель видит «ничего не пересекается» — это не уход, состояние держим.
 */
function useNear(el: { current: HTMLElement | null }, root: { current: HTMLElement | null }, initial: boolean): boolean {
  const [near, setNear] = useState(initial);
  useEffect(() => {
    if (!el.current) return;
    const io = new IntersectionObserver((es) => {
      const e = es[es.length - 1];
      if (!e.isIntersecting && !root.current?.getClientRects().length) return;   // вкладка скрыта
      setNear(e.isIntersecting);
    }, { root: root.current, rootMargin: '300px 0px' });
    io.observe(el.current);
    return () => io.disconnect();
  }, []);
  return near;
}

function StickerSection({ sec, root, eager, onPick, onClear, onMenu }: { sec: Section; root: { current: HTMLDivElement | null }; eager: boolean; onPick(s: StickerRef): void; onClear?: () => void; onMenu(s: StickerRef, el: HTMLElement): void }) {
  const el = useRef<HTMLElement>(null);
  const near = useNear(el, root, eager);
  const [stickers, setStickers] = useState<StickerRef[] | null>(sec.stickers ?? null);
  useEffect(() => { if (sec.stickers) setStickers(sec.stickers); }, [sec.stickers]);
  // содержимое пака — когда секция в 500 px от видимой области
  useEffect(() => {
    if (sec.stickers || !sec.set || !el.current) return;
    const set = sec.set;
    let live = true;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      loadStickerSet(set.id, set.hash).then((full) => { if (live && full) setStickers(full.stickers); }, () => {});
    }, { root: root.current, rootMargin: '500px 0px' });
    io.observe(el.current);
    return () => { live = false; io.disconnect(); };
  }, [sec.key]);
  const rows = Math.ceil(sec.count / STK_COLS);
  return (
    <section ref={el} data-sec class="app-sym-sec">
      <h4 class={sec.set ? 'is-link' : undefined} onClick={sec.set ? () => openStickerSet(sec.set!.id) : undefined}>
        {sec.title}
        {onClear ? <IconButton class="app-sym-clear" icon="close" label="Очистить недавние" size={20} onClick={(e: Event) => { e.stopPropagation(); onClear(); }} /> : null}
      </h4>
      <div class="app-stk-grid" style={{ minHeight: rows * STK_ROW + 'px' }}>
        {near && stickers?.map((s) => (
          <StickerPreviewHold key={s.id} sticker={s}>
            <button type="button" class="app-stk-cell" onClick={() => onPick(s)} title={s.emoji}
              onContextMenu={(e) => { e.preventDefault(); onMenu(s, e.currentTarget as HTMLElement); }}>
              <StickerView src={s.url} outline={s.outline} w={s.w} h={s.h} size={64} group="panel" loop />
            </button>
          </StickerPreviewHold>
        ))}
      </div>
    </section>
  );
}

const EmojiTabMemo = memo(EmojiTab);
const StickersTabMemo = memo(StickersTab);
