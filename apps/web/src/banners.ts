// Подсказка над вкладками списка чатов (как в Telegram): одновременно одна, первая подходящая —
// «Это вы?» про новый вход, уведомления, дни рождения контактов сегодня, свой день рождения. Закрытие хранится на устройстве:
// уведомления и «свой ДР» — насовсем, дни рождения — до завтра.
import type { SessionInfo } from '@relay/protocol';
import { sessionConfirmKey, sessionsView } from '@relay/sync-engine/src/sessions';
import type { NotifyState } from './notify';

export type Banner =
  | { kind: 'unconfirmed'; session: SessionInfo }
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
  sessions?: SessionInfo[] | null;
}

export const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

export function pickBanner(i: BannerInput): Banner | null {
  // «Это вы?» важнее всего и не закрывается крестиком — только ответом.
  // На неподтверждённом устройстве её нет: оно само может быть чужим.
  const me = i.sessions?.find((x) => x.current);
  if (me && !me.unconfirmed) {
    const fresh = i.sessions!.find((x) => x.unconfirmed && !x.current);
    if (fresh) return { kind: 'unconfirmed', session: fresh };
  }
  if (i.notify === 'default' && !i.dismissed.notify) return { kind: 'notify' };
  if (i.dismissed.birthdays !== dayKey(i.today)) {
    const d = i.today.getDate(), m = i.today.getMonth() + 1;
    const people = i.contacts.filter((c) => c.birthday && c.birthday.day === d && c.birthday.month === m).map(({ userId, name }) => ({ userId, name }));
    if (people.length) return { kind: 'birthdays', people };
  }
  if (i.me && !i.me.birthday && !i.dismissed.setBirthday) return { kind: 'setBirthday' };
  return null;
}

/**
 * Сеансы, как их видит интерфейс: завершаемые скрыты (sessionsView), а подтверждаемые — уже не «новый вход»,
 * пока подтверждение в очереди: иначе плашка «Это вы?» и пометка в списке висели бы до ответа сервера.
 */
export function sessionsSeen(list: readonly SessionInfo[], keys: readonly string[]): SessionInfo[] {
  const view = sessionsView(list, keys);
  if (!keys.length) return view;
  const set = new Set(keys);
  return view.map((x) => (x.unconfirmed && set.has(sessionConfirmKey(x.id)) ? { ...x, unconfirmed: false } : x));
}

export function loadDismissed(): Dismissed {
  try { const v = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '{}'); return v && typeof v === 'object' ? v as Dismissed : {}; } catch { return {}; }
}

export function saveDismissed(d: Dismissed): void {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify(d)); } catch { /* приватный режим: до перезагрузки */ }
}

/** Закрыть подсказку: что именно запомнить. «Это вы?» не закрывается — у неё нет крестика. */
export function dismiss(d: Dismissed, b: Banner, today: Date): Dismissed {
  return b.kind === 'birthdays' ? { ...d, birthdays: dayKey(today) } : { ...d, [b.kind]: true };
}
