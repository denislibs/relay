// Отключение уведомлений чата на время — как «Отключить звук…» в Telegram Web A (1 ч, 4 ч, 8 ч, 1 день, 3 дня, навсегда).
// Как и раньше — только на этом устройстве: список выключенных (relay.muted) + сроки (relay.mutedUntil, мс).
// Срок вышел — чат включается сам (таймер; после перезагрузки — проверка при старте).
import { getGlobal } from './global';
import { loadMuted, toggleMuted } from './ui/Info';

const UNTIL_KEY = 'relay.mutedUntil';
export const MUTE_PRESETS: { label: string; seconds: number | null }[] = [
  { label: 'На 1 час', seconds: 3600 },
  { label: 'На 4 часа', seconds: 4 * 3600 },
  { label: 'На 8 часов', seconds: 8 * 3600 },
  { label: 'На 1 день', seconds: 86400 },
  { label: 'На 3 дня', seconds: 3 * 86400 },
  { label: 'Навсегда', seconds: null },
];

function loadUntil(): Record<string, number> { try { return JSON.parse(localStorage.getItem(UNTIL_KEY) ?? '{}'); } catch { return {}; } }
function saveUntil(m: Record<string, number>): void { try { localStorage.setItem(UNTIL_KEY, JSON.stringify(m)); } catch { /* приватный режим */ } }

const timers = new Map<number, ReturnType<typeof setTimeout>>();
function plan(chatId: number, at: number): void {
  clearTimeout(timers.get(chatId));
  // setTimeout не дальше ~24.8 суток — длиннее не бывает (3 дня), но на всякий случай режем
  // срок мог смениться (выключили навсегда в профиле) — включаем, только если он ещё тот же
  timers.set(chatId, setTimeout(() => { if (loadUntil()[chatId] === at) unmuteChat(chatId); }, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1)));
}

export function isMuted(chatId: number): boolean { return getGlobal().muted.includes(chatId); }

/** Выключить на seconds секунд (null — навсегда). */
export function muteChat(chatId: number, seconds: number | null): void {
  const until = loadUntil();
  if (seconds) { until[chatId] = Date.now() + seconds * 1000; plan(chatId, until[chatId]); }
  else { delete until[chatId]; clearTimeout(timers.get(chatId)); timers.delete(chatId); }
  saveUntil(until);
  if (!isMuted(chatId)) toggleMuted(chatId, getGlobal().muted);
}

export function unmuteChat(chatId: number): void {
  const until = loadUntil();
  delete until[chatId]; saveUntil(until);
  clearTimeout(timers.get(chatId)); timers.delete(chatId);
  if (isMuted(chatId)) toggleMuted(chatId, getGlobal().muted);
}

/** При старте: вышедшие сроки — включить, остальные — поставить таймеры. */
export function startMuteTimers(): void {
  const until = loadUntil(), muted = loadMuted();
  for (const [id, at] of Object.entries(until)) {
    const chatId = Number(id);
    if (!muted.includes(chatId)) { delete until[id]; continue; }
    if (at <= Date.now()) unmuteChat(chatId); else plan(chatId, at);
  }
  saveUntil(until);
}
