import type { ProfileLink } from '@relay/protocol';
import { releaseMediaCache } from './storageInfo';
// Данные разделов настроек. Предзагрузка: на главной странице и при наведении на строку раздела —
// слайд приезжает уже заполненным. Подписки настроек (me, ops, user) живут здесь, а не в data.ts.

import { connectEngine, Mirror, type EngineClient } from '@relay/sync-engine/src/client';
import type { Action, Item, Patch, Query } from '@relay/sync-engine/src/types';
import { useEffect, useState } from 'preact/hooks';
import type { ChatFolder, PrivacyKey, PrivacyMode, SessionInfo } from '@relay/protocol';
import { isSessionOp, sessionsView } from '@relay/sync-engine/src/sessions';
import { reducedMotion } from '@relay/ui';
import { engineConfig } from './engineConfig';
import { getGlobal, setGlobal, type AccountSettings, type DevSimFlags, type Me } from './global';
import { dropSubscription } from './notify';

declare const __BUILD__: string;

/** Операции настроек, ещё не дошедшие до сервера. */
let opsPending = 0;
export const getPendingOps = (): number => opsPending;

const loaders = new Map<string, () => void>();

/** Раздел регистрирует свою предзагрузку (идемпотентную). */
export function registerPrefetch(path: string, load: () => void): void { loaders.set(path, load); }

export function prefetch(path: string): void {
  try { loaders.get(path)?.(); } catch { /* предзагрузка не должна ломать интерфейс */ }
}

/** Пути разделов главной страницы — предзагружаем все при открытии. */
export function prefetchAll(paths: string[]): void { for (const p of paths) prefetch(p); }

// ---------- движок ----------

// Своё соединение с тем же движком (SharedWorker/лидер один на все вкладки): data.ts свой клиент наружу не отдаёт.
// Конфиг — engineConfig.ts (обязан совпадать с data.ts, см. engineConfig.test.ts).
let engine: EngineClient | null = null;

/** Тексты отказов сервера (opFailed). */
const FAIL_TEXT: Record<string, string> = {
  username_taken: 'Это имя уже занято',
  username_reserved: 'Это имя уже занято',
  username_invalid: 'Недопустимое имя пользователя',
  bio_too_long: 'Слишком длинный текст о себе',
  name_invalid: 'Укажите имя',
  note_too_long: 'Слишком длинная заметка',
  not_found: 'Пользователь не найден в Relay',
  folder_title: 'Укажите название папки (до 16 символов)',
  folder_empty: 'Добавьте в папку хотя бы один чат или тип чатов',
  folder_too_many_chats: 'В папке может быть не больше 200 чатов',
  folder_emoji: 'Иконка папки — один эмодзи',
  folders_limit: 'Можно создать не больше 10 папок',
};
export const failText = (code: string): string => FAIL_TEXT[code] ?? 'Не удалось сохранить изменения';

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** Общий тост приложения: держится 2,5 с (или ms), новый сменяет прежний. */
export function showToast(text: string, ms = 2500): void {
  const id = ++toastSeq;
  setGlobal({ toast: { text, id } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (getGlobal().toast?.id === id) setGlobal({ toast: null }); }, ms);
}

const ME_KEY = 'relay.me';

export function startSettingsData(me: Me): void {
  engine = connectEngine({ build: __BUILD__, config: engineConfig(me), sharedUrl: '/shared.worker.js', dedicatedUrl: '/dedicated.worker.js' });
  engine.onReload(() => location.reload());   // движок другой сборки или база обновлена новой вкладкой

  // свой профиль: база сервера + ещё не подтверждённые правки — правка видна сразу, в том числе без сети
  const meM = new Mirror();
  engine.watch({ kind: 'me' }, (p) => {
    meM.apply(p);
    const it = meM.list()[0];
    if (!it) return;
    const { key: _key, ...rest } = it;
    const next = rest as unknown as Me;
    setGlobal({ me: next });
    try { localStorage.setItem(ME_KEY, JSON.stringify(next)); } catch { /* приватный режим */ }
  });

  // контакты: список для страницы «Контакты», «Информации» и модалки
  const contactsM = new Mirror();
  engine.watch({ kind: 'contacts' }, (p) => {
    contactsM.apply(p);
    setGlobal({ contacts: contactsM.list(), contactsLoaded: !!contactsM.meta('~contacts')?.loaded });
  });

  // настройки аккаунта: умолчания уведомлений (страница «Уведомления» и локальные уведомления)
  const settingsM = new Mirror();
  engine.watch({ kind: 'settings' }, (p) => {
    settingsM.apply(p);
    const it = settingsM.list()[0];
    if (it) setGlobal({ settings: { notify: it.notify, sessionsTtlDays: it.sessionsTtlDays, folders: (it.folders ?? []) as ChatFolder[], privacy: it.privacy, loaded: !!it.loaded, pending: !!it.pending } as AccountSettings });
  });

  // чёрный список: страница «Заблокированные» и плашка вместо поля ввода в личном чате
  const blockedM = new Mirror();
  engine.watch({ kind: 'blocked' }, (p) => {
    blockedM.apply(p);
    setGlobal({ blocked: blockedM.list(), blockedLoaded: !!blockedM.meta('~blocked')?.loaded });
  });

  // отказы сервера: тост на каждый новый (случившиеся до подписки — уже не новость)
  const opsM = new Mirror();
  let seen = -1;
  engine.watch({ kind: 'ops' }, (p) => {
    opsM.apply(p);
    opsPending = (opsM.list()[0]?.pending as number | undefined) ?? 0;
    const failures = (opsM.list()[0]?.failures ?? []) as { id: number; key: string; code: string }[];
    const max = failures.reduce((m, f) => Math.max(m, f.id), 0);
    if (seen >= 0) {
      // сеанс уже завершён (404) — то, чего и хотели: не ошибка
      const fresh = failures.filter((f) => f.id > seen && !(isSessionOp(f.key) && f.code === 'not_found'));
      if (fresh.length) showToast(failText(fresh[fresh.length - 1].code));
    }
    seen = Math.max(seen, max);
    // ключи очереди — для оптимистичного вида сеансов; завершение ушло на сервер — список заново
    const keys = (opsM.list()[0]?.keys ?? []) as string[];
    const prev = getGlobal().opsKeys;
    if (keys.join('\n') !== prev.join('\n')) {
      // ушедшее завершение применяем к уже загруженному списку тем же кадром — иначе строка вернулась бы до ответа
      const gone = prev.filter((k) => isSessionOp(k) && !keys.includes(k));
      const list = getGlobal().sessions;
      setGlobal({ opsKeys: keys, sessions: gone.length && list ? sessionsView(list, gone) : list });
      if (gone.length) void loadSessions(true);
    }
  });

  // сеанс завершён (с другого устройства или автозавершением): движок уже стёр данные — уходим на вход
  const statusM = new Mirror();
  engine.watch({ kind: 'status' }, (p) => {
    statusM.apply(p);
    const st = statusM.list()[0];
    // флаги имитатора сети (раздел «Для разработчиков»): плашка во всех вкладках; ссылка не меняется, пока флаги те же
    const sim = (st?.devSim ?? null) as DevSimFlags | null;
    if (JSON.stringify(sim) !== JSON.stringify(getGlobal().devSim)) setGlobal({ devSim: sim });
    if (st?.terminated) onTerminated(st.terminatedReason === 'logout' ? 'logout' : 'terminated');
  });
}

// ---------- активные сеансы ----------

let sessionsGen = 0;
let sessionsAt = 0;
/** Список сеансов с сервера (через движок: без сети — {offline}). Предзагрузка главной страницы и страницы «Активные сеансы».
 *  Применяется только ответ на последний запрос: более ранний мог быть снят до завершения сеанса. force — мимо паузы в 1 с. */
export function loadSessions(force = false): Promise<void> {
  if (!engine || (!force && Date.now() - sessionsAt < 1000)) return Promise.resolve();
  sessionsAt = Date.now();
  const gen = ++sessionsGen;
  return call<{ sessions: SessionInfo[] } | { offline: true }>({ type: 'listSessions' })
    .then((r) => {
      if (gen !== sessionsGen) return;
      if ('sessions' in r) setGlobal({ sessions: r.sessions, sessionsOffline: false }); else setGlobal({ sessionsOffline: true });
    })
    .catch(() => { if (gen === sessionsGen) setGlobal({ sessionsOffline: true }); });
}
export const terminateSession = (id: number): Promise<unknown> => call({ type: 'terminateSession', id });
export const terminateOtherSessions = (): Promise<unknown> => call({ type: 'terminateOtherSessions' });
export const setSessionsTtl = (days: number): Promise<unknown> => call({ type: 'setSessionsTtl', days });

/** Эта вкладка сама выходит (POST /logout): своё же sessionTerminated — не «завершён на другом устройстве». */
let selfLogout = false;
export function markSelfLogout(on: boolean): void { selfLogout = on; }

let terminating = false;
function onTerminated(reason: 'logout' | 'terminated'): void {
  if (terminating || selfLogout) return;
  terminating = true;
  // сервер удалил подписку вместе с сеансом; отписываем и браузер (best effort, не ждём)
  void dropSubscription().catch(() => {});
  try { localStorage.removeItem(ME_KEY); localStorage.removeItem('relay.names'); } catch { /* приватный режим */ }
  void releaseMediaCache();
  // IndexedDB стирает движок (он же её и держит); здесь — плавный уход на экран входа и тост
  const root = document.getElementById('app');
  const ms = reducedMotion() ? 0 : 220;
  const fade = root?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-in', fill: 'forwards' });
  setTimeout(() => {
    setGlobal({ boot: 'login', sessions: null, opsKeys: [], openChatId: null, infoOpen: false });
    fade?.cancel();
    root?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'ease-out' });
    // logout — выход в другой вкладке этого же браузера; иначе сеанс завершили с другого устройства (или автозавершением)
    showToast(reason === 'logout' ? 'Вы вышли из Relay' : 'Сеанс завершён на другом устройстве', 4000);
  }, ms);
}

const call = <T>(a: Action): Promise<T> => (engine ? engine.call<T>(a) : Promise.reject(new Error('engine not started')));

export interface ProfilePatch { firstName?: string; lastName?: string; bio?: string | null; birthday?: { day: number; month: number; year?: number } | null }
export const updateProfile = (patch: ProfilePatch): Promise<unknown> => call({ type: 'updateProfile', ...patch });
export const setLinks = (links: ProfileLink[]): Promise<unknown> => call({ type: 'setLinks', links });
export const setUsername = (username: string | null): Promise<unknown> => call({ type: 'setUsername', username });
export type UsernameCheck = { ok: true } | { ok: false; reason: 'invalid' | 'taken' | 'reserved' } | { offline: true };
export const checkUsername = (username: string): Promise<UsernameCheck> =>
  call<UsernameCheck>({ type: 'checkUsername', username }).catch(() => ({ offline: true as const }));

export const saveFolder = (folder: ChatFolder): Promise<unknown> => call({ type: 'saveFolder', folder });
export const deleteFolder = (id: number): Promise<unknown> => call({ type: 'deleteFolder', id });
export const reorderFolders = (ids: number[]): Promise<unknown> => call({ type: 'reorderFolders', ids });

export const refreshSettings = (): Promise<unknown> => call({ type: 'refreshSettings' }).catch(() => null);
export const setNotifyDefault = (notifyType: 'direct' | 'group', patch: { muted?: boolean; preview?: boolean }): Promise<unknown> =>
  call({ type: 'setNotify', notifyType, ...patch });

export const setPrivacy = (key: PrivacyKey, rule: { mode: PrivacyMode; allow?: number[]; deny?: number[] }): Promise<unknown> =>
  call({ type: 'setPrivacy', key, ...rule });
export const blockUser = (userId: number): Promise<unknown> => call({ type: 'block', userId });
export const unblockUser = (userId: number): Promise<unknown> => call({ type: 'unblock', userId });

export interface ContactPatch { firstName?: string; lastName?: string; note?: string }
export const addContact = (userId: number, firstName: string, lastName = ''): Promise<unknown> => call({ type: 'addContact', userId, firstName, lastName });
export const updateContact = (userId: number, patch: ContactPatch): Promise<unknown> => call({ type: 'updateContact', userId, ...patch });
export const removeContact = (userId: number): Promise<unknown> => call({ type: 'removeContact', userId });
export type ResolveResult = { user: Item & { id: number; name: string } } | { notFound: true } | { offline: true };
export const resolveUser = (query: string): Promise<ResolveResult> =>
  call<ResolveResult>({ type: 'resolveUser', query }).catch(() => ({ offline: true as const }));

// последний известный профиль по id в этой вкладке: повторное открытие «Информации» — без ожидания движка
const userCache = new Map<number, Item>();

/** Профиль человека (PublicUser) — подписка движка, пока компонент смонтирован; движок заодно перезапрашивает его с сервера. */
export function useUser(userId: number | null | undefined): Item | null {
  const [user, setUser] = useState<Item | null>(() => (userId ? userCache.get(userId) ?? null : null));
  useEffect(() => {
    setUser(userId ? userCache.get(userId) ?? null : null);
    if (!userId || !engine) return;
    const m = new Mirror();
    const w = engine.watch({ kind: 'user', userId }, (p: Patch) => {
      m.apply(p);
      const u = m.list()[0] ?? null;
      if (u) userCache.set(userId, u); else userCache.delete(userId);
      setUser(u);
    });
    return () => w.close();
  }, [userId]);
  return user;
}

/** Очистка локальных данных: движок стирает кэш и берёт снимок заново; keepOutbox — не трогать неотправленное. */
export const resetLocal = (keepOutbox: boolean): Promise<unknown> => call({ type: 'resetLocal', keepOutbox });

// ---------- раздел «Для разработчиков» ----------

/** Подписка раздела (devStats, devLog): живёт, только пока открыт раздел. */
export function watchDev(q: Query, cb: (p: Patch) => void): { update(q: Query): void; close(): void } {
  if (!engine) return { update() {}, close() {} };
  return engine.watch(q, cb);
}
export const devCall = <T = unknown>(cmd: string, args?: unknown): Promise<T> => call<T>({ type: 'dev', cmd, args } as Action);
