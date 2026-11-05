import { useEffect, useState } from 'preact/hooks';
import { useKeyedState } from './keyedState';
import type { ProfilePhoto } from '@relay/protocol';
import { Mirror } from '@relay/sync-engine/src/client';
import type { Patch } from '@relay/sync-engine/src/types';
import { watchQuery } from './settingsData';

/** Участник группы, как его отдаёт сервер: имя (как видит зритель), @имя и присутствие с учётом приватности. */
export type Member = { userId: number; name: string; username?: string | null; online: boolean | null; lastSeen: string | null; photo?: ProfilePhoto | null; role?: 'owner' | 'admin' | 'member'; rank?: string | null };
export type Members = { ownerId: number | null; members: Member[] };

/** Последнее значение по чату — только кэш отрисовки подписки: повторное открытие панели рисуется сразу, без мигания. */
const last = new Map<number, Members>();
export const cachedMembers = (chatId: number): Members | null => last.get(chatId) ?? null;
export const rememberMembers = (chatId: number, m: Members): void => { last.set(chatId, m); };
/** Выход и вход другим пользователем без перезагрузки: участники прежнего аккаунта не показываются. */
export function resetMembers(): void { last.clear(); }

/** Список участников из зеркала подписки `members`; null — движок ещё ничего не отдал (нет ни элементов, ни ~members.loaded). */
export function membersOf(m: Mirror): Members | null {
  const items = m.list();
  if (!items.length && !m.meta('~members')?.loaded) return null;
  const members = items.map((i) => ({ userId: i.userId, name: i.name, online: i.online, lastSeen: i.lastSeen, photo: i.photo, role: i.role, rank: i.rank }) as Member);
  return { ownerId: members.find((x) => x.role === 'owner')?.userId ?? null, members };
}

/**
 * Открытие группы: подписка заранее, пока собирается лента нового чата, — кэш заполнен до того, как колонка
 * смонтируется, и шапка встаёт сразу с «N участников», а не «Группа» на несколько кадров (как статус в личном чате).
 * Уже в кэше — ничего не делаем. Возвращает отписку.
 */
export function prefetchMembers(chatId: number): () => void {
  if (last.has(chatId)) return () => {};
  const mirror = new Mirror();
  const w = watchQuery({ kind: 'members', chatId }, (p: Patch) => {
    mirror.apply(p);
    const x = membersOf(mirror);
    if (x) rememberMembers(chatId, x);
  });
  return () => w.close();
}

/** Участники группы — подписка движка (первый показ из IndexedDB, дальше журнал); без собственных запросов. Не группа — null. */
export function useMembers(chatId: number, group: boolean): Members | null {
  const [m, setM] = useKeyedState<string, Members | null>(group + ':' + chatId, () => (group ? cachedMembers(chatId) : null));
  useEffect(() => {
    if (!group) { setM(null); return; }
    setM(cachedMembers(chatId));
    const mirror = new Mirror();
    const w = watchQuery({ kind: 'members', chatId }, (p: Patch) => {
      mirror.apply(p);
      const x = membersOf(mirror);
      if (x) { rememberMembers(chatId, x); setM(x); }
    });
    return () => w.close();
  }, [chatId, group]);
  return m;
}

export const membersWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'участник' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'участника' : 'участников');

/** «5 участников» и, если кто-то в сети, «, 2 в сети» — как в шапке группы в Telegram. */
export function membersStatus(m: Members, withOnline: boolean): string {
  const n = m.members.length;
  const on = m.members.filter((x) => x.online).length;
  return `${n} ${membersWord(n)}` + (withOnline && on > 0 ? `, ${on} в сети` : '');
}
