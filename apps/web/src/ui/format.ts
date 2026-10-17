import { getPrefs, localeTimeFormat } from '../prefs';

export { localeTimeFormat };

const pad = (n: number) => String(n).padStart(2, '0');

export type TimeFormat = '12h' | '24h';

/** Часы:минуты в нужном формате; fmt не задан — настройка устройства (null → локаль). */
export function hm(d: Date, fmt: TimeFormat = getPrefs().timeFormat ?? localeTimeFormat()): string {
  if (fmt === '24h') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const h = d.getHours();
  return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

export function chatTime(iso: string | undefined, fmt?: TimeFormat): string {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (d.getTime() <= 0) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return hm(d, fmt);
  if (diff === 1) return 'Вчера';
  if (diff < 7) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

export function clock(iso: string, fmt?: TimeFormat): string {
  return hm(new Date(iso), fmt);
}

export function dayLabel(iso: string): string {
  const d = new Date(iso), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Подзаголовок личного чата, как в Telegram: «в сети», «был(а) 5 мин. назад», «был(а) вчера в 21:05»… */
export function lastSeenText(online: boolean, lastSeen: string | null, now = Date.now()): string {
  if (online) return 'в сети';
  if (lastSeen === 'recently') return 'был(а) недавно';   // время скрыто правилом «Последний визит»
  if (!lastSeen) return 'был(а) давно';
  const d = new Date(lastSeen), ago = now - d.getTime();
  if (ago < 60_000) return 'был(а) только что';
  if (ago < 3_600_000) return `был(а) ${Math.floor(ago / 60_000)} мин. назад`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  const at = hm(d);
  if (days === 0) return `был(а) в ${at}`;
  if (days === 1) return `был(а) вчера в ${at}`;
  if (days < 7) return `был(а) ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} в ${at}`;
  return `был(а) ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

/** Размер файла: 812 Б, 34 КБ, 2,4 МБ. */
export function fileSize(n: number): string {
  if (n < 1024) return n + ' Б';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' КБ';
  return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
}

/** День рождения: год необязателен. */
export interface Birthday { day: number; month: number; year?: number }

export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** Полных лет на дату now (по местному календарю). */
export function age(b: Birthday, now = new Date()): number | null {
  if (!b.year) return null;
  let n = now.getFullYear() - b.year;
  if (now.getMonth() + 1 < b.month || (now.getMonth() + 1 === b.month && now.getDate() < b.day)) n--;
  return n >= 0 ? n : null;
}

const yearsWord = (n: number) => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? 'год' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'года' : 'лет';
};

/** «29 апреля (34 года)»; без года — «29 апреля». */
export function birthdayText(b: Birthday, now = new Date()): string {
  const base = `${b.day} ${MONTHS_GEN[b.month - 1] ?? ''}`.trim();
  const a = age(b, now);
  return a == null ? base : `${base} (${a} ${yearsWord(a)})`;
}
