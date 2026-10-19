// Отключение уведомлений чата на время — как «Отключить звук…» в Telegram Web A (1 ч, 4 ч, 8 ч, 1 день, 3 дня, навсегда).
// Состояние — у чата (chat.muteUntil из движка, общее для всех устройств аккаунта): мс эпохи — до, 0 — навсегда, null — включены.
// Правка уходит операцией setMute (очередь движка, переживает офлайн) и видна сразу.
// Срок вышел — сервер ничего не присылает: один таймер до ближайшего срока будит перерисовку (muteTick).
import { getGlobal, setGlobal, subscribeGlobal } from './global';
import type { KV } from './prefs';

export const MUTE_PRESETS: { label: string; seconds: number | null }[] = [
  { label: 'На 1 час', seconds: 3600 },
  { label: 'На 4 часа', seconds: 4 * 3600 },
  { label: 'На 8 часов', seconds: 8 * 3600 },
  { label: 'На 1 день', seconds: 86400 },
  { label: 'На 3 дня', seconds: 3 * 86400 },
  { label: 'Навсегда', seconds: null },
];

type Mutable = object | null | undefined;   // чат списка (Item) или FolderChat: смотрим только muteUntil
const until = (c: Mutable): unknown => (c as { muteUntil?: unknown } | null | undefined)?.muteUntil;
type SetMute = (chatId: number, muteUntil: number | null) => Promise<unknown>;

/** Выключены ли уведомления чата сейчас. */
export function isMuted(chat: Mutable, now = Date.now()): boolean {
  const u = until(chat);
  return typeof u === 'number' && (u === 0 || u > now);
}

/** То же по id: чат ищем в списке. */
export function isChatMuted(chatId: number, s = getGlobal()): boolean {
  return isMuted(s.chats.find((c) => c.id === chatId));
}

/** Ближайший будущий срок (навсегда и истёкшие не в счёт); null — ждать нечего. */
export function nextExpiry(chats: readonly Mutable[], now = Date.now()): number | null {
  let min: number | null = null;
  for (const c of chats) {
    const u = until(c);
    if (typeof u === 'number' && u > now && (min === null || u < min)) min = u;
  }
  return min;
}

// действие движка; привязывает data.ts (там же движок)
let setMute: SetMute = () => Promise.reject(new Error('engine not started'));
export function bindMute(fn: SetMute): void { setMute = fn; }
const send = (chatId: number, muteUntil: number | null) => { setMute(chatId, muteUntil).catch((e) => console.warn('mute:', String(e))); };

/** Выключить на seconds секунд (null — навсегда). */
export function muteChat(chatId: number, seconds: number | null): void { send(chatId, seconds ? Date.now() + seconds * 1000 : 0); }
export function unmuteChat(chatId: number): void { send(chatId, null); }
/** Переключатель: выключенный — включить, иначе выключить навсегда. */
export function toggleMute(chatId: number): void { if (isChatMuted(chatId)) unmuteChat(chatId); else muteChat(chatId, null); }

let started = false;
/** Один таймер до ближайшего срока; перевзводится при каждой смене списка чатов. */
export function startMuteTimers(): void {
  if (started) return;
  started = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chats: unknown = null, armedAt: number | null = null;
  const arm = () => {
    const at = nextExpiry(getGlobal().chats);
    if (at === armedAt) return;
    clearTimeout(timer); armedAt = at;
    if (at === null) return;
    // setTimeout не дальше ~24.8 суток: дальше — проснёмся и перевзведём
    timer = setTimeout(() => { armedAt = null; setGlobal((s) => ({ muteTick: s.muteTick + 1 })); arm(); }, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
  };
  subscribeGlobal(() => { const c = getGlobal().chats; if (c !== chats) { chats = c; arm(); } });
  chats = getGlobal().chats; arm();
}

const MUTED_KEY = 'relay.muted', UNTIL_KEY = 'relay.mutedUntil';
const parse = (kv: KV, k: string): unknown => { try { return JSON.parse(kv.getItem(k) ?? 'null'); } catch { return null; } };

/**
 * Разовый перенос: раньше выключенные чаты жили в localStorage этого устройства (relay.muted + сроки relay.mutedUntil).
 * Каждый — в setMute (срок в будущем — он, без срока — навсегда, истёкшие — пропускаем), потом ключи удаляем.
 * Отказ движка — ключи остаются до следующего старта (повтор того же setMute безвреден).
 */
export async function migrateLocalMutes(set: SetMute = setMute, store?: KV, now = Date.now()): Promise<void> {
  let kv: KV, ids: unknown, at: unknown;
  try {
    kv = store ?? localStorage;
    if (kv.getItem(MUTED_KEY) === null && kv.getItem(UNTIL_KEY) === null) return;
    ids = parse(kv, MUTED_KEY); at = parse(kv, UNTIL_KEY);
  } catch { return; }   // приватный режим
  const u = at && typeof at === 'object' && !Array.isArray(at) ? at as Record<string, unknown> : {};
  const todo: [number, number][] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!Number.isInteger(id)) continue;
    const t = u[id];
    if (typeof t === 'number' && t > 0) { if (t > now) todo.push([id, t]); }
    else todo.push([id, 0]);
  }
  try { await Promise.all(todo.map(([id, t]) => set(id, t))); } catch (e) { console.warn('mute migration:', String(e)); return; }
  try { kv.removeItem(MUTED_KEY); kv.removeItem(UNTIL_KEY); } catch { /* ok */ }
}
