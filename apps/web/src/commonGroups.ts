import { useEffect, useState } from 'preact/hooks';
import { useKeyedState } from './keyedState';
import type { ProfilePhoto } from '@relay/protocol';
import { callEngine } from './settingsData';

/** Общая группа с собеседником — как отдаёт сервер (/users/:id/common-groups). */
export type CommonGroup = { id: number; title: string; photo: ProfilePhoto | null; members: number };

/** Последний ответ по собеседнику: повторное открытие профиля рисует вкладку сразу, затем ответ сервера её обновляет. */
const last = new Map<number, CommonGroup[]>();
export function resetCommonGroups(): void { last.clear(); }

/** Общие группы с собеседником (вкладка «Группы» в профиле, как в Telegram); null — ещё не знаем; нет собеседника — null. */
export function useCommonGroups(peerId: number | null | undefined): CommonGroup[] | null {
  const [groups, setGroups] = useKeyedState<number | null | undefined, CommonGroup[] | null>(peerId, (id) => (id ? last.get(id) ?? null : null));
  useEffect(() => {
    if (!peerId) { setGroups(null); return; }
    setGroups(last.get(peerId) ?? null);
    let live = true;
    void (callEngine({ type: 'commonGroups', userId: peerId }) as Promise<CommonGroup[]>).then(
      (g) => { last.set(peerId, g); if (live) setGroups(g); },
      () => { if (live) setGroups((x) => x ?? []); },   // офлайн: без вкладки, а не вечная загрузка
    );
    return () => { live = false; };
  }, [peerId]);
  return groups;
}
