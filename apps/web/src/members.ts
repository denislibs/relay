import { useEffect, useState } from 'preact/hooks';
import type { ProfilePhoto } from '@relay/protocol';
import { rememberPhotos } from './profilePhoto';

/** Участник группы, как его отдаёт сервер: имя (как видит зритель), @имя и присутствие с учётом приватности. */
export type Member = { userId: number; name: string; username: string | null; online: boolean | null; lastSeen: string | null; photo?: ProfilePhoto | null; role?: 'owner' | 'admin' | 'member'; rank?: string | null };
export type Members = { ownerId: number | null; members: Member[] };

const cache = new Map<number, Members>();
const inflight = new Map<number, Promise<Members>>();

export function loadMembers(chatId: number, fresh = false): Promise<Members> {
  let p = inflight.get(chatId);
  if (p && !fresh) return p;
  p = fetch(`/chats/${chatId}/members`).then((r) => {
    if (!r.ok) throw new Error('members ' + r.status);
    return r.json() as Promise<Members>;
  }).then((m) => { cache.set(chatId, m); rememberPhotos(Object.fromEntries(m.members.map((x) => [x.userId, x.photo ?? null]))); return m; }).finally(() => inflight.delete(chatId));
  inflight.set(chatId, p);
  return p;
}

/** Участники группы: сразу из кэша (без мигания при повторном открытии), потом свежие с сервера. Не группа — null.
 *  rev — номер изменения состава из журнала (membersChanged): сменился — перечитать. */
export function useMembers(chatId: number, group: boolean, rev = 0): Members | null {
  const [m, setM] = useState<Members | null>(() => (group ? cache.get(chatId) ?? null : null));
  useEffect(() => {
    if (!group) { setM(null); return; }
    setM(cache.get(chatId) ?? null);
    let live = true;
    loadMembers(chatId, rev > 0).then((x) => { if (live) setM(x); }).catch(() => { /* без сети — что в кэше */ });
    return () => { live = false; };
  }, [chatId, group, rev]);
  return m;
}

export const membersWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'участник' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'участника' : 'участников');

/** «5 участников» и, если кто-то в сети, «, 2 в сети» — как в шапке группы в Telegram. */
export function membersStatus(m: Members, withOnline: boolean): string {
  const n = m.members.length;
  const on = m.members.filter((x) => x.online).length;
  return `${n} ${membersWord(n)}` + (withOnline && on > 0 ? `, ${on} в сети` : '');
}
