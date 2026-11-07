import type { CallEndReason, ProfilePhoto } from '@relay/protocol';
import { getGlobal, setGlobal } from '../global';
import { dayKey } from '../ui/format';
import { callLength } from './callText';

/**
 * Список «Звонки» (этап 2 docs/plans/2026-11-07-relay-calls-features.md): строки с сервера (GET /calls), группы
 * подряд идущих одинаковых звонков, бейдж новых пропущенных у пункта меню.
 */

export type CallRow = {
  id: number; chatId: number; peerId: number; name: string; photo: ProfilePhoto | null;
  outgoing: boolean; video: boolean; reason: CallEndReason; duration?: number; at: string;
};

/** Пропущенный глазами адресата (как на сервере, domain/callsList.ts). */
const MISSED: CallEndReason[] = ['missed', 'cancelled', 'busy'];
export const isMissed = (r: CallRow): boolean => !r.outgoing && MISSED.includes(r.reason);

export type CallGroup = { key: string; rows: CallRow[] };

/**
 * Подряд идущие звонки одного человека одного вида за один день — одна строка «Анна (3)», как в Telegram.
 * Вид: направление и «пропущен / нет» (пропущенный входящий не сливается с принятым).
 */
export function groupCalls(rows: CallRow[]): CallGroup[] {
  const out: CallGroup[] = [];
  for (const r of rows) {
    const g = out[out.length - 1], h = g?.rows[0];
    if (h && h.peerId === r.peerId && h.outgoing === r.outgoing && isMissed(h) === isMissed(r) && dayKey(h.at) === dayKey(r.at)) g.rows.push(r);
    else out.push({ key: 'c' + r.id, rows: [r] });
  }
  return out;
}

/** Подпись под именем: направление и вид («Исходящий», «Пропущенный видеозвонок»), у одиночного разговора — длительность. */
export function groupText(g: CallGroup): string {
  const r = g.rows[0];
  const kind = isMissed(r) ? 'Пропущенный' : r.reason === 'declined' ? 'Отклонённый' : r.outgoing ? 'Исходящий' : 'Входящий';
  const base = r.video ? `${kind} видеозвонок` : kind;
  return g.rows.length === 1 && r.reason === 'ended' && r.duration != null ? `${base}, ${callLength(r.duration)}` : base;
}

export const cursorOf = (r: CallRow): string => `${r.at}_${r.id}`;

export async function fetchCalls(o: { before?: CallRow; missed?: boolean } = {}): Promise<{ calls: CallRow[]; more: boolean }> {
  const q = new URLSearchParams();
  if (o.before) q.set('before', cursorOf(o.before));
  if (o.missed) q.set('missed', '1');
  const r = await fetch('/calls' + (q.size ? '?' + q : ''), { credentials: 'include' });
  if (!r.ok) throw new Error('calls ' + r.status);
  return r.json() as Promise<{ calls: CallRow[]; more: boolean }>;
}

/** Бейдж «Звонки»: с сервера при старте и после переподключения; новый пропущенный — +1 сразу (callController). */
export async function loadUnseenCalls(): Promise<void> {
  try {
    const r = await fetch('/calls/unseen', { credentials: 'include' });
    if (r.ok) setGlobal({ callsUnseen: ((await r.json()) as { count: number }).count });
  } catch { /* нет сети — бейдж придёт позже */ }
}
export function noteMissedCall(): void { setGlobal({ callsUnseen: Math.min(99, getGlobal().callsUnseen + 1) }); }
export function markCallsSeen(): void {
  if (!getGlobal().callsUnseen) return;
  setGlobal({ callsUnseen: 0 });
  void fetch('/calls/seen', { method: 'POST', credentials: 'include' }).catch(() => {});
}
