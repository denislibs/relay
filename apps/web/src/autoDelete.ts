// Автоудаление сообщений чата: чистая логика и подписи. Срок ставит и проверяет сервер (domain/autoDelete.ts): здесь только
// то, что видит человек. Настройка уходит операцией движка (переживает офлайн), само исчезновение — таймер движка.
import { AUTO_DELETE_MAX_SEC, AUTO_DELETE_MIN_SEC, type MyMembership } from '@relay/protocol';
import { adminCan } from './groups';

const HOUR = 3600, DAY = 86400, WEEK = 7 * DAY, MONTH = 30 * DAY, YEAR = 365 * DAY;
export const AUTO_DELETE_PRESETS = [DAY, WEEK, MONTH] as const;

function plural(n: number, one: string, few: string, many: string): string {
  const a = n % 100, b = n % 10;
  return n + ' ' + (a >= 11 && a <= 14 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many);
}
const hours = (n: number) => plural(n, 'час', 'часа', 'часов');
const days = (n: number) => plural(n, 'день', 'дня', 'дней');
const weeks = (n: number) => plural(n, 'неделя', 'недели', 'недель');
const months = (n: number) => plural(n, 'месяц', 'месяца', 'месяцев');

/** Срок настройкой: «1 неделя», «36 часов». Дробное в единицах не округляем: срок показывается точно. */
export function termText(sec: number): string {
  if (sec === YEAR) return '1 год';
  if (sec % MONTH === 0) return months(sec / MONTH);
  if (sec % WEEK === 0) return weeks(sec / WEEK);
  if (sec % DAY === 0) return days(sec / DAY);
  if (sec % HOUR === 0) return hours(sec / HOUR);
  if (sec % 60 === 0) return plural(sec / 60, 'минута', 'минуты', 'минут');
  return plural(sec, 'секунда', 'секунды', 'секунд');   // только под DEV_LOGIN
}

/** Сколько осталось, в меню сообщения: «Удалится через 5 ч». Округляем вверх: «через 1 мин» — ещё не вышло. */
export function leftText(expiresAt: number, now: number): string {
  const s = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  if (s < 60) return 'Удалится через ' + s + ' с';
  if (s < HOUR) return 'Удалится через ' + Math.ceil(s / 60) + ' мин';
  if (s < DAY) return 'Удалится через ' + Math.ceil(s / HOUR) + ' ч';
  if (s < MONTH) return 'Удалится через ' + days(Math.ceil(s / DAY));
  return 'Удалится через ' + months(Math.ceil(s / MONTH));
}

export type TermUnit = 'hours' | 'days' | 'weeks' | 'months';
export const TERM_UNITS: { value: TermUnit; label: string }[] = [{ value: 'hours', label: 'часов' }, { value: 'days', label: 'дней' }, { value: 'weeks', label: 'недель' }, { value: 'months', label: 'месяцев' }];
const UNIT: Record<TermUnit, number> = { hours: HOUR, days: DAY, weeks: WEEK, months: MONTH };

/** Свой срок из окна выбора: от часа до года. Строка — ошибка для человека. */
export function customTerm(raw: string, unit: TermUnit): number | string {
  const t = raw.trim();
  if (!/^[0-9]+$/.test(t) || Number(t) < 1) return 'Введите целое число';
  const sec = Number(t) * UNIT[unit];
  if (sec < AUTO_DELETE_MIN_SEC) return 'Не меньше часа';
  if (sec > AUTO_DELETE_MAX_SEC) return 'Не больше года';
  return sec;
}

/** Единицы для уже выбранного срока (чтобы окно открылось с ним). */
export function termParts(sec: number | null): { value: string; unit: TermUnit } {
  if (!sec) return { value: '', unit: 'hours' };
  for (const unit of ['months', 'weeks', 'days', 'hours'] as const) if (sec % UNIT[unit] === 0) return { value: String(sec / UNIT[unit]), unit };
  return { value: '', unit: 'hours' };
}

/** Менять: личный — любой из двоих (без блокировки), «Избранное» — сам, группа и канал — админ с правом менять информацию. */
export function canSetAutoDelete(o: { preview?: boolean; system?: boolean; saved?: boolean; peerId?: number | null; blocked?: boolean; me?: MyMembership | null }): boolean {
  if (o.preview || o.system) return false;
  if (o.saved) return true;
  if (o.peerId != null) return !o.blocked;
  return adminCan(o.me ?? null, 'info');
}
