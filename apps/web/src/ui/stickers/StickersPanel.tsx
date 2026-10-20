/** @jsxImportSource preact */
import type { StickerRef, StickerSetInfo } from '@relay/protocol';
import { IconButton, ProgressRing, StickerView, useMinVisible } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { plural } from '../../groups';
import { closeStickersPanel, featuredSets, installSet, loadStickerSet, openStickerSet, searchSets, sendStickerHere, useMyStickers } from '../../stickers';
import { StickerPreviewHold } from './StickerPreview';

// Правая панель «Стикеры» (как в Telegram Web): поиск вместо заголовка; пусто — рекомендуемые паки страницами,
// текст — поиск по названию. Строка пака: название, «N стикеров», ДОБАВИТЬ/ДОБАВЛЕНО и полоса из пяти стикеров.
export function StickersPanel() {
  const [q, setQ] = useState('');
  const [list, setList] = useState<StickerSetInfo[] | null>(null);
  const [more, setMore] = useState(true);
  const loading = useMinVisible(list === null, { delay: 200, min: 500 });
  const mine = useMyStickers();
  const busyMore = useRef(false);
  const bottom = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeStickersPanel(); } };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);

  // поиск — с паузой 250 мс после ввода; пусто — первая страница рекомендуемых
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      const text = q.trim();
      (text ? searchSets(text) : featuredSets(0)).then((r) => { if (live) { setList(r); setMore(!text && r.length >= 20); } }, () => { if (live) setList([]); });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  // догрузка рекомендуемых, когда до низа меньше 500 px
  useEffect(() => {
    if (!more || !bottom.current) return;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting) || busyMore.current || !list) return;
      busyMore.current = true;
      featuredSets(list.length).then((r) => { setList((prev) => [...(prev ?? []), ...r.filter((x) => !(prev ?? []).some((y) => y.id === x.id))]); setMore(r.length >= 20); })
        .finally(() => { busyMore.current = false; });
    }, { root: scroller.current, rootMargin: '0px 0px 500px 0px' });
    io.observe(bottom.current);
    return () => io.disconnect();
  }, [more, list?.length]);

  return (
    <div class="app-stkpanel" aria-label="Стикеры">
      <div class="app-stkpanel-head">
        <IconButton icon="arrowLeft" label="Закрыть" onClick={closeStickersPanel} />
        <div class="app-stkpanel-search">
          <input type="text" placeholder="Поиск стикеров" value={q} autoFocus onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Поиск стикеров" />
          {q ? <IconButton icon="close" label="Очистить" size={18} onClick={() => setQ('')} /> : null}
        </div>
      </div>
      <div class="app-stkpanel-list" ref={scroller}>
        {loading ? <div class="app-stkpanel-load"><ProgressRing size={32} label="Загрузка паков" /></div> : null}
        {list?.map((set) => <SetRow key={set.id} set={set} installed={mine.sets.some((s) => s.id === set.id)} root={scroller} />)}
        {list && !list.length ? <p class="app-stkpanel-empty">Ничего не найдено</p> : null}
        <div ref={bottom} class="app-stkpanel-end" />
      </div>
    </div>
  );
}

function SetRow({ set, installed, root }: { set: StickerSetInfo; installed: boolean; root: { current: HTMLDivElement | null } }) {
  const el = useRef<HTMLDivElement>(null);
  const [first, setFirst] = useState<StickerRef[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!el.current) return;
    let live = true;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      loadStickerSet(set.id, set.hash).then((full) => { if (live && full) setFirst(full.stickers.slice(0, 5)); }, () => {});
    }, { root: root.current, rootMargin: '400px 0px' });
    io.observe(el.current);
    return () => { live = false; io.disconnect(); };
  }, [set.id]);
  const toggle = async (e: Event) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try { await installSet(set.id, !installed, installed ? undefined : set); } finally { setBusy(false); }
  };
  return (
    <div ref={el} class="app-stkrow" role="button" tabIndex={0} onClick={() => openStickerSet(set.id)} onKeyDown={(e) => { if (e.key === 'Enter') openStickerSet(set.id); }}>
      <div class="app-stkrow-head">
        <div class="app-stkrow-title">
          <b>{set.title}</b>
          <small>{set.count} {plural(set.count, 'стикер', 'стикера', 'стикеров')}</small>
        </div>
        <button type="button" class={'app-stkrow-btn' + (installed ? ' is-added' : '')} disabled={busy} onClick={toggle}>{installed ? 'ДОБАВЛЕНО' : 'ДОБАВИТЬ'}</button>
      </div>
      <div class="app-stkrow-strip">
        {(first ?? []).map((s) => (
          <StickerPreviewHold key={s.id} sticker={s}>
            <span class="app-stkrow-cell" onClick={(e) => { if (sendStickerHere(s)) e.stopPropagation(); }}>
              <StickerView src={s.url} outline={s.outline} w={s.w} h={s.h} size={64} group="aside" loop title={s.emoji} />
            </span>
          </StickerPreviewHold>
        ))}
      </div>
    </div>
  );
}
