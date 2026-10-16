import { options } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { requestMutation } from '@relay/ui';
import { loadTheme, type ThemePref } from './theme';
import type { Item } from '@relay/sync-engine/src/types';

export interface Me { userId: number; name: string }
export type Phase = 'connecting' | 'offline' | 'loading' | 'updating' | 'ready';
export interface Status { phase: Phase; hydrated: boolean; online: boolean; synced: boolean; syncing: boolean; outbox: number; failed: number }

/** Один объект: зеркало видимых данных из воркера + состояние интерфейса этой вкладки. */
export interface GlobalState {
  boot: 'loading' | 'login' | 'app';
  me: Me | null;
  chats: Item[];
  chatsLoaded: boolean;   // первый снимок списка из воркера уже пришёл
  counters: { unreadChats: number; unreadMessages: number };
  status: Status;
  syncLabel: string | null;   // стадия для поля поиска; каждая держится не меньше 600 мс
  openChatId: number | null;
  pendingChatId: number | null;
  peer: Item | null;   // присутствие собеседника открытого личного чата {userId, known, online, lastSeen}   // выбран, но лента ещё не готова: на экране прежний чат, строка уже подсвечена
  messages: Item[];
  folder: 'all' | 'unread';
  search: string;
  newChatOpen: boolean;
  sidebarView: 'chats' | 'settings';
  theme: ThemePref;
}

let state: GlobalState = {
  boot: 'loading',
  me: null,
  chats: [],
  chatsLoaded: false,
  counters: { unreadChats: 0, unreadMessages: 0 },
  status: { phase: 'connecting', hydrated: false, online: false, synced: false, syncing: false, outbox: 0, failed: 0 },
  syncLabel: null,
  openChatId: null,
  pendingChatId: null,
  peer: null,
  messages: [],
  folder: 'all',
  search: '',
  newChatOpen: false,
  sidebarView: 'chats',
  theme: loadTheme(),
};
const subscribers = new Set<() => void>();

// Рендер Preact — в фазе записи кадра: замеры уже сделаны, layout не дёргается.
options.debounceRendering = (cb) => requestMutation(cb);

export const getGlobal = (): GlobalState => state;

export function setGlobal(patch: Partial<GlobalState> | ((s: GlobalState) => Partial<GlobalState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const fn of subscribers) fn(); // подписчики лишь помечают компонент; рендер один на кадр
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Срез состояния; компонент перерисуется, только если срез изменился. */
export function useGlobal<T>(select: (s: GlobalState) => T): T {
  const [, force] = useState(0);
  const sel = useRef(select);
  sel.current = select;
  const value = select(state);
  const last = useRef(value);
  last.current = value;
  useEffect(() => {
    const check = () => { if (!shallowEqual(sel.current(state), last.current)) force((x) => x + 1); };
    subscribers.add(check);
    check(); // эффект срабатывает после отрисовки — состояние могло смениться раньше подписки
    return () => { subscribers.delete(check); };
  }, []);
  return value;
}
