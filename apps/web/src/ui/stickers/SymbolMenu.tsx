/** @jsxImportSource preact */
import type { StickerRef, StickerSetInfo } from '@relay/protocol';
import { Icon, IconButton, MenuPopover, StickerView, confirmModal, requestMeasure, requestMutation } from '@relay/ui';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { clearRecentStickers, faveSticker, loadStickerSet, openStickerSet, searchSets, stickersByEmoji, useMyStickers } from '../../stickers';
import { EMOJI, QUICK, pushRecentEmoji, recentEmoji, searchEmoji } from './emojiData';
import { StickerPreviewHold } from './StickerPreview';

// Панель эмодзи и стикеров над полем ввода — по образцу Telegram Web K: полоса категорий сверху (49 px),
// строка поиска с контурными фильтрами прокручивается вместе с содержимым, заголовки секций по центру,
// вкладки внизу. Панель живёт в DOM и после закрытия (composer.js), поэтому «Недавние» обновляются только
// когда она закрыта — под курсором ничего не перестраивается.
type Tab = 'emoji' | 'stickers';
const TAB_KEY = 'relay.symbols.tab';
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
  const [dir, setDir] = useState<'l' | 'r' | null>(null);
  // закрыли панель — со следующего открытия «Недавние» свежие (ключ пересоздаёт вкладку, пока её не видно)
  const [epoch, setEpoch] = useState(0);
  const wasOpen = useRef(p.open);
  useEffect(() => { if (wasOpen.current && !p.open) setEpoch((n) => n + 1); wasOpen.current = p.open; }, [p.open]);
  const pick = (t: Tab) => {
    if (t === tab) return;
    setDir(t === 'stickers' ? 'r' : 'l');
    setTab(t);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* ok */ }
  };
  return (
    <div class="app-sym">
      <div class={'app-sym-body' + (dir ? ' app-sym-from-' + dir : '')} key={tab + ':' + epoch}>
        {tab === 'emoji' ? <EmojiTab onPick={p.onEmoji} /> : <StickersTab onPick={p.onSticker} />}
      </div>
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
function useSections(count: number) {
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [top, setTop] = useState(true);
  const onScroll = () => requestMeasure(() => {
    const el = scroller.current;
    if (!el) return;
    const secs = el.querySelectorAll<HTMLElement>('[data-sec]');
    let cur = 0;
    secs.forEach((s, i) => { if (s.offsetTop - el.offsetTop <= el.scrollTop + 8) cur = i; });
    const atTop = el.scrollTop <= 0;
    requestMutation(() => { setActive(cur); setTop(atTop); });
  });
  const go = (i: number) => requestMeasure(() => {
    const el = scroller.current, sec = el?.querySelectorAll<HTMLElement>('[data-sec]')[i];
    if (!el || !sec) return;
    const y = i === 0 ? 0 : sec.offsetTop - el.offsetTop;
    requestMutation(() => { el.scrollTo({ top: y, behavior: 'smooth' }); setActive(i); });
  });
  useEffect(() => { if (active >= count) setActive(0); }, [count]);
  return { scroller, active, top, onScroll, go };
}

function Strip({ items, active, go, border }: { items: ComponentChildren[]; active: number; go(i: number): void; border: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // центрируем активную кнопку прокруткой только самой полосы: scrollIntoView прокрутил бы и всех предков —
  // вплоть до корня приложения (он сдвигался вбок посреди выезда правой панели)
  useEffect(() => requestMeasure(() => {
    const strip = ref.current, el = strip?.children[active] as HTMLElement | undefined;
    if (!strip || !el || !strip.clientWidth) return;
    const left = Math.max(0, el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2);
    if (Math.abs(strip.scrollLeft - left) > 1) requestMutation(() => strip.scrollTo({ left, behavior: 'smooth' }));
  }), [active]);
  return (
    <div class={'app-sym-strip' + (border ? ' has-border' : '')} ref={ref} role="tablist">
      {items.map((it, i) => <button key={i} type="button" role="tab" aria-selected={i === active} class={'app-sym-strip-btn' + (i === active ? ' is-on' : '')} onClick={() => go(i)}>{it}</button>)}
    </div>
  );
}

/** Строка поиска с контурными фильтрами справа; выбранный фильтр — стрелка «назад» вместо лупы. */
function SearchRow({ placeholder, q, setQ, group, setGroup }: { placeholder: string; q: string; setQ(v: string): void; group: number | null; setGroup(i: number | null): void }) {
  return (
    <div class={'app-sym-search' + (q ? ' is-typing' : '')}>
      {group != null
        ? <button type="button" class="app-sym-search-icon is-back" aria-label="Назад" onClick={() => setGroup(null)}><Icon name="arrowLeft" size={20} /></button>
        : <span class="app-sym-search-icon" aria-hidden="true"><Icon name="search" size={20} /></span>}
      <input type="text" placeholder={placeholder} value={q} aria-label={placeholder} onInput={(e) => { setGroup(null); setQ((e.target as HTMLInputElement).value); }} />
      {q ? <IconButton icon="close" label="Очистить" size={18} onClick={() => setQ('')} /> : (
        <div class="app-sym-chips">
          {QUICK.map((c, i) => (
            <button key={c.icon} type="button" class={'app-sym-chip' + (group === i ? ' is-on' : '')} aria-label={c.label} title={c.label} onClick={() => setGroup(group === i ? null : i)}>
              <Icon name={c.icon} size={20} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EmojiTab({ onPick }: { onPick(e: string): void }) {
  const [recent] = useState(recentEmoji);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<number | null>(null);
  const found = group != null ? QUICK[group].group : q.trim() ? searchEmoji(q) : null;
  const cats = found ? [{ id: 'found', title: group != null ? QUICK[group].label : 'Найдено', icon: 'search', list: found }]
    : recent.length ? [{ id: 'recent', title: 'Часто используемые', icon: 'clock', list: recent }, ...EMOJI] : EMOJI;
  const s = useSections(cats.length);
  const pick = (e: string) => { pushRecentEmoji(e); onPick(e); };
  return (
    <div class="app-sym-pane">
      <Strip items={(found ? [] : cats).map((c) => <Icon name={c.icon} size={24} />)} active={s.active} go={s.go} border={!s.top} />
      <div class="app-sym-scroll" ref={s.scroller} onScroll={s.onScroll}>
        <SearchRow placeholder="Поиск эмодзи" q={q} setQ={setQ} group={group} setGroup={setGroup} />
        {cats.map((c, i) => <EmojiSection key={c.id} cat={c} eager={i < 2} root={s.scroller} onPick={pick} />)}
        {found && !found.length ? <p class="app-sym-empty">Эмодзи не найдены</p> : null}
      </div>
    </div>
  );
}

// эмодзи-глифы дороги в отрисовке (≈1500 штук — 100+ мс): категория наполняется, когда подъехала к экрану,
// а её высота зарезервирована заранее — прокрутка не прыгает
function EmojiSection({ cat, eager, root, onPick }: { cat: { id: string; title: string; list: string[] }; eager: boolean; root: { current: HTMLDivElement | null }; onPick(e: string): void }) {
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
        {shown ? cat.list.map((e) => <button key={e} type="button" class="app-emoji" onClick={() => onPick(e)}>{e}</button>) : null}
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
  const [found, setFound] = useState<{ stickers?: StickerRef[]; sets?: StickerSetInfo[] } | null>(null);
  const [menu, setMenu] = useState<{ s: StickerRef; el: HTMLElement; recent: boolean } | null>(null);

  // поиск: фильтр или эмодзи — стикеры с ним (свои паки первыми); текст — паки по названию
  useEffect(() => {
    const text = group != null ? QUICK[group].emoji : q.trim();
    if (!text) { setFound(null); return; }
    let live = true;
    const t = setTimeout(() => {
      const isEmoji = /\p{Extended_Pictographic}/u.test(text);
      (isEmoji ? stickersByEmoji(text).then((stickers) => ({ stickers })) : searchSets(text).then((sets) => ({ sets })))
        .then((r) => { if (live) setFound(r); }, () => { if (live) setFound({ stickers: [] }); });
    }, group != null ? 0 : 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, group]);

  const sections: Section[] = found?.stickers ? [{ key: 'found', title: group != null ? QUICK[group].label : 'Найдено', stickers: found.stickers, count: found.stickers.length }]
    : [
      ...(found?.sets ? [] : [
        ...(mine.faved.length ? [{ key: 'faved', title: 'Избранное', stickers: mine.faved, count: mine.faved.length }] : []),
        ...(recent.length ? [{ key: 'recent', title: 'Недавние', stickers: recent, count: recent.length, clear: true }] : []),
      ]),
      ...(found?.sets ?? mine.sets).filter((x) => x.kind === 'sticker').map((set) => ({ key: 'set' + set.id, title: set.title, set, count: set.count })),
    ];
  const s = useSections(sections.length);
  const stripItems = (found ? [] : sections).map((sec) => sec.key === 'faved' ? <Icon name="bookmark" size={24} /> : sec.key === 'recent' ? <Icon name="clock" size={24} />
    : sec.set?.cover ? <StickerView src={sec.set.cover.url} outline={sec.set.cover.outline} w={512} h={512} size={30} play={false} group="panel" title={sec.title} /> : <Icon name="sticker" size={24} />);

  const clearRecent = async () => {
    if (await confirmModal({ title: 'Очистить недавние стикеры?', confirm: 'Очистить', danger: true })) {
      frozen.current = [];
      void clearRecentStickers();
    }
  };

  return (
    <div class="app-sym-pane">
      <Strip items={stripItems} active={s.active} go={s.go} border={!s.top} />
      <div class="app-sym-scroll" ref={s.scroller} onScroll={s.onScroll}>
        <SearchRow placeholder="Поиск стикеров" q={q} setQ={setQ} group={group} setGroup={setGroup} />
        {sections.map((sec) => (
          <StickerSection key={sec.key} sec={sec} root={s.scroller} onPick={onPick}
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

function StickerSection({ sec, root, onPick, onClear, onMenu }: { sec: Section; root: { current: HTMLDivElement | null }; onPick(s: StickerRef): void; onClear?: () => void; onMenu(s: StickerRef, el: HTMLElement): void }) {
  const el = useRef<HTMLElement>(null);
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
        {stickers?.map((s) => (
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
