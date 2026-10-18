import type { UserPhoto } from '@relay/protocol';
import { Icon } from '@relay/ui';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * Шапка профиля с фото, как в Telegram: квадрат во всю ширину панели, имя и статус поверх низа,
 * сверху полоски по числу фото. Левая треть — назад, правая — вперёд (стрелки при наведении), свайп
 * пальцем; середина — открыть просмотр с текущего фото. Видео-аватарка играет без звука по кругу,
 * пока её слайд на экране. Соседние слайды подгружаются заранее, дальние — нет.
 */
export function ProfileGallery({ photos, index, onIndex, onOpen, name, sub, extra }: {
  photos: UserPhoto[]; index: number; onIndex: (i: number) => void; onOpen: (i: number) => void;
  name: ComponentChildren; sub: ComponentChildren; extra?: ComponentChildren;
}) {
  const n = photos.length;
  const i = Math.min(index, n - 1);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; id: number; moved: boolean } | null>(null);
  const [dx, setDx] = useState(0);
  // список стал короче (фото удалили) — остаёмся в границах
  useEffect(() => { if (index > n - 1 && n) onIndex(n - 1); }, [n]);

  const go = (d: number) => { const k = i + d; if (k >= 0 && k < n) onIndex(k); };
  const width = () => root.current?.clientWidth || 1;

  const down = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a')) return;   // кнопки поверх (музыка, стрелки) — свои клики
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
    <div ref={root} class={'app-gallery' + (dx ? ' is-dragging' : '')} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; setDx(0); }}
      role="group" aria-roledescription="галерея" aria-label={`Фото профиля ${i + 1} из ${n}`}>
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
      {n > 1 && i > 0 ? <button type="button" class="app-gallery-nav app-gallery-prev" aria-label="Предыдущее фото" onPointerDown={(e) => e.stopPropagation()} onClick={() => go(-1)}><Icon name="chevronLeft" size={28} /></button> : null}
      {n > 1 && i < n - 1 ? <button type="button" class="app-gallery-nav app-gallery-next" aria-label="Следующее фото" onPointerDown={(e) => e.stopPropagation()} onClick={() => go(1)}><Icon name="chevronRight" size={28} /></button> : null}
      <div class="app-gallery-info">
        {extra}
        <div class="app-gallery-name">{name}</div>
        <div class="app-gallery-sub">{sub}</div>
      </div>
    </div>
  );
}
