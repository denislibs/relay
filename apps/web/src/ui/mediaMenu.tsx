import { downloadUrl, IconButton, MenuPopover, Presence } from '@relay/ui';
import type { GroupInfo } from '@relay/protocol';
import type { ComponentChildren } from 'preact';
import { createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { startForward, startForwardMany } from '../forward';
import { findChat, getGlobal } from '../global';
import { groupByChat, LONG_PRESS_MS, mediaKey, messagesLabel, movedTooFar, toggleKey } from '../mediaSelect';
import type { Msg } from './SharedMedia';

// Меню плитки «Медиа» и режим выбора — как в Telegram Web K: правый клик (палец — долгое нажатие) открывает
// «Переслать · Скачать · Показать в чате · Выбрать»; «Выбрать» включает режим выбора: кружки на плитках, нажатие
// отмечает, вместо вкладок — пилюля «✕ N сообщений ⟶». Общее для правой панели (SharedMedia) и глобального поиска.
// Обработчики — одни на сетку (MediaGrid, data-mkey у плитки), а не на каждую плитку.

export interface MediaPick {
  /** Выбранные плитки по ключу mediaKey, в порядке выбора; пусто — режима выбора нет. */
  picked: Map<string, Msg>;
  toggle(m: Msg): void;
  clear(): void;
}

interface Ctl extends MediaPick {
  keyOf(m: Msg): string;
  menu(m: Msg, x: number, y: number): void;
}
const MediaCtl = createContext<Ctl | null>(null);
export const useMediaCtl = () => useContext(MediaCtl);

/** Выбор плиток; reset — другой чат, запрос или вкладка: выбор сбрасывается (как в Telegram). */
export function useMediaPick(chatId: number | null, reset: unknown): MediaPick {
  const [picked, setPicked] = useState<Map<string, Msg>>(() => new Map());
  useEffect(() => { setPicked((p) => (p.size ? new Map() : p)); }, [reset]);
  const keyOf = (m: Msg) => mediaKey((m.chatId as number | undefined) ?? chatId ?? 0, m.id);
  return {
    picked,
    toggle: (m) => setPicked((p) => {
      const k = keyOf(m), keys = toggleKey([...p.keys()], k);
      return new Map(keys.map((x) => [x, x === k ? m : p.get(x)!]));
    }),
    clear: () => setPicked((p) => (p.size ? new Map() : p)),
  };
}

const nameOf = (id: number) => { const g = getGlobal(); return id === g.me?.userId ? g.me.name : g.people[id]?.name ?? ''; };
/** Защищённый чат (запрет копирования): без пересылки, скачивания и выбора — как в меню сообщения в ленте. */
const isProtected = (chatId: number) => !!(findChat(getGlobal(), chatId)?.group as GroupInfo | null | undefined)?.protected;

/** Меню и Esc режима выбора для сетки внутри; show — «Показать в чате» (правая панель — к сообщению в открытом
 *  чате, поиск — чат из левой колонки, docs/navigation-rules.md). */
export function MediaActions({ chatId, pick, show, children }: { chatId: number | null; pick: MediaPick; show: (m: Msg) => void; children: ComponentChildren }) {
  const [menu, setMenu] = useState<{ m: Msg; x: number; y: number } | null>(null);
  const on = pick.picked.size > 0;
  // Esc в режиме выбора снимает выбор, а не закрывает панель или поиск: перехват раньше их обработчиков на window
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.rl-viewer, .rl-pop[data-esc-layer]')) return;
      e.preventDefault(); e.stopPropagation(); pick.clear();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [on]);
  const chatOf = (m: Msg) => (m.chatId as number | undefined) ?? chatId ?? 0;
  const ctl: Ctl = { ...pick, keyOf: (m) => mediaKey(chatOf(m), m.id), menu: (m, x, y) => setMenu({ m, x, y }) };
  const m = menu?.m, a = m?.attachment, locked = m ? isProtected(chatOf(m)) : true;
  return (
    <MediaCtl.Provider value={ctl}>
      {children}
      <MenuPopover open={!!menu} anchor={menu ? { x: menu.x, y: menu.y } : undefined} label="Действия с медиа" onClose={() => setMenu(null)}
        items={!m ? [] : [
          ...(!locked ? [{ icon: 'forward', label: 'Переслать', onClick: () => startForward(chatOf(m), [m], nameOf) }] : []),
          ...(!locked && a ? [{ icon: 'download', label: 'Скачать', onClick: () => downloadUrl(`/files/${a.id}?download=1`, a.name) }] : []),
          { icon: 'chats', label: 'Показать в чате', onClick: () => show(m) },
          ...(!locked ? [{ icon: 'checkCircle', label: 'Выбрать', onClick: () => { if (!pick.picked.has(ctl.keyOf(m))) pick.toggle(m); } }] : []),
        ]} />
    </MediaCtl.Provider>
  );
}

/** Место вкладок: в режиме выбора вкладки гаснут (и не ловят нажатий), поверх проявляется пилюля выбора. */
export function MediaTabsSlot({ pick, children }: { pick: MediaPick; children: ComponentChildren }) {
  const on = pick.picked.size > 0;
  // пилюля уходит со своим последним числом, а не с «0 сообщений»
  const count = useRef(0);
  if (on) count.current = pick.picked.size;
  const forward = () => {
    const groups = groupByChat([...pick.picked.keys()], (k) => pick.picked.get(k));
    pick.clear();
    startForwardMany(groups, nameOf);
  };
  return (
    <div class={'app-mtabs' + (on ? ' is-selecting' : '')}>
      <div class="app-mtabs-tabs" inert={on}>{children}</div>
      <Presence show={on} exitMs={200}>
        <div class="app-msel" role="toolbar" aria-label="Выбранные медиа">
          <IconButton icon="close" label="Отменить выбор" onClick={pick.clear} />
          <span class="app-msel-count" aria-live="polite">{messagesLabel(count.current)}</span>
          <IconButton icon="forward" label="Переслать" onClick={forward} />
        </div>
      </Presence>
    </div>
  );
}

/** Обработчики сетки: правый клик — меню; палец, задержанный на плитке, — меню (в режиме выбора — отметка);
 *  в режиме выбора нажатие отмечает, а не открывает. find — сообщение плитки по data-mkey. */
export function useGridPress(find: (key: string) => Msg | undefined) {
  const ctl = useMediaCtl();
  const st = useRef<{ timer: number; x: number; y: number; firedAt: number }>({ timer: 0, x: 0, y: 0, firedAt: 0 });
  if (!ctl) return {};
  const cellOf = (e: Event) => {
    const key = (e.target as Element).closest<HTMLElement>('[data-mkey]')?.dataset.mkey;
    return key ? find(key) : undefined;
  };
  const cancel = () => { if (st.current.timer) { clearTimeout(st.current.timer); st.current.timer = 0; } };
  // долгое нажатие и следующий за ним click (и contextmenu Android) — одно действие
  const justFired = () => performance.now() - st.current.firedAt < 800;
  return {
    onPointerDown: (e: PointerEvent) => {
      cancel();
      if (e.pointerType !== 'touch') return;
      const m = cellOf(e);
      if (!m) return;
      const s = st.current, x = e.clientX, y = e.clientY;
      s.x = x; s.y = y;
      s.timer = window.setTimeout(() => {
        s.timer = 0; s.firedAt = performance.now();
        if (ctl.picked.size) ctl.toggle(m); else ctl.menu(m, x, y);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => { if (st.current.timer && movedTooFar(st.current.x, st.current.y, e.clientX, e.clientY)) cancel(); },
    onPointerUp: cancel,
    onPointerCancel: cancel,   // браузер забрал жест под прокрутку
    onContextMenu: (e: MouseEvent) => {
      const m = cellOf(e);
      if (!m) return;
      e.preventDefault();
      if (justFired()) return;
      ctl.menu(m, e.clientX, e.clientY);
    },
    onClickCapture: (e: MouseEvent) => {
      if (justFired()) { e.preventDefault(); e.stopPropagation(); return; }
      if (!ctl.picked.size) return;
      const m = cellOf(e);
      if (!m) return;
      e.preventDefault(); e.stopPropagation();
      ctl.toggle(m);
    },
  };
}
