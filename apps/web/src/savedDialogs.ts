// Подчаты «Избранного» в интерфейсе: одна подписка движка на всё приложение (шапка чата и панель видят одно и то же), список
// живёт после первого показа — повторное открытие рисуется сразу. Данные — packages/sync-engine/src/savedDialogs.ts.
import { useEffect, useState } from 'preact/hooks';
import type { ProfilePhoto } from '@relay/protocol';
import { SAVED_HIDDEN, SAVED_NOTES } from '@relay/protocol';
import { Mirror } from '@relay/sync-engine/src/client';
import type { Item, Patch } from '@relay/sync-engine/src/types';
import { plural } from '@relay/ui';
import { watchQuery } from './settingsData';

export type SavedItem = Item & { peer: string; count: number; lastId: number | null; pinnedAt: number | null; title: string | null; photo: ProfilePhoto | null; kind: 'user' | 'group' | 'channel' | null; access: boolean; userId?: number; peerKey?: string; sourceChatId?: number; createdAt: string | null; last: Record<string, unknown> | null };
export interface SavedMetaView { loaded: boolean; total: number; messages: number; done: boolean; chatId: number | null }
export interface SavedDialogsView { items: SavedItem[]; meta: SavedMetaView | null }

const EMPTY: SavedDialogsView = { items: [], meta: null };
let view = EMPTY, watch: { close(): void } | null = null;
const listeners = new Set<(v: SavedDialogsView) => void>();

function start(): void {
  if (watch) return;
  const mirror = new Mirror();
  watch = watchQuery({ kind: 'savedDialogs' }, (p: Patch) => {
    mirror.apply(p);
    view = { items: mirror.list() as SavedItem[], meta: (mirror.meta('~saved') as unknown as SavedMetaView | undefined) ?? null };
    for (const l of listeners) l(view);
  });
}
/** Выход и вход другим пользователем: кэш отрисовки прежнего аккаунта — прочь. */
export function resetSavedDialogs(): void { watch?.close(); watch = null; view = EMPTY; }

/** Список подчатов; on — подписка нужна сейчас (чат «Избранное» на экране или панель открыта). */
export function useSavedDialogs(on = true): SavedDialogsView {
  const [v, set] = useState(view);
  useEffect(() => {
    if (!on) return;
    start();
    if (v !== view) set(view);
    listeners.add(set);
    return () => { listeners.delete(set); };
  }, [on]);
  return v;
}
/** Строка подчата уже на устройстве (для заголовка в момент открытия кадра, без мигания). */
export const savedRow = (peer: string | null | undefined): SavedItem | null => (peer ? view.items.find((d) => d.peer === peer) ?? null : null);

export const isNotes = (peer: string): boolean => peer === SAVED_NOTES;
export const isHiddenPeer = (peer: string): boolean => peer === SAVED_HIDDEN;
/** Название строки: заметки и скрытый автор подписываются здесь, у остальных — от движка. */
export function savedTitle(d: Pick<SavedItem, 'peer' | 'title'> | null | undefined, peer?: string | null): string {
  const p = d?.peer ?? peer;
  if (p === SAVED_NOTES) return 'Мои заметки';
  if (p === SAVED_HIDDEN) return 'Автор скрыт';
  return d?.title || 'Без названия';
}

export const messagesText = (n: number): string => `${n} ${plural(n, 'сообщение', 'сообщения', 'сообщений')}`;
export const chatsText = (n: number): string => `${n} ${plural(n, 'чат', 'чата', 'чатов')}`;

/** Можно ли открыть источник: сервер сказал, что он читается, или чат есть у меня. */
export const canOpenSource = (d: SavedItem | null | undefined): boolean => !!d && d.peer !== SAVED_NOTES && d.peer !== SAVED_HIDDEN && d.access;
/** Кнопка под лентой подчата (как в Telegram): что откроется. */
export const openSourceLabel = (d: SavedItem): string => (d.kind === 'channel' ? 'Открыть канал' : d.kind === 'group' ? 'Открыть группу' : 'Открыть чат');
