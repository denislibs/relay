import type { ProfileLink, ProfilePhoto, ThreadGuest } from '@relay/protocol';
import type { NotifyState } from './notify';
import { options } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { requestMutation } from '@relay/ui';
import { loadTheme, type ThemePref } from './theme';
import { getPrefs, subscribePrefs, listenStorage, applyPrefs, type Prefs } from './prefs';
import type { Item } from '@relay/sync-engine/src/types';
import { defaultPrivacy, type ChatFolder, type PrivacyRules, type SessionInfo } from '@relay/protocol';

/** Края окна ленты: есть ли сообщения раньше/позже, окно ли это живого хвоста. */
/** filling — окно у живого края не набрано: история не дошла до начала, сообщений меньше лимита (движок, queries.ts). */
export interface FeedMeta { hasOlder: boolean; hasNewer: boolean; live: boolean; filling?: boolean }

export type Focus = { id: number; sort: number; nonce: number; replaced: boolean };

/**
 * Чат в стеке (как Chat в стеке Telegram Web): у каждого своя лента и своя колонка в DOM.
 * Нижний — открытый из списка; выше — открытые изнутри чата. Пока ready=false, колонка уже
 * в DOM (лента раскладывается и встаёт на позицию), но на экране — предыдущий чат.
 */
export interface ChatFrame {
  key: string;
  chatId: number;
  threadId?: number;          // тред комментариев в группе обсуждения: id копии поста (лента — Query thread)
  // тред: ключ шапки (копии поста) в messages; загружен ли с сервера; guest — я не участник группы (комментирую как подписчик канала)
  thread?: { header: string | null; loaded: boolean; guest?: ThreadGuest | null };
  ready: boolean;
  instant?: boolean;          // встал на место без анимации (смена нижнего чата)
  swap?: boolean;             // нижний чат подменяется: собран скрытым, появляется без перехода (один раз)
  messages: Item[];
  feedMeta: FeedMeta | null;
  unreadFrom: number | null;  // lastReadId на момент открытия: разделитель «Непрочитанные» (заморожен)
  focus: Focus | null;        // перейти к сообщению и подсветить
  joinedAfter?: number;       // подписался на канал из превью, пока лента открыта: после этого id — «Вы подписались на канал»
}

/** Свой профиль (GET /me, дальше — подписка me движка). Поля опциональны: старый кэш relay.me их не знает. */
export interface Me { userId: number; name: string; firstName?: string; lastName?: string; username?: string | null; bio?: string | null; birthday?: { day: number; month: number; year?: number } | null; phone?: string | null; links?: ProfileLink[]; photo?: ProfilePhoto | null }
export type Phase = 'connecting' | 'offline' | 'loading' | 'updating' | 'ready';
export interface Status { phase: Phase; hydrated: boolean; chatsComplete?: boolean; chatsCursorAt?: number; chatsTotal?: number; online: boolean; synced: boolean; syncing: boolean; outbox: number; failed: number; sessionsRev?: number; terminated?: boolean; terminatedReason?: 'logout' | 'terminated' }   // terminated — сеанс завершён (B9)

/** Один объект: зеркало видимых данных из воркера + состояние интерфейса этой вкладки. */
export interface GlobalState {
  boot: 'loading' | 'login' | 'app';
  enter: 'login' | 'reload' | null;   // как появилось приложение: после входа (колонка выезжает) или при запуске (проявление)
  me: Me | null;
  chats: Item[];
  /** превью публичных каналов без подписки (подписка previews движка): как строки списка, preview: true; в списке их нет */
  previews: Item[];
  chatsLoaded: boolean;   // первый снимок списка из воркера уже пришёл
  installable: boolean;   // браузер разрешил установку как приложения (pwa.ts)
  counters: { unreadChats: number; unreadMessages: number };
  status: Status;
  syncLabel: string | null;   // стадия для поля поиска; каждая держится не меньше 600 мс
  openChatId: number | null;     // чат на экране (верхний готовый в стеке)
  openThreadId: number | null;   // тред на экране (верхний кадр — тред этого чата), иначе null
  pendingChatId: number | null;  // выбран, но лента ещё не готова: на экране прежний чат, строка уже подсвечена
  peer: Item | null;   // присутствие собеседника открытого личного чата {userId, known, online, lastSeen}
  chatStack: ChatFrame[];        // стек чатов, снизу вверх
  chatLeaving: ChatFrame[];      // снятые со стека: доигрывают уход и ждут скрытыми до минуты (повторное открытие — без подготовки)
  folder: number;      // активная папка: 0 — «Все чаты», иначе id своей папки
  folderDraft: FolderDraft | null;   // редактор папки: общий для страницы правки и выбора чатов
  search: string;
  searchOpen: boolean;   // левая колонка в режиме глобального поиска (вкладки, недавние)
  searchTab: string;     // вкладка поиска: chats | media | link | file | audio | voice
  newChatOpen: boolean;
  sidebarView: string;   // путь страницы боковой панели, см. nav.ts
  infoOpen: boolean;   // правая панель «Информация»
  listLeaving: boolean;   // телефон: чат закрыли — экран уже едет к списку, лента снимется после перехода (data.ts)
  pollResults: { chatId: number; id: number } | null;   // окно «Результаты» неанонимного опроса
  muteTick: number;    // истёк срок «Отключить звук» какого-то чата (mute.ts): повод перерисовать
  theme: ThemePref;   // зеркало prefs.theme для прежних читателей
  prefs: Prefs;       // настройки устройства, см. prefs.ts
  updateReady: boolean;   // на сервере новая сборка — предлагаем обновиться (update.ts)
  playlistOpen: boolean;  // окно плейлиста музыки (music.ts)
  fwdPick: ForwardPick | null;               // открыто окно «Переслать в…» (forward.ts)
  fwdDraft: Record<number, ForwardDraft>;    // пересылка, ждущая в поле ввода чата (панель над полем)
  selecting: { chatId: number; keys: string[] } | null;   // режим выбора сообщений в ленте (ключи по порядку отметки)
  notify: NotifyState;   // уведомления на этом устройстве
  pushReady: boolean;    // подписка Web Push принята сервером: уведомит и без открытой вкладки
  toast: { text: string; id: number } | null;   // общий тост приложения (ошибки сохранения настроек и т. п.)
  contacts: Item[];          // подписка contacts движка (с неподтверждёнными правками)
  contactsLoaded: boolean;   // список с сервера уже был (иначе пусто — значит «грузим»)
  settings: AccountSettings;   // настройки аккаунта (подписка settings движка): умолчания уведомлений
  newContact: NewContactDraft | null;
  joinLink: string | null;
  infoGo: string | null;     // открыть правую панель сразу на экране управления группой (например, заявки)   // открытая ссылка-приглашение: '+токен' или '@имя'
  newGroup: { ids: number[]; title: string; edited: boolean } | null;   // черновик «Новой группы»: участники и название (живёт между шагами)   // открытая модалка «Новый контакт» и чем её заполнить
  newChannel: { title: string; about: string; chatId: number | null } | null;   // черновик «Нового канала»; chatId — уже создан (шаг подписчиков)
  blocked: Item[];          // подписка blocked движка: чёрный список (с неподтверждёнными правками)
  blockedLoaded: boolean;   // список с сервера уже был
  sessions: SessionInfo[] | null;   // активные сеансы с сервера (null — ещё не знаем); вид — sessionsView(sessions, opsKeys)
  /** этот сеанс из прошлой загрузки списка (localStorage): кнопки «Нового входа» решаются на первом кадре, а не после запроса */
  thisSession: ThisSession | null;
  sessionsOffline: boolean;         // последний запрос списка не дошёл (нет сети)
  opsKeys: string[];                // ключи операций настроек в очереди: оптимистичный вид сеансов
  people: Record<number, Person>;   // люди по id (подписка people движка, см. people.ts); нет ключа — ещё не знаем
  devSim: DevSimFlags | null;      // имитатор сети движка включён (status.devSim): плашка «Режим разработчика»
  devTab: DevTab;                  // вкладка раздела «Для разработчиков»
  uploads: UploadItem[];           // неотправленные файлы во всех чатах (подписка uploads движка): индикатор «Отправка N файлов»
  preparing: UploadItem[];         // видео, которые эта вкладка сжимает перед отправкой (ещё не в очереди движка)
}

/** Человек из подписки people: имя — как его видит зритель (контакт — своим именем). */
export type Person = Item & { id: number; name: string; photo: ProfilePhoto | null };

/** Файл в очереди отправки: progress 0…1; uploaded — загружен и ждёт отправки (соседа по альбому); compressing — ещё сжимается (progress — сжатия). */
export interface UploadItem { key: string; chatId: number; name: string; size: number; kind: string; mime: string; uploaded: boolean; progress: number; compressing?: boolean }

export type DevTab = 'overview' | 'perf' | 'log' | 'network' | 'data' | 'errors';
export interface DevSimFlags { offline: boolean; profile: { latency: number; jitter: number; lossPct: number; kbps: number } | null; dropNextUpdates: boolean; forceTooLong: boolean; persist: boolean }

/** Настройки аккаунта (общие для устройств). loaded — снимок с сервера уже был; pending — есть неподтверждённые правки. */
/** Что пересылаем: сообщения fromChatId по порядку; more — ещё из других чатов (выбор в глобальном поиске), каждый чат своим вызовом. */
export interface ForwardPick { fromChatId: number; ids: number[]; more?: { fromChatId: number; ids: number[] }[]; preview: ForwardPreview }
/** Для панели в поле ввода: авторы, текст первого, сколько и есть ли подписи у медиа. */
export interface ForwardPreview { senders: { id: number; name: string }[]; text: string; count: number; captions: boolean }
/** Пересылка в поле ввода: с опциями «скрыть отправителя / подписи». */
export interface ForwardDraft extends ForwardPick { hideSender: boolean; hideCaption: boolean }
export type ThisSession = { id: number; limited: boolean; unconfirmed: boolean };
export const THIS_SESSION_KEY = 'relay.thisSession';
function loadThisSession(): ThisSession | null {
  try { const v = JSON.parse(localStorage.getItem(THIS_SESSION_KEY) ?? 'null'); return v && typeof v.id === 'number' ? v as ThisSession : null; } catch { return null; }
}

export interface AccountSettings { notify: Record<'direct' | 'group', { muted: boolean; preview: boolean }>; sessionsTtlDays: number; folders: ChatFolder[]; privacy: PrivacyRules; loaded: boolean; pending: boolean }
export const defaultAccountSettings = (): AccountSettings => ({ notify: { direct: { muted: false, preview: true }, group: { muted: false, preview: true } }, sessionsTtlDays: 180, folders: [], privacy: defaultPrivacy(), loaded: false, pending: false });

/** Черновик папки: id (новая — ещё не на сервере), правки и исходное значение для «есть ли изменения». */
export interface FolderDraft { id: number; isNew: boolean; folder: ChatFolder; original: ChatFolder }

/** Чем заполнить «Новый контакт»: из «Информации» — человек уже известен (userId), запрос лишь для вида. */
export interface NewContactDraft { query?: string; firstName?: string; lastName?: string; userId?: number }

let state: GlobalState = {
  boot: 'loading',
  enter: null,
  me: null,
  chats: [],
  previews: [],
  chatsLoaded: false,
  installable: false,
  counters: { unreadChats: 0, unreadMessages: 0 },
  uploads: [],
  preparing: [],
  status: { phase: 'connecting', hydrated: false, online: false, synced: false, syncing: false, outbox: 0, failed: 0 },
  syncLabel: null,
  openChatId: null,
  openThreadId: null,
  pendingChatId: null,
  peer: null,
  chatStack: [],
  chatLeaving: [],
  folder: 0,
  folderDraft: null,
  search: '',
  searchOpen: false,
  searchTab: 'chats',
  newChatOpen: false,
  sidebarView: 'chats',
  infoOpen: false,
  listLeaving: false,
  muteTick: 0,
  theme: loadTheme(),
  prefs: getPrefs(),
  updateReady: false,
  playlistOpen: false,
  fwdPick: null,
  fwdDraft: {},
  selecting: null,
  notify: 'unsupported',
  pushReady: false,
  toast: null,
  contacts: [],
  contactsLoaded: false,
  settings: defaultAccountSettings(),
  newContact: null,
  joinLink: null,
  infoGo: null,
  pollResults: null,
  newGroup: null,
  newChannel: null,
  blocked: [],
  blockedLoaded: false,
  sessions: null,
  thisSession: loadThisSession(),
  sessionsOffline: false,
  opsKeys: [],
  people: {},
  devSim: null,
  devTab: 'overview',
};
const subscribers = new Set<() => void>();

// Рендер Preact — в фазе записи кадра: замеры уже сделаны, layout не дёргается.
options.debounceRendering = (cb) => requestMutation(cb);

// prefs → GlobalState (в том числе из других вкладок)
subscribePrefs((prefs) => setGlobal({ prefs, theme: prefs.theme }));
listenStorage();
applyPrefs();

export const getGlobal = (): GlobalState => state;

/** Подписка вне компонентов (заголовок вкладки): вызывается на каждый setGlobal. */
export function subscribeGlobal(fn: () => void): () => void { subscribers.add(fn); return () => { subscribers.delete(fn); }; }

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

/** Чат по id: строка списка, а нет её — превью канала без подписки (шапка, лента, «Информация» читают отсюда). */
export function findChat(s: GlobalState, id: number | null | undefined): Item | undefined {
  if (id == null) return undefined;
  return s.chats.find((c) => c.id === id) ?? s.previews.find((c) => c.id === id);
}

/** Чат на экране: верхний готовый кадр стека. */
export function activeFrame(s: GlobalState): ChatFrame | undefined {
  for (let i = s.chatStack.length - 1; i >= 0; i--) if (s.chatStack[i].ready) return s.chatStack[i];
  return undefined;
}
export const frameByKey = (s: GlobalState, key: string): ChatFrame | undefined =>
  s.chatStack.find((f) => f.key === key) ?? s.chatLeaving.find((f) => f.key === key);

/** Телефон: колонки — экраны друг над другом (список → чат → «Информация»), как в Telegram; порог — как в relay.css. */
export const PHONE_QUERY = '(max-width: 720px)';
export const isPhone = (): boolean => typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches;
