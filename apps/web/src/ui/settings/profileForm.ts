// Форма «Изменить профиль» без DOM: значения, что изменилось, проверка имени пользователя.
import type { Me } from '../../global';
import type { Birthday } from '../format';

export const NAME_MAX = 64;
export const BIO_MAX = 140;

export interface ProfileForm { firstName: string; lastName: string; bio: string; username: string; birthday: Birthday | null }

export const USERNAME_TEXT = {
  checking: 'Проверяем…',
  free: 'Имя свободно',
  taken: 'Это имя уже занято',
  invalid: 'Недопустимое имя: 5–32 символа, латиница, цифры и _',
} as const;
export type UsernameStatus = keyof typeof USERNAME_TEXT | 'offline' | null;

export function formFromMe(me: Me): ProfileForm {
  // старый кэш relay.me знает только name — делим по первому пробелу, как сервер
  const sp = me.name.indexOf(' ');
  return {
    firstName: me.firstName ?? (sp < 0 ? me.name : me.name.slice(0, sp)),
    lastName: me.lastName ?? (sp < 0 ? '' : me.name.slice(sp + 1)),
    bio: me.bio ?? '',
    username: me.username ?? '',
    birthday: me.birthday ?? null,
  };
}

const name = (s: string) => s.trim().replace(/\s+/g, ' ');
const bio = (s: string) => s.replace(/\r\n?/g, '\n').trim();
export const normUsername = (s: string) => s.trim().replace(/^@/, '').toLowerCase();

/** Та же форма имени, что проверяет сервер: 5–32, a-z0-9_, с буквы, без «__» и «_» в конце. */
export function usernameShapeOk(raw: string): boolean {
  const u = normUsername(raw);
  return /^[a-z][a-z0-9_]{4,31}$/.test(u) && !u.endsWith('_') && !u.includes('__');
}

export const sameBirthday = (a: Birthday | null, b: Birthday | null) =>
  a === b || (!!a && !!b && a.day === b.day && a.month === b.month && (a.year ?? null) === (b.year ?? null));

/** Изменённые поля профиля (для PATCH /me); пусто — менять нечего. */
export function profilePatch(me: Me, f: ProfileForm): { firstName?: string; lastName?: string; bio?: string | null; birthday?: Birthday | null } {
  const cur = formFromMe(me), out: ReturnType<typeof profilePatch> = {};
  if (name(f.firstName) !== name(cur.firstName)) out.firstName = name(f.firstName);
  if (name(f.lastName) !== name(cur.lastName)) out.lastName = name(f.lastName);
  if (bio(f.bio) !== bio(cur.bio)) out.bio = bio(f.bio) || null;
  if (!sameBirthday(f.birthday, cur.birthday)) out.birthday = f.birthday;
  return out;
}

export const usernameChanged = (me: Me, f: ProfileForm) => normUsername(f.username) !== normUsername(me.username ?? '');

export const isDirty = (me: Me, f: ProfileForm) => Object.keys(profilePatch(me, f)).length > 0 || usernameChanged(me, f);

/** Можно ли сохранить: имя есть, о себе в пределах, новое имя пользователя свободно (или проверить не удалось — решит сервер). */
export function canSave(me: Me, f: ProfileForm, status: UsernameStatus): boolean {
  if (!name(f.firstName) || [...bio(f.bio)].length > BIO_MAX) return false;
  if (!usernameChanged(me, f) || !normUsername(f.username)) return true;
  return usernameShapeOk(f.username) && (status === 'free' || status === 'offline');
}

/** Дней в месяце (без года — как в високосный: 29 февраля допустимо). */
export const daysIn = (month: number, year?: number) => new Date(Date.UTC(year ?? 2000, month, 0)).getUTCDate();
