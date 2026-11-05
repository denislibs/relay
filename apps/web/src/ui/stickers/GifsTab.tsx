/** @jsxImportSource preact */
import type { SavedGif } from '@relay/protocol';
import { EmptyState, MenuPopover, onHeavyAnimationEnd, reducedMotion, requestMeasure, requestMutation, videoObserve } from '@relay/ui';
import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { gifSendOptions, removeSavedGif, useSavedGifs, type GifSend } from '../../gifs';
import { gifLayout, gifWindow } from './gifLayout';

// Вкладка GIF: мозаика сохранённых, новые сверху. Источник плиток — только список SavedGif: другой источник (поиск) встанет
// рядом с тем же GifGrid. Как у стикеров, дорогое не создаётся впрок:
//  - в DOM только плитки у экрана (окно ±WINDOW_PX), остальное — зарезервированная высота: на 200 сохранённых не больше 40 плиток;
//  - декодер (<video> или <img> с GIF) подключается, только когда плитка видна и панель открыта, по очереди, не больше двух за кадр
//    и не во время анимаций; ушла с экрана — пауза, ушла из окна — декодер отпущен;
//  - видимость — общий наблюдатель роликов ленты (videoObserve): и просмотрщик поверх ставит их на паузу.
const WINDOW_PX = 300;
const ATTACH_PER_FRAME = 2;
const HOLD_MS = 400;
const SCROLL_QUIET_MS = 120;

const queue: { fn: () => void; live: boolean }[] = [];
let raf = 0, scrolledAt = 0;
function run(): void {
  raf = 0;
  // пока сетку прокручивают, новые декодеры не заводим: при броске прокрутки до них всё равно не дойдёт, а кадр им нужнее
  if (performance.now() - scrolledAt < SCROLL_QUIET_MS) { raf = requestAnimationFrame(run); return; }
  let n = 0;
  while (queue.length && n < ATTACH_PER_FRAME) { const j = queue.shift()!; if (j.live) { j.fn(); n++; } }
  if (queue.length) next();
}
function next(): void { onHeavyAnimationEnd(() => { if (!raf && queue.length) raf = requestAnimationFrame(run); }); }
function queueAttach(fn: () => void): () => void {
  const job = { fn, live: true };
  queue.push(job);
  next();
  return () => { job.live = false; };
}

// копия loop — H.264: в браузере без него (и при ошибке декодера) плитка играет оригинал-GIF в <img>
let h264: boolean | null = null;
const canH264 = () => (h264 ??= !!document.createElement('video').canPlayType('video/mp4; codecs="avc1.4D401E"'));
const hasLoop = (g: SavedGif) => !!g.variants?.some((v) => v.name === 'loop');

function GifTile({ gif, x, y, w, h, active }: { gif: SavedGif; x: number; y: number; w: number; h: number; active: boolean }) {
  const el = useRef<HTMLButtonElement>(null), video = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [attached, setAttached] = useState(false);
  const [still, setStill] = useState(false);     // первый кадр сервера загружен
  const [drawn, setDrawn] = useState(false);     // анимация нарисовала кадр: поверх всего, с кроссфейдом
  const [broken, setBroken] = useState(false);
  const asVideo = hasLoop(gif) && canH264() && !broken;
  const want = active && visible && !reducedMotion();

  useEffect(() => (el.current ? videoObserve(el.current, setVisible) : undefined), []);
  useEffect(() => {
    if (attached || !want) return;
    return queueAttach(() => setAttached(true));
  }, [want, attached]);
  // <img> с GIF поставить на паузу нельзя: снимается, а видео стоит на своём кадре и не декодирует
  useEffect(() => {
    if (want || asVideo || !attached) return;
    setAttached(false); setDrawn(false);
  }, [want, asVideo, attached]);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (want) void v.play().catch(() => {});
    else v.pause();
  }, [want, attached, asVideo]);
  // плитка ушла из окна — отпустить декодер сразу, не дожидаясь сборки мусора элемента
  useEffect(() => () => { const v = video.current; if (v) { v.pause(); v.removeAttribute('src'); v.load(); } }, []);

  return (
    <button ref={el} type="button" class={'app-gif-tile' + (still ? ' has-still' : '') + (drawn ? ' is-drawn' : '')} data-gif={gif.id} aria-label="GIF" style={{ left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }}>
      {gif.thumb ? <img class="app-gif-thumb" src={gif.thumb} alt="" aria-hidden="true" draggable={false} /> : null}
      {gif.preview ? <img class="app-gif-still" src={`/files/${gif.id}/preview`} alt="" aria-hidden="true" decoding="async" fetchpriority="low" draggable={false} onLoad={() => setStill(true)} /> : null}
      {attached && asVideo
        ? <video ref={video} class="app-gif-anim" src={`/files/${gif.id}/loop`} muted loop playsInline disablePictureInPicture preload="auto" aria-hidden="true" onLoadedData={() => setDrawn(true)} onError={() => { setBroken(true); setDrawn(false); }} />
        : attached ? <img class="app-gif-anim" src={`/files/${gif.id}`} alt="" aria-hidden="true" decoding="async" draggable={false} onLoad={() => setDrawn(true)} /> : null}
    </button>
  );
}
const GifTileMemo = memo(GifTile);

export interface GifGridProps { items: SavedGif[]; active: boolean; onPick(g: SavedGif, how?: GifSend): void; onMenu(g: SavedGif, el: HTMLElement): void }

/** Сетка: раскладка из размеров, окно по прокрутке; нажатия — делегированием, плиткам обработчиков не раздаём. */
export function GifGrid({ items, active, onPick, onMenu }: GifGridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState<[number, number]>([0, 900]);
  const layout = useMemo(() => gifLayout(items, width), [items, width]);
  const byId = useMemo(() => new Map(items.map((g) => [g.id, g])), [items]);

  useLayoutEffect(() => {
    const s = scroller.current;
    if (!s) return;
    const measure = () => requestMeasure(() => {
      // панель закрыта (display: none) — размеры нулевые: плитки остаются как есть, их кадры пригодятся при следующем открытии
      if (!s.clientWidth) return;
      const cs = getComputedStyle(s), inner = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const top = s.scrollTop, bottom = top + s.clientHeight;
      requestMutation(() => { setWidth(inner); setView((v) => (v[0] === top && v[1] === bottom ? v : [top, bottom])); });
    });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(s);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => { scrolledAt = performance.now(); requestMeasure(() => {
    const s = scroller.current;
    if (!s) return;
    const top = s.scrollTop, bottom = top + s.clientHeight;
    requestMutation(() => setWindow(top, bottom));
  }); };
  // окно считается и на прокрутке, но состояние меняется, только если изменился набор плиток: прокрутка внутри окна сетку не трогает
  const shown = useRef<[number, number]>([0, 0]);
  const setWindow = (top: number, bottom: number) => {
    const [a, b] = gifWindow(layout.boxes, top, bottom, WINDOW_PX);
    if (a !== shown.current[0] || b !== shown.current[1]) setView([top, bottom]);
  };
  const [from, to] = gifWindow(layout.boxes, view[0], view[1], WINDOW_PX);
  shown.current = [from, to];

  const tile = (e: Event) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-gif]'); const g = b && byId.get(b.dataset.gif!); return g ? { g, b: b! } : null; };
  const hold = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const cancel = () => { if (hold.current) clearTimeout(hold.current.timer); hold.current = null; };
  useEffect(() => cancel, []);
  return (
    <div class="app-sym-scroll app-gif-scroll" ref={scroller} onScroll={onScroll}
      onClick={(e) => { if (hold.current?.fired) { hold.current = null; return; } const t = tile(e); if (t) onPick(t.g); }}
      onContextMenu={(e) => { const t = tile(e); if (t) { e.preventDefault(); cancel(); onMenu(t.g, t.b); } }}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse') return;   // удержание пальцем — то же меню; сдвиг отменяет (это прокрутка)
        const t = tile(e);
        if (!t) return;
        cancel();
        const st = { timer: 0, x: e.clientX, y: e.clientY, fired: false };
        st.timer = window.setTimeout(() => { st.fired = true; onMenu(t.g, t.b); }, HOLD_MS);
        hold.current = st;
      }}
      onPointerMove={(e) => { const st = hold.current; if (st && !st.fired && Math.hypot(e.clientX - st.x, e.clientY - st.y) > 8) cancel(); }}
      onPointerUp={() => { if (hold.current && !hold.current.fired) cancel(); }}
      onPointerCancel={cancel}>
      <div class="app-gif-grid" style={{ height: layout.height + 'px' }}>
        {layout.boxes.slice(from, to).map((b) => <GifTileMemo key={b.id} gif={byId.get(b.id)!} x={b.x} y={b.y} w={b.w} h={b.h} active={active} />)}
      </div>
    </div>
  );
}

export function GifsTab({ active, onPick }: { active: boolean; onPick(g: SavedGif, how?: GifSend): void }) {
  const { list, loaded } = useSavedGifs();
  const [menu, setMenu] = useState<{ g: SavedGif; el: HTMLElement } | null>(null);
  useEffect(() => { if (!active) setMenu(null); }, [active]);
  const opts = menu ? gifSendOptions() : null;
  return (
    <div class="app-sym-pane">
      {list.length ? <GifGrid items={list} active={active} onPick={onPick} onMenu={(g, el) => setMenu({ g, el })} />
        : loaded ? <div class="app-gif-empty"><EmptyState kind="gifs" title="Здесь будут ваши GIF" text="Сохраняйте GIF из сообщений: нажмите на GIF правой кнопкой" /></div> : null}
      <MenuPopover class="app-sym-keep" open={!!menu} anchor={menu?.el ?? null} placement="top-start" onClose={() => setMenu(null)} items={menu && opts ? [
        opts.silent ? { icon: 'bellOff', label: 'Отправить без звука', onClick: () => onPick(menu.g, { silent: true }) } : null,
        opts.later ? { icon: 'calendar', label: opts.laterLabel, onClick: () => onPick(menu.g, { later: true }) } : null,
        { icon: 'trash', label: 'Удалить из GIF', onClick: () => removeSavedGif(menu.g.id) },
      ].filter(Boolean) : []} />
    </div>
  );
}
