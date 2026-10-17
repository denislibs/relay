// Мелочи раздела «Для разработчиков»: строки «подпись — значение» моноширинным шрифтом и форматирование чисел.
import type { ComponentChildren } from 'preact';

/** Строка карточки: подпись слева, значение справа (tabular-nums — цифры не прыгают). */
export function KV(props: { label: string; value: ComponentChildren; warn?: boolean; title?: string }) {
  return (
    <div class={'app-kv' + (props.warn ? ' app-kv-warn' : '')} title={props.title}>
      <span>{props.label}</span>
      <b>{props.value == null || props.value === '' ? '—' : props.value}</b>
    </div>
  );
}

export const num = (n: unknown): string => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('ru-RU') : '—');
export const ms = (n: unknown): string => (typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n).toLocaleString('ru-RU')} мс` : '—');

export function dur(msv: unknown): string {
  if (typeof msv !== 'number' || !Number.isFinite(msv)) return '—';
  const s = Math.floor(msv / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  const p2 = (x: number) => String(x).padStart(2, '0');
  return h ? `${h} ч ${p2(m % 60)} мин` : m ? `${m} мин ${p2(s % 60)} с` : `${s} с`;
}

export function ago(t: unknown, now = Date.now()): string {
  if (typeof t !== 'number' || !t) return '—';
  return dur(Math.max(0, now - t)) + ' назад';
}

export function bytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`;
}

/** Время события журнала: ЧЧ:ММ:СС.ммм */
export function stamp(t: number): string {
  const d = new Date(t);
  const p = (x: number, n = 2) => String(x).padStart(n, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
