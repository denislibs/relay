import {
  ADMIN_RIGHTS, MEDIA_RIGHTS, MEMBER_RIGHTS, isAdminRole,
  type AdminRight, type AdminRights, type CommunityKind, type GroupInfo, type MemberRight, type MemberRights, type MyMembership,
} from '@relay/protocol';
import { useEffect, useState } from 'preact/hooks';
import { useKeyedState } from './keyedState';
import { groupCall, type GroupResult } from './data';
import { findChat, useGlobal } from './global';
import { showToast } from './settingsData';
export { ADMIN_RIGHT_TEXT, adminRightText, CHANNEL_ADMIN_RIGHT_TEXT, MEMBER_RIGHT_TEXT, SLOW_TEXT } from './rightsText';

// Группа на клиенте: моё место в ней, тексты прав и ошибок, загрузка списков управления (участники, ссылки, заявки…).
// Списки перечитываются, когда журнал сообщает об изменении (membersRev, groupUpdated).

export type ChatGroup = { group: GroupInfo | null; me: MyMembership | null; membersRev: number; title: string; kind: CommunityKind };

export function useGroup(chatId: number): ChatGroup {
  return useGlobal((s) => {
    const c = findChat(s, chatId);
    return { group: (c?.group as GroupInfo | null) ?? null, me: (c?.me as MyMembership | null) ?? null, membersRev: (c?.membersRev as number) ?? 0, title: String(c?.title ?? ''), kind: c?.kind === 'channel' ? 'channel' : 'group' };
  });
}

/** Может ли открыть «Изменить группу»: владелец, админ или участник, которому можно менять информацию. */
export const canManage = (me: MyMembership | null) => !!me && (isAdminRole(me.role) || me.rights.info);
export const adminCan = (me: MyMembership | null, r: AdminRight) => !!me?.admin?.[r];
export const canChangeInfo = (me: MyMembership | null) => adminCan(me, 'info') || !!me?.rights.info;
export const canInvite = (me: MyMembership | null) => adminCan(me, 'invite') || !!me?.rights.invite;

export { ADMIN_RIGHTS, MEDIA_RIGHTS, MEMBER_RIGHTS };
export const PLAIN_RIGHTS: MemberRight[] = ['react', 'invite', 'pin', 'info'];

/**
 * Переключение права с зависимостями (как в Telegram): «Медиа» ставит все медиа-пункты, превью ссылок
 * без текста не бывает — включили превью, включается и текст; выключили текст — гаснет превью.
 */
export function toggleRight(r: MemberRights, key: MemberRight | 'media', on: boolean): MemberRights {
  const next = { ...r };
  if (key === 'media') for (const k of MEDIA_RIGHTS) next[k] = on;
  else next[key] = on;
  if (key === 'links' && on) next.text = true;
  if (!next.text) next.links = false;
  return next;
}
export const mediaCount = (r: MemberRights) => MEDIA_RIGHTS.filter((k) => r[k]).length;
export const sameRights = <T extends Record<string, boolean>>(a: T, b: T) => Object.keys(a).every((k) => a[k] === b[k]);
export const sameAdmin = (a: AdminRights, b: AdminRights) => (Object.keys(a) as AdminRight[]).every((k) => a[k] === b[k]);
const ERRORS: Record<string, string> = {
  offline: 'Нет сети — попробуйте позже',
  forbidden: 'Недостаточно прав',
  not_member: 'Вы не участник этой группы',
  not_found: 'Не найдено',
  too_long: 'Слишком длинно',
  username_taken: 'Это имя уже занято',
  username_invalid: 'Имя: 5–32 символа, латиница, цифры и _',
  password_missing: 'Сначала включите облачный пароль в настройках',
  password_invalid: 'Неверный пароль',
  photo_invalid: 'Не получилось поставить фото',
  flood: 'Слишком часто — подождите немного',
  blocked: 'Пользователь вас заблокировал',
};
export const errorText = (code: string) => ERRORS[code] ?? 'Не получилось — попробуйте ещё раз';

/** Вызов с тостом при ошибке; результат — данные или null. */
export async function act<T = unknown>(method: Parameters<typeof groupCall>[0], path: string, body?: unknown, done?: string): Promise<T | null> {
  const r = await groupCall<T>(method, path, body);
  if (!r.ok) { showToast(errorText(r.code)); return null; }
  if (done) showToast(done);
  return r.data;
}

const cache = new Map<string, unknown>();

/** GET списка управления: сразу из кэша (без мигания при возврате), потом свежий; rev — перечитать. */
export function useGroupData<T>(path: string | null, rev: unknown = 0): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useKeyedState<string | null, T | null>(path, (p) => (p ? (cache.get(p) as T) ?? null : null));
  const [error, setError] = useKeyedState<string | null, string | null>(path, () => null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    if (cache.has(path)) setData(cache.get(path) as T);
    let live = true;
    groupCall<T>('GET', path).then((r: GroupResult<T>) => {
      if (!live) return;
      if (r.ok) { cache.set(path, r.data); setData(r.data); setError(null); } else setError(r.code);
    });
    return () => { live = false; };
  }, [path, JSON.stringify(rev), n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export const inviteUrl = (token: string) => location.origin + '/+' + token;
export const publicUrl = (username: string) => location.origin + '/@' + username;
/** Ссылка на сообщение группы или канала (как t.me): публичный — /@имя/id, закрытый — /c/чат/id (откроется у участников). */
export const messageLink = (chatId: number, username: string | null | undefined, msgId: number) =>
  location.origin + (username ? '/@' + username : '/c/' + chatId) + '/' + msgId;
export const copyText = (text: string, toast = 'Ссылка скопирована') => { navigator.clipboard?.writeText(text).then(() => showToast(toast)).catch(() => {}); };

export const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;

