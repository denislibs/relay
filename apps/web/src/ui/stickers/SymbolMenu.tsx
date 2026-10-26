/** @jsxImportSource preact */
import type { StickerRef, StickerSetInfo } from '@relay/protocol';
import { Icon, IconButton, MenuPopover, StickerView, beginHeavyAnimation, confirmModal, onHeavyAnimationEnd, reducedMotion, requestMeasure, requestMutation } from '@relay/ui';
import type { ComponentChildren } from 'preact';
import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { clearRecentStickers, faveSticker, loadStickerSet, openStickerSet, searchSets, stickersByEmoji, useMyStickers } from '../../stickers';
import { EMOJI, QUICK, emojiTones, pushRecentEmoji, recentEmoji, saveTone, savedTones, searchEmoji } from './emojiData';
import { useEmojiGroups } from '../../emojiGroups';
import { animatedEmojiUrl, useAnimatedEmoji } from '../../animatedEmoji';
import { StickerPreviewHold } from './StickerPreview';
import { EmojiGlyph } from './emojiImage';

// Панель эмодзи и стикеров над полем ввода — по образцу Telegram Web K: полоса категорий сверху (49 px),
// строка поиска с контурными фильтрами прокручивается вместе с содержимым, заголовки секций по центру,
// вкладки внизу. Панель живёт в DOM и после закрытия (composer.js), поэтому «Недавние» обновляются только
// когда она закрыта — под курсором ничего не перестраивается.
type Tab = 'emoji' | 'stickers';
const TAB_KEY = 'relay.symbols.tab';
const CLOSE_MS = 180;   // закрытие панели (composer.js, relay.css .rl-symbols-pop.is-closing)
const SLIDE_MS = 200;   // смена вкладки: обе едут вместе (Web Animations, SymbolMenu)
const EMOJI_COLS = 8, EMOJI_ROW = 42;      // ячейка эмодзи 42 px (глиф 34)
const STK_COLS = 5, STK_ROW = 76;          // ячейка стикера 72 px + 4 px зазор
const PREBUILD_MS = 400;                    // после открытия (200 мс) — построить вторую вкладку про запас
const UNLOAD_MS = 500;                      // секция вдали от экрана столько — опустошается
const WARM_MS = 150, WARM_MAX_MS = 1500, WARM_STICKERS = 20;   // заранее построенная вкладка рисуется под текущей, пока первые стикеры не нарисуют кадр

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
  // показывало пустой фон панели — «вспышку белым»). Два шага: prep — новая вкладка показана из display: none,
  // разложена и нарисована за краем панели (это и есть дорогой кадр, но до начала движения); следующим кадром —
  // slide. Движение — Web Animations по инлайн-transform: ни классов, ни pointer-events, ни inert на вкладках —
  // их смена пересчитывала стили всего дерева вкладки (1 700 элементов, 20 мс при CPU ×4) в первом кадре движения.
  // Обе вкладки — постоянные слои (will-change в CSS): слайд не перерисовывает, а двигает их
  const [prep, setPrep] = useState<Tab | null>(null);
  const [slide, setSlide] = useState<{ from: Tab } | null>(null);
  const bodies = useRef<Record<Tab, HTMLDivElement | null>>({ emoji: null, stickers: null });
  const [warm, setWarm] = useState<Record<Tab, boolean>>({ emoji: false, stickers: false });
  // построенная вкладка сначала разложена и нарисована под текущей — дальше её можно прятать, не теряя раскладки.
  // Под текущей, а не за краем: так её стикеры «видны» наблюдателям и успевают нарисовать первый кадр — при первом
  // показе вкладка въезжает со стикерами, а не с серыми силуэтами
  useEffect(() => {
    const cold = (['emoji', 'stickers'] as Tab[]).filter((t) => built[t] && !warm[t]);
    if (!cold.length) return;
    const t0 = performance.now();
    let timer = 0;
    // готова — когда первые стикеры на экране вкладки нарисовали кадр (силуэтов среди них нет); не дольше WARM_MAX_MS
    const ready = (t: Tab) => {
      const first = [...(bodies.current[t]?.querySelectorAll('.rl-sticker') ?? [])].slice(0, WARM_STICKERS);
      return !first.some((x) => !x.classList.contains('rl-sticker-ready'));
    };
    const check = () => {
      const done = cold.filter((t) => performance.now() - t0 >= WARM_MAX_MS || ready(t));
      if (done.length) setWarm((w) => ({ ...w, ...Object.fromEntries(done.map((k) => [k, true])) }));
      if (done.length < cold.length) timer = window.setTimeout(check, WARM_MS);
    };
    timer = window.setTimeout(check, WARM_MS);
    return () => clearTimeout(timer);
  }, [built.emoji, built.stickers]);
  const leaving = useRef<Animation | null>(null);
  // закрыли панель — со следующего открытия «Недавние» свежие. Вкладки не пересоздаются (как в Telegram Web K:
  // вкладка, прокрутка и подсветка категории остаются), только перечитывают снимок «Недавних» — после анимации
  // закрытия, иначе ряд менялся бы в исчезающей панели
  const [epoch, setEpoch] = useState(0);
  const wasOpen = useRef(p.open);
  useEffect(() => {
    const closed = wasOpen.current && !p.open;
    wasOpen.current = p.open;
    if (!closed) return;
    const t = setTimeout(() => { setSlide(null); setEpoch((n) => n + 1); }, CLOSE_MS + 50);
    return () => clearTimeout(t);
  }, [p.open]);
  // вторая вкладка строится заранее, скрытой (display: none), когда панель уже открылась и анимация прошла:
  // к нажатию на неё данные паков на месте — в кадре подготовки уже стоит сетка, а не въезжает пустая вкладка
  useEffect(() => {
    if (!p.open || (built.emoji && built.stickers)) return;
    const other: Tab = tab === 'emoji' ? 'stickers' : 'emoji';
    const t = setTimeout(() => setBuilt((b) => (b[other] ? b : { ...b, [other]: true })), PREBUILD_MS);
    return () => clearTimeout(t);
  }, [p.open, built.emoji && built.stickers]);
  const pick = (t: Tab) => {
    if (t === tab || t === prep) return;
    setBuilt((b) => (b[t] ? b : { ...b, [t]: true }));
    try { localStorage.setItem(TAB_KEY, t); } catch { /* ok */ }
    if (reducedMotion()) { setSlide(null); setTab(t); return; }
    setPrep(t);
  };
  const shift = (t: Tab) => (t === 'stickers' ? 100 : -100);   // где новая вкладка ждёт: справа «Стикеры», слева «Эмодзи»
  // кадр подготовки: новая вкладка стоит на своём месте, но под текущей (вкладки непрозрачны) — так браузер рисует
  // её целиком; за краем панели её обрезал бы overflow, и отрисовка досталась бы первому кадру движения
  useLayoutEffect(() => {
    const el = prep && bodies.current[prep];
    if (el) el.style.zIndex = '-1';
  }, [prep]);
  // prep отрисован и разложен — со следующей фазы записи обе вкладки едут; уходящая прячется по окончании
  useEffect(() => {
    if (!prep) return;
    let live = true;
    requestMeasure(() => requestMutation(() => {
      if (!live) return;
      beginHeavyAnimation(SLIDE_MS + 50);
      const x = shift(prep), opts = { duration: SLIDE_MS, easing: 'ease-in-out' };
      const inc = bodies.current[prep], out = bodies.current[tab];
      if (inc) { inc.animate([{ transform: `translateX(${x}%)` }, { transform: 'none' }], opts); inc.style.zIndex = ''; }
      leaving.current = out ? out.animate([{ transform: 'none' }, { transform: `translateX(${-x}%)` }], { ...opts, fill: 'forwards' }) : null;
      setSlide({ from: tab });
      setTab(prep);
      setPrep(null);
    }));
    return () => { live = false; };
  }, [prep]);
  useEffect(() => {
    if (!slide) { leaving.current?.cancel(); leaving.current = null; return; }   // ушедшая уже скрыта — снять её сдвиг
    const t = setTimeout(() => setSlide(null), SLIDE_MS + 30);
    return () => clearTimeout(t);
  }, [slide]);
  // содержимое вкладок не зависит от шагов переключения: memo + постоянные обработчики — смена классов
  // не перерисовывает сотни стикеров и эмодзи (без этого кадр старта длился ~50 мс)
  const handlers = useRef(p);
  handlers.current = p;
  const stable = useRef({ emoji: (e: string) => handlers.current.onEmoji(e), sticker: (s: StickerRef) => handlers.current.onSticker(s), animate: (e: string) => animatedEmojiUrl(e.replace(/\uFE0F/g, '')) }).current;
  useAnimatedEmoji(p.open);   // каталог анимаций эмодзи: под курсором эмодзи панели оживает, как в выборе иконки папки
  const body = (t: Tab) => {
    if (!built[t]) return null;
    // скрытая вкладка — content-visibility: hidden (не display: none): её стили и раскладка сохраняются, и показ
    // стоит доли миллисекунды, а не пересчёт 1 300 узлов (стоп-кадр ≈120 мс при CPU ×6). inert не ставим: его смена
    // пересчитывает стили всего дерева; фокус и поиск по странице content-visibility и так пропускает.
    // Впервые построенная вкладка WARM_MS рисуется под текущей (warm) — раскладка и кадры стикеров есть до показа
    const off = t !== tab && t !== prep && t !== slide?.from;
    const hide = off && warm[t];
    return (
      <div class="app-sym-body" key={t} ref={(el) => { bodies.current[t] = el; }} data-off={hide ? '' : undefined} aria-hidden={off || undefined}
        style={off && !warm[t] ? { zIndex: -1 } : undefined}>
        {t === 'emoji' ? <EmojiTabMemo onPick={stable.emoji} animate={stable.animate} tones epoch={epoch} /> : <StickersTabMemo onPick={stable.sticker} epoch={epoch} />}
      </div>
    );
  };
  return (
    <div class="app-sym">
      {body('emoji')}
      {body('stickers')}
      {/* на время слайда нажатия ловит прозрачный щит: pointer-events на самих вкладках наследуется и стоил бы пересчёта стилей */}
      {prep || slide ? <div class="app-sym-shield" /> : null}
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
interface SectionsState { active: number; top: boolean; subs: Set<() => void>; jump: { i: number; at: number; anim: boolean } | null }
/** Секции просят наполниться заранее (переход к категории): событие на элементе секции. */
const SEC_SHOW = 'app-sym-show';
/** Вкладка скрыта (content-visibility: hidden) — «не пересекается» от её наблюдателей ничего не значит. */
const tabOff = (el: Element | null) => !el || !!el.closest('[data-off]') || !el.getClientRects().length;
// Переход к секции — как в Telegram Web K: издалека встаём в 150 px от цели и доезжаем их за 150 мс, а не летим
// через все категории (полёт перебирал подсветку полосы и показывал недорисованные секции)
const JUMP_PX = 150, JUMP_MS = 150;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2);
function useSections(count: number) {
  const scroller = useRef<HTMLDivElement>(null);
  const state = useRef<SectionsState>({ active: 0, top: true, subs: new Set(), jump: null }).current;
  const set = (active: number, top: boolean) => {
    if (active === state.active && top === state.top) return;
    state.active = active; state.top = top;
    state.subs.forEach((f) => f());
  };
  const onScroll = () => requestMeasure(() => {
    const el = scroller.current;
    if (!el) return;
    const j = state.jump;
    if (j?.anim) return;   // подсветка уже на цели — путь к ней её не трогает
    // встали на цель: она остаётся подсвеченной, даже если до её начала не докрутить (короткая последняя секция)
    if (j && Math.abs(el.scrollTop - j.at) <= 1) return;
    state.jump = null;
    const secs = el.querySelectorAll<HTMLElement>('[data-sec]');
    let cur = 0;
    secs.forEach((s, i) => { if (s.offsetTop - el.offsetTop <= el.scrollTop + 8) cur = i; });
    const atTop = el.scrollTop <= 0;
    requestMutation(() => set(cur, atTop));
  });
  const stop = useRef<() => void>(() => {});
  const go = (i: number) => {
    const el = scroller.current;
    const secs = el?.querySelectorAll<HTMLElement>('[data-sec]');
    if (!el || !secs?.[i]) return;
    stop.current();
    // до прокрутки наполняются то, что будет видно: начало цели и конец предыдущей секции (путь начинается
    // в 150 px над целью или под ней); остальное дорисуется частями после перехода
    const show = (k: number, fill: Fill, n: number) => secs[k]?.dispatchEvent(new CustomEvent(SEC_SHOW, { detail: { fill, n } }));
    show(i, 'head', CHUNK);
    show(i - 1, 'tail', CHUNK / 2);
    show(i + 1, 'head', CHUNK / 2);
    const jump = { i, at: -1, anim: true };
    state.jump = jump;
    set(i, state.top);
    requestMeasure(() => {
      if (state.jump !== jump) return;
      const max = el.scrollHeight - el.clientHeight;
      const to = Math.max(0, Math.min(max, i === 0 ? 0 : secs[i].offsetTop - el.offsetTop));
      const from = el.scrollTop;
      jump.at = to;
      const far = Math.abs(to - from) > JUMP_PX;
      const start = far ? to - Math.sign(to - from) * JUMP_PX : from;
      requestMutation(() => {
        if (state.jump !== jump) return;
        const land = () => { jump.anim = false; set(i, to <= 0); };
        if (reducedMotion() || to === from) { el.scrollTop = to; land(); return; }
        el.scrollTop = start;
        beginHeavyAnimation(JUMP_MS + 50);   // дорисовка секций и прочая отложенная работа — после доводки
        let raf = 0;
        const t0 = performance.now();
        const step = (now: number) => {
          const t = Math.min(1, (now - t0) / JUMP_MS);
          el.scrollTop = start + (to - start) * easeInOut(t);
          if (t < 1) raf = requestAnimationFrame(step); else { off(); land(); }
        };
        // колесо или палец посреди доводки — дальше прокручивает человек
        const cut = () => { cancelAnimationFrame(raf); off(); if (state.jump === jump) state.jump = null; };
        const off = () => { el.removeEventListener('wheel', cut); el.removeEventListener('pointerdown', cut); el.removeEventListener('touchstart', cut); stop.current = () => {}; };
        el.addEventListener('wheel', cut, { passive: true });
        el.addEventListener('pointerdown', cut);
        el.addEventListener('touchstart', cut, { passive: true });
        stop.current = cut;
        raf = requestAnimationFrame(step);
      });
    });
  };
  useEffect(() => () => stop.current(), []);
  useEffect(() => { if (state.active >= count) set(0, state.top); }, [count]);
  return { scroller, state, onScroll, go };
}

/**
 * group — с этого номера кнопки собраны в группу (категории эмодзи, как в Telegram Web K): пока подсвечено что-то
 * до неё («Часто используемые»), группа свёрнута в одну иконку; категория внутри — раскрыта на подложке (200 мс).
 */
function Strip({ items, group, state, go }: { items: ComponentChildren[]; group?: number; state: SectionsState; go(i: number): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [, redraw] = useState(0);
  useEffect(() => { const f = () => redraw((n) => n + 1); state.subs.add(f); return () => { state.subs.delete(f); }; }, [state]);
  const { active, top } = state;
  // центрируем активную кнопку прокруткой только самой полосы: scrollIntoView прокрутил бы и всех предков —
  // вплоть до корня приложения (он сдвигался вбок посреди выезда правой панели)
  useEffect(() => requestMeasure(() => {
    const strip = ref.current, el = strip?.querySelectorAll<HTMLElement>('.app-sym-strip-btn')[active];
    if (!strip || !el || !strip.clientWidth) return;
    const left = Math.max(0, el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2);
    if (Math.abs(strip.scrollLeft - left) > 1) requestMutation(() => strip.scrollTo({ left, behavior: 'smooth' }));
  }), [active]);
  const btn = (i: number, folded = false) => (
    <button key={i} type="button" role="tab" aria-selected={i === active} tabIndex={folded ? -1 : undefined} class={'app-sym-strip-btn' + (i === active ? ' is-on' : '')} onClick={() => go(i)}>{items[i]}</button>
  );
  return (
    <div class={'app-sym-strip' + (!top ? ' has-border' : '')} ref={ref} role="tablist">
      {group == null ? items.map((_, i) => btn(i)) : (
        <>
          {items.slice(0, group).map((_, i) => btn(i))}
          <div class={'app-sym-strip-group' + (active >= group ? ' is-open' : '')} style={{ '--n': items.length - group }}>
            {items.slice(group).map((_, k) => btn(group + k, active < group && k > 0))}
          </div>
        </>
      )}
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
// selected — выбранный эмодзи подсвечен; tones — выбор оттенка кожи (правая кнопка или удержание пальцем)
// epoch — панель закрылась: перечитать «Часто используемые» (пока она открыта, ряд под курсором не меняется)
export function EmojiTab({ onPick, animate, selected, epoch, tones = false }: { onPick(e: string): void; animate?: (e: string) => string | undefined; selected?: string | null; epoch?: number; tones?: boolean }) {
  const [recent, setRecent] = useState(recentEmoji);
  useEffect(() => { if (epoch) setRecent(recentEmoji()); }, [epoch]);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [toneOf, setToneOf] = useState<Record<string, number>>(() => (tones ? savedTones() : {}));
  const [toneMenu, setToneMenu] = useState<ToneMenuAt | null>(null);
  const chips = useChips('emoji');
  const chip = group != null ? chips?.[group] : undefined;
  const found = chip ? chip.emoticons : q.trim() ? searchEmoji(q) : null;
  const base = recent.length ? [{ id: 'recent', title: 'Часто используемые', icon: 'clock', list: recent }, ...EMOJI] : EMOJI;
  const cats = found ? [{ id: 'found', title: chip ? chip.label : 'Найдено', icon: 'search', list: found }] : base;
  const s = useSections(cats.length);
  const sections = useRef<HTMLDivElement>(null);
  // ячейки получают постоянный ctx: смена выбранного оттенка или наведение не перерисовывают тысячу кнопок
  const ctx = useRef<CellCtx>(null!);
  ctx.current = { pick: (e) => { pushRecentEmoji(e); onPick(e); }, animate, tones, toneOf };
  // поиск, фильтр и категории сменяют друг друга кроссфейдом (200 мс), набор букв внутри поиска — без него
  const layer = (qq: string, g: number | null) => (g != null ? 'chip' + g : qq.trim() ? 'found' : 'base');
  const change = (qq: string, g: number | null) => {
    if (layer(qq, g) !== layer(q, group)) crossfade(s.scroller.current, sections.current);
    setGroup(g); setQ(qq);
  };
  const chooseTone = (base: string, t: number | null) => {
    saveTone(base, t);
    setToneOf((m) => { const n = { ...m }; if (t == null) delete n[base]; else n[base] = t; return n; });
    ctx.current.pick(t == null ? base : emojiTones(base)![t]);
    setToneMenu(null);
  };
  const hold = useToneHold(tones, (btn) => { const e = btn.dataset.e!; if (emojiTones(e)) setToneMenu(toneMenuAt(btn, e)); });
  return (
    <div class={'app-sym-pane' + (focused || found ? ' is-searching' : '')}>
      {/* полоса при поиске уезжает вверх с прежними иконками — не пустеет на лету */}
      <Strip items={base.map((c) => <Icon name={c.icon} size={24} />)} group={recent.length ? 1 : 0} state={s.state} go={s.go} />
      <div class="app-sym-scroll" ref={s.scroller} onScroll={() => { s.onScroll(); if (toneMenu) setToneMenu(null); }} {...hold}>
        <SearchRow placeholder="Поиск эмодзи" q={q} setQ={(v) => change(v, null)} group={group} setGroup={(g) => change(g == null ? q : '', g)} chips={chips} onFocus={setFocused} />
        <div ref={sections}>
          {cats.map((c, i) => <EmojiSectionMemo key={c.id} cat={c} eager={i < 2} root={s.scroller} ctx={ctx} selected={selected} toneOf={toneOf} />)}
          {found && !found.length ? <p class="app-sym-empty">Эмодзи не найдены</p> : null}
        </div>
      </div>
      <ToneMenu at={toneMenu} chosen={toneMenu ? toneOf[toneMenu.e] ?? null : null} onChoose={chooseTone} onClose={() => setToneMenu(null)} />
    </div>
  );
}

interface CellCtx { pick(e: string): void; animate?: (e: string) => string | undefined; tones: boolean; toneOf: Record<string, number> }

/** Снимок прежнего содержимого гаснет поверх нового, новое проявляется (как смена результатов в Telegram Web K). */
let lastGhost = 0;
function crossfade(scroller: HTMLElement | null, content: HTMLElement | null): void {
  if (!scroller || !content || reducedMotion() || performance.now() - lastGhost < 50) return;
  lastGhost = performance.now();
  const pane = scroller.parentElement!;
  const frame = document.createElement('div');   // окно прокрутки: снимок обрезан так же, как живое содержимое
  frame.className = 'app-sym-ghost';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.top = scroller.offsetTop + 'px';
  frame.style.height = scroller.clientHeight + 'px';
  frame.style.transform = getComputedStyle(scroller).transform;
  const ghost = content.cloneNode(true) as HTMLElement;
  ghost.style.transform = `translateY(${content.offsetTop - scroller.offsetTop - scroller.scrollTop}px)`;
  frame.appendChild(ghost);
  pane.appendChild(frame);
  const opts = { duration: 200, easing: 'cubic-bezier(.4, 0, .2, 1)' };
  frame.animate([{ opacity: 1 }, { opacity: 0 }], opts).finished.then(() => frame.remove(), () => frame.remove());
  content.animate([{ opacity: 0 }, { opacity: 1 }], opts);
}

// эмодзи-глифы дороги в отрисовке (≈1900 штук — 100+ мс, на слабом CPU ×4 — полсекунды): категория наполняется,
// когда подъехала к экрану (300 px), и опустошается, когда ушла далеко (1 200 px) — в DOM живут только соседние
// с экраном. Наполняется частями по CHUNK плиток за кадр — с той стороны, откуда её видно (снизу — с начала,
// сверху — с конца), и не во время анимаций (открытие, слайд вкладки, переход к категории). Высота
// зарезервирована заранее — прокрутка не прыгает
type Fill = 'head' | 'tail';
interface Win { from: number; to: number; fill: Fill }
const CHUNK = 64;   // 8 рядов — видимая часть секции; столько плиток кадр успевает и при CPU ×4
function opened(len: number, fill: Fill, n = CHUNK): Win {
  return fill === 'tail' ? { from: Math.max(0, len - n), to: len, fill } : { from: 0, to: Math.min(len, n), fill };
}
/** Общая очередь дорисовки: за кадр — одна часть одной секции, сколько бы их ни наполнялось (после перехода к
 *  категории их три), и только когда тяжёлых анимаций нет. */
const fillers: (() => void)[] = [];
let fillRaf = 0;
function runFill(): void {
  fillRaf = 0;
  fillers.shift()?.();
  if (fillers.length) nextFill();
}
function nextFill(): void {
  onHeavyAnimationEnd(() => { if (!fillRaf && fillers.length) fillRaf = requestAnimationFrame(runFill); });
}
function queueFill(fn: () => void): () => void {
  fillers.push(fn);
  nextFill();
  return () => { const i = fillers.indexOf(fn); if (i >= 0) fillers.splice(i, 1); };
}
function grown(w: Win, len: number): Win {
  // сначала в сторону, откуда секцию видно, потом в другую
  if (w.fill === 'head') return w.to < len ? { ...w, to: Math.min(len, w.to + CHUNK) } : { ...w, from: Math.max(0, w.from - CHUNK) };
  return w.from > 0 ? { ...w, from: Math.max(0, w.from - CHUNK) } : { ...w, to: Math.min(len, w.to + CHUNK) };
}
function EmojiSection({ cat, eager, root, ctx, selected, toneOf }: { cat: { id: string; title: string; list: string[] }; eager: boolean; root: { current: HTMLDivElement | null }; ctx: { current: CellCtx }; selected?: string | null; toneOf: Record<string, number> }) {
  const el = useRef<HTMLElement>(null);
  const len = cat.list.length;
  const [win, setWin] = useState<Win | null>(() => (eager ? opened(len, 'head') : null));
  const shown = !!win;
  useEffect(() => {
    const sec = el.current;
    if (!sec) return;
    if (!shown) {
      const io = new IntersectionObserver((es) => {
        const e = es[es.length - 1];
        if (!e.isIntersecting) return;
        // секция выше окна (прокрутка вверх) — к экрану обращён её конец
        setWin((w) => w ?? opened(len, e.boundingClientRect.top < (e.rootBounds?.top ?? 0) ? 'tail' : 'head'));
      }, { root: root.current, rootMargin: '300px 0px' });
      io.observe(sec);
      // переход к категории: наполниться до прокрутки — нужной стороной и нужным количеством
      const show = (ev: Event) => { const d = (ev as CustomEvent<{ fill: Fill; n: number }>).detail; setWin((w) => w ?? opened(len, d.fill, d.n)); };
      sec.addEventListener(SEC_SHOW, show);
      return () => { io.disconnect(); sec.removeEventListener(SEC_SHOW, show); };
    }
    // опустошаем не сразу, а когда секция полсекунды пробыла вдали: не посреди перехода к категории или броска
    // прокрутки, где удаление сотен узлов стоило бы кадров
    let t = 0;
    const io = new IntersectionObserver((es) => {
      const e = es[es.length - 1];
      clearTimeout(t);
      // вкладка или панель скрыты (display: none) — «не пересекается» ничего не значит, держим
      if (!e.isIntersecting && !tabOff(root.current)) t = window.setTimeout(() => setWin(null), UNLOAD_MS);
    }, { root: root.current, rootMargin: '1200px 0px' });
    io.observe(sec);
    // уже наполняется, но не с той стороны, что будет видна после перехода — догнать ту сторону сразу
    const extend = (ev: Event) => {
      const d = (ev as CustomEvent<{ fill: Fill; n: number }>).detail;
      setWin((w) => !w ? opened(len, d.fill, d.n) : d.fill === 'head' && w.from > 0 ? { ...w, from: 0 } : d.fill === 'tail' && w.to < len ? { ...w, to: len } : w);
    };
    sec.addEventListener(SEC_SHOW, extend);
    return () => { clearTimeout(t); io.disconnect(); sec.removeEventListener(SEC_SHOW, extend); };
  }, [shown]);
  // дорисовка: следующая часть — в общей очереди (кадр — одна часть на всю вкладку)
  useEffect(() => {
    if (!win || (win.from === 0 && win.to === len)) return;
    return queueFill(() => setWin((w) => w && grown(w, len)));
  }, [win, len]);
  // первая плитка окна стоит на своём месте сетки: ряды над ней пустые, но той же высоты
  const place = win && win.from ? { gridRowStart: Math.floor(win.from / EMOJI_COLS) + 1, gridColumnStart: (win.from % EMOJI_COLS) + 1 } : undefined;
  return (
    <section ref={el} data-sec class="app-sym-sec">
      <h4>{cat.title}</h4>
      <div class="app-emoji-grid" style={{ minHeight: Math.ceil(len / EMOJI_COLS) * EMOJI_ROW + 'px' }}>
        {win ? cat.list.slice(win.from, win.to).map((e, k) => <EmojiCellMemo key={e} e={e} v={toneOf[e] != null ? emojiTones(e)?.[toneOf[e]] ?? e : e} on={selected === e} ctx={ctx} place={k === 0 ? place : undefined} />) : null}
      </div>
    </section>
  );
}
const EmojiSectionMemo = memo(EmojiSection);

/** Кнопка эмодзи: v — что показать и вставить (с выбранным оттенком); наведение — своя анимация поверх глифа. */
function EmojiCell({ e, v, on, ctx, place }: { e: string; v: string; on: boolean; ctx: { current: CellCtx }; place?: { gridRowStart: number; gridColumnStart: number } }) {
  const [hover, setHover] = useState(false);
  const [drawn, setDrawn] = useState(false);   // у анимации есть первый кадр — глиф под ней прячем
  const { animate, tones } = ctx.current;
  const src = hover && animate && !reducedMotion() ? animate(v) : undefined;
  return (
    <button type="button" class={'app-emoji' + (on ? ' is-on' : '')} style={place} data-e={e} data-tones={tones && emojiTones(e) ? '' : undefined}
      aria-label={v} aria-pressed={on || undefined} onClick={() => ctx.current.pick(v)}
      onMouseEnter={animate ? () => { if (animate(v)) { setDrawn(false); setHover(true); } } : undefined} onMouseLeave={animate ? () => setHover(false) : undefined}>
      <span class={src && drawn ? 'is-under' : undefined}><EmojiGlyph e={v} /></span>
      {src ? <StickerView src={src} w={512} h={512} size={34} group="menu" force loop={false} onFirstFrame={() => setDrawn(true)} onEnded={() => setHover(false)} /> : null}
    </button>
  );
}
const EmojiCellMemo = memo(EmojiCell);

/** Меню оттенков: где стоит (над плиткой или под ней) и для какого эмодзи. */
interface ToneMenuAt { e: string; x: number; y: number; below: boolean }
const TONE_W = 6 * 32 + 12, TONE_H = 32 + 12, TONE_HOLD_MS = 400;
function toneMenuAt(btn: HTMLElement, e: string): ToneMenuAt {
  const pane = btn.closest('.app-sym-pane')!.getBoundingClientRect(), r = btn.getBoundingClientRect();
  const x = Math.max(8, Math.min(pane.width - TONE_W - 8, r.left + r.width / 2 - pane.left - TONE_W / 2));
  const above = r.top - pane.top - TONE_H - 8;
  return above >= 8 ? { e, x, y: above, below: false } : { e, x, y: r.bottom - pane.top + 8, below: true };
}

/** Правая кнопка мыши или удержание пальцем 400 мс (сдвиг пальца отменяет) открывают меню оттенков. */
function useToneHold(on: boolean, open: (btn: HTMLElement) => void) {
  const t = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  if (!on) return {};
  const target = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('.app-emoji[data-tones]');
  const cancel = () => { if (t.current) clearTimeout(t.current.timer); t.current = null; };
  return {
    onContextMenu: (e: MouseEvent) => { const b = target(e); if (b) { e.preventDefault(); open(b); } },
    onPointerDown: (e: PointerEvent) => {
      const b = target(e);
      if (!b || e.pointerType === 'mouse') return;
      cancel();
      const st = { timer: 0, x: e.clientX, y: e.clientY, fired: false };
      st.timer = window.setTimeout(() => { st.fired = true; open(b); }, TONE_HOLD_MS);
      t.current = st;
    },
    onPointerMove: (e: PointerEvent) => { const st = t.current; if (st && !st.fired && Math.hypot(e.clientX - st.x, e.clientY - st.y) > 8) cancel(); },
    onPointerUp: () => { if (t.current && !t.current.fired) cancel(); },
    onPointerCancel: cancel,
    // после срабатывания удержания отпускание пальца — не выбор эмодзи
    onClickCapture: (e: MouseEvent) => { if (t.current?.fired) { e.stopPropagation(); e.preventDefault(); t.current = null; } },
  };
}

/** Шесть вариантов в ряд над плиткой: прозрачность и масштаб за 200 мс; Esc, щелчок мимо или прокрутка — закрыть. */
function ToneMenu({ at, chosen, onChoose, onClose }: { at: ToneMenuAt | null; chosen: number | null; onChoose(base: string, t: number | null): void; onClose(): void }) {
  const [shownAt, setShownAt] = useState<ToneMenuAt | null>(at);
  const [on, setOn] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (at) {
      setShownAt(at);
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
      return () => cancelAnimationFrame(r);
    }
    setOn(false);
    const t = setTimeout(() => setShownAt(null), reducedMotion() ? 0 : 200);
    return () => clearTimeout(t);
  }, [at]);
  useEffect(() => {
    if (!at) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };   // раньше панели: закрыть только меню
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc, true); };
  }, [at]);
  if (!shownAt) return null;
  const variants = [shownAt.e, ...(emojiTones(shownAt.e) ?? [])];
  return (
    <div ref={ref} class={'app-sym-tones' + (on && at ? ' is-on' : '') + (shownAt.below ? ' is-below' : '')} role="menu" aria-label="Оттенок кожи" style={{ left: shownAt.x + 'px', top: shownAt.y + 'px' }}>
      {variants.map((v, i) => (
        <button key={v} type="button" role="menuitemradio" aria-checked={(i === 0 ? null : i - 1) === chosen} class={'app-sym-tone' + ((i === 0 ? null : i - 1) === chosen ? ' is-on' : '')} aria-label={v} onClick={() => onChoose(shownAt.e, i === 0 ? null : i - 1)}>
          <EmojiGlyph e={v} />
        </button>
      ))}
    </div>
  );
}

type Section = { key: string; title: string; set?: StickerSetInfo; stickers?: StickerRef[]; count: number; clear?: boolean };

function StickersTab({ onPick, epoch }: { onPick(s: StickerRef): void; epoch: number }) {
  const mine = useMyStickers();
  // «Недавние» — снимок на время показа; панель закрылась (epoch) — снимок снимается заново
  const frozen = useRef<StickerRef[] | null>(null);
  const seen = useRef(epoch);
  if (seen.current !== epoch) { seen.current = epoch; frozen.current = null; }
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
      if (!e.isIntersecting && tabOff(root.current)) return;   // вкладка скрыта
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
  // содержимое пака — когда секция в 500 px от видимой области; первые паки — сразу: вкладка строится скрытой
  // заранее, и к её показу сетка уже есть (иначе пак доезжал посреди анимации смены вкладки)
  useEffect(() => {
    if (sec.stickers || !sec.set || !el.current) return;
    const set = sec.set;
    let live = true;
    const load = () => loadStickerSet(set.id, set.hash).then((full) => { if (live && full) setStickers(full.stickers); }, () => {});
    if (eager) { void load(); return () => { live = false; }; }
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void load();
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
