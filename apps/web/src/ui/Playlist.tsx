import { Icon, IconButton, MenuPopover, Modal, ORDER_INFO, player, PlayingRing } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { setGlobal, useGlobal } from '../global';
import { inProfile, toggleProfileMusic, type Track } from '../music';

// Окно плейлиста — как в Telegram Web A: список треков (текущий подсвечен и прокручен к середине),
// под ним карточка «сейчас играет»: название, исполнитель, перемотка, порядок · ‹‹ ▶ ›› ; внизу — «Добавить в профиль».

const fmt = (s: number) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const close = () => setGlobal({ playlistOpen: false });

export function Playlist() {
  const open = useGlobal((s) => s.playlistOpen);
  useGlobal((s) => s.myMusic);   // кнопка «в профиль» перерисуется после правки
  const [st, setSt] = useState(() => player.playerState());
  const [order, setOrder] = useState<HTMLElement | null>(null);
  const seek = useRef<HTMLInputElement>(null), now = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => player.subscribe(setSt), []);
  useEffect(() => player.onTick((k: string, t: number, d: number) => {
    if (seek.current && document.activeElement !== seek.current) seek.current.value = String(d ? t / d : 0);
    if (now.current) now.current.textContent = fmt(t);
  }), []);
  // текущий трек — к середине списка
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector('[data-current]') as HTMLElement | null;
    el?.scrollIntoView({ block: 'center' });
  }, [open, st.key]);
  const t = st.track as Track | null;
  if (!open || !t || t.kind !== 'music') return null;
  const list = (st.playlist ?? [t]) as Track[];
  const ord = (st.order ?? 'all') as keyof typeof ORDER_INFO;
  const mine = inProfile(t);
  const canProfile = mine || t.msgId != null;
  return (
    <Modal title="Плейлист" onClose={close} size={360} class="app-pl-dialog" bodyClass="app-pl">
        {list.length > 1 ? (
          <div class="app-pl-list" ref={listRef}>
            {list.map((x) => {
              const cur = x.key === t.key;
              return (
                <button key={x.key} type="button" class={'app-pl-row' + (cur ? ' app-pl-cur' : '')} data-current={cur ? '' : undefined}
                  onClick={() => (cur ? player.toggle(x) : player.play(x))}>
                  <span class="app-pl-cover"><span class="app-sm-play"><Icon name={cur && st.playing ? 'pause' : 'play'} size={22} /></span>{cur ? <PlayingRing paused={!st.playing} /> : null}</span>
                  <span class="app-sm-text"><b class="app-sm-title">{x.title}</b><small>{fmt(x.duration)}{x.performer ? ' • ' + x.performer : ''}</small></span>
                </button>
              );
            })}
          </div>
        ) : null}
        <div class="app-pl-now">
          <div class="app-pl-meta">
            <span class="app-pl-cover"><Icon name="music" size={26} /></span>
            <span class="app-sm-text"><b class="app-pl-title">{t.title}</b><small>{t.performer || 'Музыка'}</small></span>
          </div>
          <input ref={seek} class="app-pl-seek" type="range" min={0} max={1} step={0.001} defaultValue="0" aria-label="Перемотка"
            onInput={(e) => player.seek(t.key, Number((e.currentTarget as HTMLInputElement).value))} />
          <div class="app-pl-times"><span ref={now}>{fmt(st.time)}</span><span>{fmt(st.duration || t.duration)}</span></div>
          <div class="app-pl-controls">
            <div class="app-pl-order">
              <IconButton icon={ORDER_INFO[ord].icon} label={ORDER_INFO[ord].label} onClick={(e: MouseEvent) => setOrder(order ? null : e.currentTarget as HTMLElement)} />
              <MenuPopover open={!!order} anchor={order ?? undefined} placement="top-start" label="Порядок" onClose={() => setOrder(null)} items={(['shuffle', 'all', 'one', 'off'] as const).map((k) => ({
                icon: st.order === k ? 'check' : ORDER_INFO[k].icon, label: ORDER_INFO[k].label, onClick: () => player.setOrder(k),
              }))} />
            </div>
            <IconButton icon="skipPrev" label="Предыдущий" onClick={() => player.step(-1)} />
            <button type="button" class="app-pl-play" aria-label={st.playing ? 'Пауза' : 'Играть'} onClick={() => (st.playing ? player.pause() : player.play(t))}>
              <Icon name={st.playing ? 'pause' : 'play'} size={30} />
            </button>
            <IconButton icon="skipNext" label="Следующий" onClick={() => player.step(1)} />
            <span class="app-pl-gap" />
          </div>
        </div>
        {canProfile ? (
          <button type="button" class="app-pl-profile" onClick={() => void toggleProfileMusic(t)}>
            <Icon name={mine ? 'musicRemove' : 'musicAdd'} size={22} />{mine ? 'Убрать из профиля' : 'Добавить в профиль'}
          </button>
        ) : null}
    </Modal>
  );
}
