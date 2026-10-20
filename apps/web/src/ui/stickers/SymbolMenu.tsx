/** @jsxImportSource preact */
import type { StickerRef, StickerSetInfo } from '@relay/protocol';
import { Icon, IconButton, MenuPopover, StickerView, confirmModal, requestMeasure, requestMutation } from '@relay/ui';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { clearRecentStickers, faveSticker, loadStickerSet, openStickerSet, searchSets, stickersByEmoji, useMyStickers } from '../../stickers';
import { EMOJI, QUICK, pushRecentEmoji, recentEmoji } from './emojiData';
import { StickerPreviewHold } from './StickerPreview';

// Панель эмодзи и стикеров над полем ввода (как в Telegram Web): вкладки внизу, у стикеров — полоса обложек
// паков сверху, поиск с быстрыми эмодзи, секции «Избранное», «Недавние» и паки. Высота секции резервируется по
// числу стикеров, содержимое пака грузится, когда секция подъехала к экрану, анимируются только видимые.
type Tab = 'emoji' | 'stickers';
const TAB_KEY = 'relay.symbols.tab';
const COLS = 5, CELL = 76;   // 72 + зазор

export interface SymbolMenuProps {
  onEmoji(e: string): void;
  onBackspace(): void;
  onSticker(s: StickerRef): void;
  onSearch(): void;   // правая панель «Стикеры»
}

export function SymbolMenu(p: SymbolMenuProps) {
  const [tab, setTab] = useState<Tab>(() => { try { return (localStorage.getItem(TAB_KEY) as Tab) || 'emoji'; } catch { return 'emoji'; } });
  const pick = (t: Tab) => { setTab(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* ok */ } };
  return (
    <div class="app-sym">
      <div class="app-sym-body" key={tab}>
        {tab === 'emoji' ? <EmojiTab onPick={p.onEmoji} /> : <StickersTab onPick={p.onSticker} />}
      </div>
      <div class="app-sym-bar">
        <span class="app-sym-side">{tab === 'stickers' ? <IconButton icon="search" label="Найти стикеры" onClick={p.onSearch} /> : null}</span>
        <div class="app-sym-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'emoji'} class={'app-sym-tab' + (tab === 'emoji' ? ' is-on' : '')} onClick={() => pick('emoji')} aria-label="Эмодзи"><Icon name="smile" size={22} /></button>
          <button type="button" role="tab" aria-selected={tab === 'stickers'} class={'app-sym-tab' + (tab === 'stickers' ? ' is-on' : '')} onClick={() => pick('stickers')} aria-label="Стикеры"><Icon name="sticker" size={22} /></button>
          <button type="button" role="tab" aria-selected={false} class="app-sym-tab" disabled title="GIF — скоро" aria-label="GIF"><Icon name="gif" size={22} /></button>
        </div>
        <span class="app-sym-side">{tab === 'emoji' ? <IconButton icon="backspace" label="Стереть" onClick={p.onBackspace} /> : null}</span>
      </div>
    </div>
  );
}

/** Полоса категорий сверху: активная следует за прокруткой, нажатие — плавно к секции. */
function useSections(count: number) {
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const onScroll = () => requestMeasure(() => {
    const el = scroller.current;
    if (!el) return;
    const secs = el.querySelectorAll<HTMLElement>('[data-sec]');
    let cur = 0;
    secs.forEach((s, i) => { if (s.offsetTop - el.offsetTop <= el.scrollTop + 8) cur = i; });
    if (cur !== active) requestMutation(() => setActive(cur));
  });
  const go = (i: number) => requestMeasure(() => {
    const el = scroller.current, sec = el?.querySelectorAll<HTMLElement>('[data-sec]')[i];
    if (!el || !sec) return;
    const top = sec.offsetTop - el.offsetTop;
    requestMutation(() => { el.scrollTo({ top, behavior: 'smooth' }); setActive(i); });
  });
  useEffect(() => { if (active >= count) setActive(0); }, [count]);
  return { scroller, active, onScroll, go };
}

function Strip({ items, active, go }: { items: preact.ComponentChildren[]; active: number; go(i: number): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.children[active] as HTMLElement | undefined;
    if (el) requestMutation(() => el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }));
  }, [active]);
  return (
    <div class="app-sym-strip" ref={ref} role="tablist">
      {items.map((it, i) => <button key={i} type="button" role="tab" aria-selected={i === active} class={'app-sym-strip-btn' + (i === active ? ' is-on' : '')} onClick={() => go(i)}>{it}</button>)}
    </div>
  );
}

function EmojiTab({ onPick }: { onPick(e: string): void }) {
  const recent = useMemo(recentEmoji, []);
  const cats = recent.length ? [{ id: 'recent', title: 'Недавние', icon: 'clock', list: recent }, ...EMOJI] : EMOJI;
  const s = useSections(cats.length);
  return (
    <div class="app-sym-pane">
      <Strip items={cats.map((c) => <Icon name={c.icon} size={20} />)} active={s.active} go={s.go} />
      <div class="app-sym-scroll" ref={s.scroller} onScroll={s.onScroll}>
        {cats.map((c) => (
          <section key={c.id} data-sec class="app-sym-sec">
            <h4>{c.title}</h4>
            <div class="app-emoji-grid">
              {c.list.map((e) => <button key={e} type="button" class="app-emoji" onClick={() => { pushRecentEmoji(e); onPick(e); }}>{e}</button>)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

type Section = { key: string; title: string; set?: StickerSetInfo; stickers?: StickerRef[]; count: number; clear?: boolean };

function StickersTab({ onPick }: { onPick(s: StickerRef): void }) {
  const mine = useMyStickers();
  // пока панель открыта, «Недавние» не перестраиваются под курсором (как в Telegram): берём их один раз
  const frozen = useRef<StickerRef[] | null>(null);
  if (!frozen.current && (mine.recent.length || mine.sets.length)) frozen.current = mine.recent;
  const recent = frozen.current ?? mine.recent;
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ stickers?: StickerRef[]; sets?: StickerSetInfo[] } | null>(null);
  const [menu, setMenu] = useState<{ s: StickerRef; el: HTMLElement; recent: boolean } | null>(null);

  // поиск: эмодзи — стикеры с ним (свои паки первыми), текст — паки по названию
  useEffect(() => {
    const text = q.trim();
    if (!text) { setFound(null); return; }
    let live = true;
    const t = setTimeout(() => {
      const isEmoji = /\p{Extended_Pictographic}/u.test(text);
      (isEmoji ? stickersByEmoji(text).then((stickers) => ({ stickers })) : searchSets(text).then((sets) => ({ sets })))
        .then((r) => { if (live) setFound(r); }, () => { if (live) setFound({ stickers: [] }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const sections: Section[] = found?.stickers ? [{ key: 'found', title: 'Найдено', stickers: found.stickers, count: found.stickers.length }]
    : [
      ...(found?.sets ? [] : [
        ...(mine.faved.length ? [{ key: 'faved', title: 'Избранное', stickers: mine.faved, count: mine.faved.length }] : []),
        ...(recent.length ? [{ key: 'recent', title: 'Недавние', stickers: recent, count: recent.length, clear: true }] : []),
      ]),
      ...(found?.sets ?? mine.sets).filter((x) => x.kind === 'sticker').map((set) => ({ key: 'set' + set.id, title: set.title, set, count: set.count })),
    ];
  const s = useSections(sections.length);
  const stripItems = sections.map((sec) => sec.key === 'faved' ? <Icon name="bookmark" size={20} /> : sec.key === 'recent' ? <Icon name="clock" size={20} />
    : sec.key === 'found' ? <Icon name="search" size={20} />
    : sec.set?.cover ? <StickerView src={sec.set.cover.url} outline={sec.set.cover.outline} w={512} h={512} size={30} play={false} group="panel" title={sec.title} /> : <Icon name="sticker" size={20} />);

  const clearRecent = async () => {
    if (await confirmModal({ title: 'Очистить недавние стикеры?', confirm: 'Очистить', danger: true })) {
      frozen.current = [];
      void clearRecentStickers();
    }
  };

  return (
    <div class="app-sym-pane">
      <Strip items={stripItems} active={s.active} go={s.go} />
      <div class="app-sym-search">
        <Icon name="search" size={18} />
        <input type="text" placeholder="Поиск стикеров" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Поиск стикеров" />
        {q ? <IconButton icon="close" label="Очистить" size={18} onClick={() => setQ('')} /> : (
          <div class="app-sym-quick">{QUICK.map((e) => <button key={e} type="button" onClick={() => setQ(e)}>{e}</button>)}</div>
        )}
      </div>
      <div class="app-sym-scroll" ref={s.scroller} onScroll={s.onScroll}>
        {sections.map((sec) => (
          <StickerSection key={sec.key} sec={sec} root={s.scroller} onPick={onPick}
            onClear={sec.clear ? clearRecent : undefined}
            onMenu={(st, el) => setMenu({ s: st, el, recent: sec.key === 'recent' })} />
        ))}
        {found && !sections.some((x) => x.count) ? <p class="app-sym-empty">Ничего не найдено</p> : null}
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
  const rows = Math.ceil(sec.count / COLS);
  return (
    <section ref={el} data-sec class="app-sym-sec">
      <h4>{sec.title}{onClear ? <IconButton icon="close" label="Очистить недавние" size={16} onClick={onClear} /> : null}</h4>
      <div class="app-stk-grid" style={{ minHeight: rows * CELL + 'px' }}>
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
