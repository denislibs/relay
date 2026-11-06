import type { CallServiceData } from '@relay/protocol';
import type { CallFailure, CallView } from './callController';

/** 75 → «1:15», 3725 → «1:02:05». */
export function callClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/** Длительность для истории: «12 сек», «3 мин», «1 ч 05 мин». */
export function callLength(sec: number): string {
  if (sec < 60) return `${sec} сек`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
}

/** Строка истории звонка в чате и в списке: mine — я звонил. */
export function callServiceText(c: CallServiceData | undefined, mine: boolean): string {
  if (!c) return 'Звонок';
  const what = c.video ? 'видеозвонок' : 'звонок';
  const What = c.video ? 'Видеозвонок' : 'Звонок';
  if (c.reason === 'ended' && c.duration != null) return `${mine ? 'Исходящий' : 'Входящий'} ${what} · ${callLength(c.duration)}`;
  if (mine) {
    if (c.reason === 'declined') return `${What} отклонён`;
    if (c.reason === 'busy') return 'Абонент занят';
    if (c.reason === 'cancelled') return `Отменённый ${what}`;
    if (c.reason === 'missed') return `${What} без ответа`;
    if (c.reason === 'failed') return `${What} не удался`;
    return `Исходящий ${what}`;
  }
  if (c.reason === 'declined') return `Отклонённый ${what}`;
  if (c.reason === 'failed') return `${What} не удался`;
  if (c.reason === 'missed' || c.reason === 'cancelled' || c.reason === 'busy') return `Пропущенный ${what}`;
  return `Входящий ${what}`;
}

/** Строка состояния под именем на экране звонка. */
export function callStatus(v: CallView, now: number): string {
  switch (v.phase) {
    case 'incoming': return v.video ? 'Входящий видеозвонок' : 'Входящий звонок';
    case 'requesting': return 'Соединение…';
    case 'calling': return 'Звоним…';
    case 'ringing': return 'Звонок…';
    case 'exchanging': return 'Обмен ключами…';
    case 'connecting': return 'Соединение…';
    case 'active': return callClock(v.startedAt ? (now - v.startedAt) / 1000 : 0);
    case 'reconnecting': return 'Переподключение…';
    case 'ended': return endText(v.reason, v.duration);
  }
}

function endText(r: CallFailure | null, duration?: number): string {
  switch (r) {
    case 'busy': return 'Абонент занят';
    case 'declined': return 'Звонок отклонён';
    case 'missed': return 'Нет ответа';
    case 'unavailable': return 'Пользователь недоступен';
    case 'in_call': return 'Уже идёт звонок';
    case 'flood': return 'Слишком много звонков, подождите';
    case 'offline': return 'Нет сети';
    case 'no_mic': return 'Нет доступа к микрофону';
    case 'security': return 'Звонок прерван: ошибка безопасности';
    case 'failed': return 'Не удалось соединиться';
    case 'gone': return 'Звонок уже завершён';
    default: return duration ? `Звонок завершён · ${callClock(duration)}` : 'Звонок завершён';
  }
}
