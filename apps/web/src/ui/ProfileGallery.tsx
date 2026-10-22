import type { UserPhoto } from '@relay/protocol';
import { Icon } from '@relay/ui';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

/** Сторона круглой аватарки в свёрнутой шапке и отступ над ней (CSS .app-hero-photo). */
const AVATAR = 120;

/**
 * Шапка профиля с фото, как в Telegram Web K. Свёрнута — круглая аватарка, под ней имя и статус по центру;
 * развёрнута (Info: колесо вверх или свайп вниз у самого верха) — то же фото во всю ширину квадратом, имя и
 * статус белым в левом нижнем углу, сверху полоски по числу фото. Переход — одним элементом: масштаб с 120 px
 * до ширины и скругление 50% → 0 (0.3 с), подписи переезжают из центра влево вниз.
 * Развёрнута: левая треть — назад, правая — вперёд (стрелки при наведении), свайп пальцем; середина — просмотр.
 * Свёрнута: нажатие разворачивает. Видео-аватарка играет без звука по кругу, пока её слайд на экране.
 * music — полоса прикреплённого трека внизу шапки (в обоих видах).
 */
export function ProfileGallery({ photos, index, onIndex, onOpen, name, sub, music, expanded, onExpand }: {
  photos: UserPhoto[]; index: number; onIndex: (i: number) => void; onOpen: (i: number) => void;
  name: ComponentChildren; sub: ComponentChildren; music?: ComponentChildren;
  expanded: boolean; onExpand: (on: boolean) => void;
}) {
  const n = photos.length;
  const i = Math.min(index, n - 1);
  const root = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; id: number; moved: boolean } | null>(null);
  const [dx, setDx] = useState(0);
  // список стал короче (фото удалили) — остаёмся в границах
  useEffect(() => { if (index > n - 1 && n) onIndex(n - 1); }, [n]);
  // свернули — снова первое фото (как в Telegram), без пролистывания: в свёрнутой шапке лента без перехода
  useEffect(() => { if (!expanded && i !== 0) onIndex(0); }, [expanded]);
  // масштаб квадрата во всю ширину до круга 120 px: от ширины панели (её меняют, перетаскивая край)
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const set = (w: number) => { if (w) el.style.setProperty('--hero-s', String(AVATAR / w)); };
    set(el.clientWidth);
    const ro = new ResizeObserver((es) => set(es[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const go = (d: number) => { const k = i + d; if (k >= 0 && k < n) onIndex(k); };
  const width = () => root.current?.clientWidth || 1;

  const down = (e: PointerEvent) => {
    if (!expanded || e.button !== 0 || (e.target as HTMLElement).closest('button, a')) return;   // кнопки поверх — свои клики
    drag.current = { x: e.clientX, y: e.clientY, dx: 0, id: e.pointerId, moved: false };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const mx = e.clientX - d.x;
    if (!d.moved && Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(e.clientY - d.y)) { d.moved = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }
    if (!d.moved) return;
    // за краями — с сопротивлением
    d.dx = (i === 0 && mx > 0) || (i === n - 1 && mx < 0) ? mx / 3 : mx;
    setDx(d.dx);
  };
  const up = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    if (d.moved) {
      setDx(0);
      if (Math.abs(d.dx) > width() * 0.18) go(d.dx < 0 ? 1 : -1);
      return;
    }
    // клик: края — листать, середина — просмотр
    const r = root.current!.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    if (n > 1 && x < 0.3) go(-1);
    else if (n > 1 && x > 0.7) go(1);
    else onOpen(i);
  };

  return (
    <div ref={wrap} class="app-hero-wrap">
      <div class={'app-hero' + (expanded ? ' is-expanded' : '') + (music ? ' has-music' : '')}>
        <div ref={root} class={'app-gallery app-hero-photo' + (dx ? ' is-dragging' : '')} onPointerDown={down} onPointerMove={move} onPointerUp={up}
          onPointerCancel={() => { drag.current = null; setDx(0); }} onClick={expanded ? undefined : () => onExpand(true)}
          role="group" aria-roledescription="галерея" aria-label={expanded ? `Фото профиля ${i + 1} из ${n}` : 'Развернуть фото профиля'}>
          <div class="app-gallery-track" style={{ transform: `translate3d(calc(${-i * 100}% + ${dx}px), 0, 0)` }}>
            {photos.map((p, k) => (
              <div key={p.pid || p.id} class="app-gallery-slide" data-gallery-slide={k} style={{ left: k * 100 + '%' }}>
                <span class="app-gallery-thumb" style={{ backgroundImage: `url("${p.thumb}")` }} />
                {Math.abs(k - i) <= 1 ? <img class="app-gallery-img" src={`/files/${p.id}`} alt="" draggable={false} decoding="async"
                  ref={(el) => { if (el && el.complete && el.naturalWidth) el.classList.add('is-ready'); }} onLoad={(e) => (e.currentTarget as HTMLElement).classList.add('is-ready')} /> : null}
                {p.video && k === i ? <video class="app-gallery-img app-gallery-video" src={`/files/${p.video}`} autoPlay loop muted playsInline disablePictureInPicture
                  onPlaying={(e) => (e.currentTarget as HTMLElement).classList.add('is-ready')} /> : null}
              </div>
            ))}
          </div>
          {n > 1 ? (
            <div class="app-gallery-bars" aria-hidden="true">
              {photos.map((p, k) => <span key={p.pid || p.id} class={k === i ? 'is-on' : ''} />)}
            </div>
          ) : null}
          {expanded && n > 1 && i > 0 ? <button type="button" class="app-gallery-nav app-gallery-prev" aria-label="Предыдущее фото" onPointerDown={(e) => e.stopPropagation()} onClick={() => go(-1)}><Icon name="chevronLeft" size={28} /></button> : null}
          {expanded && n > 1 && i < n - 1 ? <button type="button" class="app-gallery-nav app-gallery-next" aria-label="Следующее фото" onPointerDown={(e) => e.stopPropagation()} onClick={() => go(1)}><Icon name="chevronRight" size={28} /></button> : null}
        </div>
        <div class="app-hero-shade" aria-hidden="true" />
        <div class="app-hero-info">
          <div class="app-hero-name">{name}</div>
          <div class="app-hero-sub">{sub}</div>
        </div>
        {music}
      </div>
    </div>
  );
}
