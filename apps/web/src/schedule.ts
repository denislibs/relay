// Отложенные сообщения: правила дат и подписи без DOM (ScheduleModal, Chat, Feed); проверяются юнит-тестами.
import { SCHEDULE_MAX_MS } from '@relay/protocol';

const pad = (n: number) => String(n).padStart(2, '0');
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
/** Сколько календарных дней от сегодня (через смену часов на сутки в 23 или 25 часов — верно). */
const daysFrom = (at: Date, now: Date) => Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
const DAY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const DAY_YEAR = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

export const clockOf = (at: number): string => { const d = new Date(at); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };

/** Ближайшая ровная получасовая отметка не раньше чем через 10 минут: «Сегодня в 15:30». */
export function nextSlot(now: number): number {
  const d = new Date(now + 10 * 60_000);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  d.setMinutes(m === 0 || m === 30 ? m : m < 30 ? 30 : 60);
  return d.getTime();
}

/** Быстрые варианты: «Сегодня в …» (если сегодня ещё есть куда), «Завтра в …» — то же время; 9 утра, если оно позже. */
export function quickOptions(now: number): { label: string; at: number }[] {
  const slot = nextSlot(now), out: { label: string; at: number }[] = [];
  if (daysFrom(new Date(slot), new Date(now)) === 0) out.push({ label: 'Сегодня в ' + clockOf(slot), at: slot });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  out.push({ label: 'Завтра в ' + clockOf(tomorrow.getTime()), at: tomorrow.getTime() });
  return out;
}

export type ScheduleError = 'past' | 'far' | null;
/** Прошлое и дальше года — нельзя (сервер проверяет то же). */
export function checkSchedule(at: number, now: number): ScheduleError {
  if (!Number.isFinite(at) || at <= now) return 'past';
  return at > now + SCHEDULE_MAX_MS ? 'far' : null;
}
export const SCHEDULE_ERROR_TEXT: Record<Exclude<ScheduleError, null>, string> = { past: 'Это время уже прошло', far: 'Можно запланировать не больше чем на год вперёд' };

/** Самый поздний день в календаре: год от сегодня. */
export const maxScheduleDay = (now: number): Date => new Date(now + SCHEDULE_MAX_MS);

/** Дата и время словами: «сегодня в 15:30», «завтра в 09:00», «5 ноября в 10:00», с годом — если другой. */
export function whenText(at: number, now: number): string {
  const d = new Date(at), n = new Date(now), days = daysFrom(d, n);
  const day = days === 0 ? 'сегодня' : days === 1 ? 'завтра' : (d.getFullYear() === n.getFullYear() ? DAY : DAY_YEAR).format(d);
  return day + ' в ' + clockOf(at);
}

/** Кнопка в окне выбора: «Отправить сегодня в 15:30», в «Избранном» — «Напомнить …». */
export const submitLabel = (at: number, now: number, saved: boolean): string => (saved ? 'Напомнить ' : 'Отправить ') + whenText(at, now);

/** Тост после планирования. */
export const scheduledToast = (at: number, now: number, saved: boolean): string => (saved ? 'Напоминание придёт ' : 'Сообщение будет отправлено ') + whenText(at, now);

/** Заголовок страницы и дня в списке. */
export const scheduledTitle = (saved: boolean): string => (saved ? 'Напоминания' : 'Отложенные сообщения');
export function scheduledDay(iso: string, now: number): string {
  const d = new Date(iso), n = new Date(now), days = daysFrom(d, n);
  return days === 0 ? 'Сегодня' : days === 1 ? 'Завтра' : (d.getFullYear() === n.getFullYear() ? DAY : DAY_YEAR).format(d);
}

/** Значение <input type=date/time> → мс: день выбран, время — строка «ЧЧ:ММ». */
export function withClock(day: Date, clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}

/** Почему отложенное не ушло — строкой под пузырём и в тосте. */
export function scheduledFailText(code: string): string {
  switch (code) {
    case 'blocked': return 'Не отправлено: собеседник ограничил отправку сообщений';
    case 'forbidden': return 'Не отправлено: у вас нет права писать в этот чат';
    case 'not_member': return 'Не отправлено: вы не участник этого чата';
    case 'not_found': return 'Не отправлено: чат или вложение больше не существует';
    case 'schedule_limit': return 'Можно запланировать не больше 100 сообщений на чат';
    case 'schedule_far': return 'Можно запланировать не больше чем на год вперёд';
    default: return 'Не отправлено';
  }
}

