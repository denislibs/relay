import type { NotifyState } from './notify';
import { options } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { requestMutation } from '@relay/ui';
import { loadTheme, type ThemePref } from './theme';
import { getPrefs, subscribePrefs, listenStorage, applyPrefs, type Prefs } from './prefs';
import type { Item } from '@relay/sync-engine/src/types';
import { defaultPrivacy, type PrivacyRules, type SessionInfo } from '@relay/protocol';

/** Края окна ленты: есть ли сообщения раньше/позже, окно ли это живого хвоста. */
export interface FeedMeta { hasOlder: boolean; hasNewer: boolean; live: boolean }

/** Свой профиль (GET /me, дальше — подписка me движка). Поля опциональны: старый кэш relay.me их не знает. */
export interface Me { userId: number; name: string; firstName?: string; lastName?: string; username?: string | null; bio?: string | null; birthday?: { day: number; month: number; year?: number } | null; phone?: string | null }
export type Phase = 'connecting' | 'offline' | 'loading' | 'updating' | 'ready';
export interface Status { phase: Phase; hydrated: boolean; chatsComplete?: boolean; chatsCursorAt?: number; online: boolean; synced: boolean; syncing: boolean; outbox: number; failed: number; terminated?: boolean }   // terminated — сеанс завершён (B9)

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
  feedMeta: FeedMeta | null;
  unreadFrom: number | null;
  focus: { id: number; sort: number; nonce: number; replaced: boolean } | null;   // перейти к сообщению и подсветить   // lastReadId на момент открытия: разделитель «Непрочитанные» (заморожен)
  folder: 'all' | 'unread';
  search: string;
  newChatOpen: boolean;
  sidebarView: string;   // путь страницы боковой панели, см. nav.ts
  infoOpen: boolean;   // правая панель «Информация»
  muted: number[];     // чаты с выключенными уведомлениями (на этом устройстве)
  theme: ThemePref;   // зеркало prefs.theme для прежних читателей
  prefs: Prefs;       // настройки устройства, см. prefs.ts
  notify: NotifyState;   // уведомления на этом устройстве
  pushReady: boolean;    // подписка Web Push принята сервером: уведомит и без открытой вкладки
  toast: { text: string; id: number } | null;   // общий тост приложения (ошибки сохранения настроек и т. п.)
  contacts: Item[];          // подписка contacts движка (с неподтверждёнными правками)
  contactsLoaded: boolean;   // список с сервера уже был (иначе пусто — значит «грузим»)
  settings: AccountSettings;   // настройки аккаунта (подписка settings движка): умолчания уведомлений
  newContact: NewContactDraft | null;   // открытая модалка «Новый контакт» и чем её заполнить
  blocked: Item[];          // подписка blocked движка: чёрный список (с неподтверждёнными правками)
  blockedLoaded: boolean;   // список с сервера уже был
  sessions: SessionInfo[] | null;   // активные сеансы с сервера (null — ещё не знаем); вид — sessionsView(sessions, opsKeys)
  sessionsOffline: boolean;         // последний запрос списка не дошёл (нет сети)
  opsKeys: string[];                // ключи операций настроек в очереди: оптимистичный вид сеансов
}

/** Настройки аккаунта (общие для устройств). loaded — снимок с сервера уже был; pending — есть неподтверждённые правки. */
export interface AccountSettings { notify: Record<'direct' | 'group', { muted: boolean; preview: boolean }>; sessionsTtlDays: number; privacy: PrivacyRules; loaded: boolean; pending: boolean }
export const defaultAccountSettings = (): AccountSettings => ({ notify: { direct: { muted: false, preview: true }, group: { muted: false, preview: true } }, sessionsTtlDays: 180, privacy: defaultPrivacy(), loaded: false, pending: false });

/** Чем заполнить «Новый контакт»: из «Информации» — человек уже известен (userId), запрос лишь для вида. */
export interface NewContactDraft { query?: string; firstName?: string; lastName?: string; userId?: number }

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
  feedMeta: null,
  unreadFrom: null,
  focus: null,
  folder: 'all',
  search: '',
  newChatOpen: false,
  sidebarView: 'chats',
  infoOpen: false,
  muted: (() => { try { return JSON.parse(localStorage.getItem('relay.muted') ?? '[]'); } catch { return []; } })(),
  theme: loadTheme(),
  prefs: getPrefs(),
  notify: 'unsupported',
  pushReady: false,
  toast: null,
  contacts: [],
  contactsLoaded: false,
  settings: defaultAccountSettings(),
  newContact: null,
  blocked: [],
  blockedLoaded: false,
  sessions: null,
  sessionsOffline: false,
  opsKeys: [],
};
const subscribers = new Set<() => void>();

// Рендер Preact — в фазе записи кадра: замеры уже сделаны, layout не дёргается.
options.debounceRendering = (cb) => requestMutation(cb);

// prefs → GlobalState (в том числе из других вкладок)
subscribePrefs((prefs) => setGlobal({ prefs, theme: prefs.theme }));
listenStorage();
applyPrefs();

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
