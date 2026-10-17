// Данные разделов настроек. Предзагрузка: на главной странице и при наведении на строку раздела —
// слайд приезжает уже заполненным. Подписки настроек (me, ops, user) живут здесь, а не в data.ts.

import { connectEngine, Mirror, type EngineClient } from '@relay/sync-engine/src/client';
import type { Action, Item, Patch } from '@relay/sync-engine/src/types';
import { useEffect, useState } from 'preact/hooks';
import { engineConfig } from './engineConfig';
import { getGlobal, setGlobal, type AccountSettings, type Me } from './global';

declare const __BUILD__: string;

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
};
export const failText = (code: string): string => FAIL_TEXT[code] ?? 'Не удалось сохранить изменения';

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** Общий тост приложения: держится 2,5 с, новый сменяет прежний. */
export function showToast(text: string): void {
  const id = ++toastSeq;
  setGlobal({ toast: { text, id } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (getGlobal().toast?.id === id) setGlobal({ toast: null }); }, 2500);
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
    if (it) setGlobal({ settings: { notify: it.notify, sessionsTtlDays: it.sessionsTtlDays, loaded: !!it.loaded, pending: !!it.pending } as AccountSettings });
  });

  // отказы сервера: тост на каждый новый (случившиеся до подписки — уже не новость)
  const opsM = new Mirror();
  let seen = -1;
  engine.watch({ kind: 'ops' }, (p) => {
    opsM.apply(p);
    const failures = (opsM.list()[0]?.failures ?? []) as { id: number; code: string }[];
    const max = failures.reduce((m, f) => Math.max(m, f.id), 0);
    if (seen >= 0) {
      const fresh = failures.filter((f) => f.id > seen);
      if (fresh.length) showToast(failText(fresh[fresh.length - 1].code));
    }
    seen = Math.max(seen, max);
  });
}

const call = <T>(a: Action): Promise<T> => (engine ? engine.call<T>(a) : Promise.reject(new Error('engine not started')));

export interface ProfilePatch { firstName?: string; lastName?: string; bio?: string | null; birthday?: { day: number; month: number; year?: number } | null }
export const updateProfile = (patch: ProfilePatch): Promise<unknown> => call({ type: 'updateProfile', ...patch });
export const setUsername = (username: string | null): Promise<unknown> => call({ type: 'setUsername', username });
export type UsernameCheck = { ok: true } | { ok: false; reason: 'invalid' | 'taken' | 'reserved' } | { offline: true };
export const checkUsername = (username: string): Promise<UsernameCheck> =>
  call<UsernameCheck>({ type: 'checkUsername', username }).catch(() => ({ offline: true as const }));

export const setNotifyDefault = (notifyType: 'direct' | 'group', patch: { muted?: boolean; preview?: boolean }): Promise<unknown> =>
  call({ type: 'setNotify', notifyType, ...patch });

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
