// Подсказка над вкладками списка чатов (как в Telegram): одновременно одна, первая подходящая —
// уведомления, дни рождения контактов сегодня, свой день рождения. Закрытие хранится на устройстве:
// уведомления и «свой ДР» — насовсем, дни рождения — до завтра.
import type { NotifyState } from './notify';

export type Banner =
  | { kind: 'notify' }
  | { kind: 'birthdays'; people: { userId: number; name: string }[] }
  | { kind: 'setBirthday' };

export interface Dismissed { notify?: boolean; setBirthday?: boolean; birthdays?: string }   // birthdays — день, когда закрыли
export const DISMISS_KEY = 'relay.banners';

type Bday = { day: number; month: number } | null | undefined;
export interface BannerInput {
  notify: NotifyState;
  dismissed: Dismissed;
  me: { birthday?: Bday } | null;
  contacts: { userId: number; name: string; birthday?: Bday }[];
  today: Date;
}

export const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

export function pickBanner(i: BannerInput): Banner | null {
  if (i.notify === 'default' && !i.dismissed.notify) return { kind: 'notify' };
  if (i.dismissed.birthdays !== dayKey(i.today)) {
    const d = i.today.getDate(), m = i.today.getMonth() + 1;
    const people = i.contacts.filter((c) => c.birthday && c.birthday.day === d && c.birthday.month === m).map(({ userId, name }) => ({ userId, name }));
    if (people.length) return { kind: 'birthdays', people };
  }
  if (i.me && !i.me.birthday && !i.dismissed.setBirthday) return { kind: 'setBirthday' };
  return null;
}

export function loadDismissed(): Dismissed {
  try { const v = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '{}'); return v && typeof v === 'object' ? v as Dismissed : {}; } catch { return {}; }
}

export function saveDismissed(d: Dismissed): void {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify(d)); } catch { /* приватный режим: до перезагрузки */ }
}

/** Закрыть подсказку: что именно запомнить. */
export function dismiss(d: Dismissed, b: Banner, today: Date): Dismissed {
  return b.kind === 'birthdays' ? { ...d, birthdays: dayKey(today) } : { ...d, [b.kind]: true };
}
