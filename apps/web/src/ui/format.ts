import { peerTone } from '@relay/ui';
const pad = (n: number) => String(n).padStart(2, '0');

export function chatTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (d.getTime() <= 0) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 1) return 'Вчера';
  if (diff < 7) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  if (!lastSeen) return 'был(а) давно';
  const d = new Date(lastSeen), ago = now - d.getTime();
  if (ago < 60_000) return 'был(а) только что';
  if (ago < 3_600_000) return `был(а) ${Math.floor(ago / 60_000)} мин. назад`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  const at = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

/** Фрагмент вокруг совпадения: длинное начало обрезаем, чтобы найденное было видно в строке. */
export function snippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i <= 24) return text;
  const from = text.lastIndexOf(' ', i - 12);
  return '…' + text.slice(from > 0 ? from + 1 : i - 12);
}

/** Цвет чата: у личного — собеседника, у группы — по id чата. */
export function chatTone(chat: Record<string, unknown> | null | undefined): number | undefined {
  const id = (chat?.peerId as number | null | undefined) ?? (chat?.id as number | undefined);
  return id == null ? undefined : peerTone(id);
}
