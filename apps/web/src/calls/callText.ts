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

/**
 * Как назывался звонок (пузырь в ленте и строка в списке чатов), как в клиентах Telegram: исходящий без разговора —
 * «Отменённый», входящий без ответа — «Пропущенный», сброшенный адресатом — «Отклонённый». mine — я звонил.
 */
export function callTitle(c: CallServiceData | undefined, mine: boolean): string {
  const v = !!c?.video;
  const kind = (adj: string) => `${adj} ${v ? 'видеозвонок' : 'звонок'}`;
  if (c?.reason === 'ended') return kind(mine ? 'Исходящий' : 'Входящий');
  if (c?.reason === 'declined') return kind('Отклонённый');
  return kind(mine ? 'Отменённый' : 'Пропущенный');
}

/** Строка в списке чатов и в поиске: название и длительность, если говорили. */
export function callServiceText(c: CallServiceData | undefined, mine: boolean): string {
  const t = callTitle(c, mine);
  return c?.reason === 'ended' && c.duration != null ? `${t} (${callLength(c.duration)})` : t;
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
