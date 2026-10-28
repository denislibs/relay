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

/** Выключены ли уведомления чата сейчас (пока идёт перенос — и по прежнему списку устройства, чтобы значок не мигал). */
export function isMuted(chat: Mutable, now = Date.now()): boolean {
  const u = until(chat);
  if (typeof u === 'number' && (u === 0 || u > now)) return true;
  const id = (chat as { id?: unknown } | null | undefined)?.id;
  return legacy.size > 0 && typeof id === 'number' && alive(legacy.get(id), now);
}

/** То же по id: чат ищем в списке. */
export function isChatMuted(chatId: number, s = getGlobal()): boolean {
  return isMuted(s.chats.find((c) => c.id === chatId) ?? { id: chatId });
}

/** Ближайший будущий срок (навсегда и истёкшие не в счёт); null — ждать нечего. */
export function nextExpiry(chats: readonly Mutable[], now = Date.now()): number | null {
  let min: number | null = null;
  for (const c of chats) {
    const u = until(c);
    if (typeof u === 'number' && u > now && (min === null || u < min)) min = u;
  }
  for (const t of legacy.values()) if (t > now && (min === null || t < min)) min = t;
  return min;
}

// действие движка; привязывает data.ts (там же движок)
let setMute: SetMute = () => Promise.reject(new Error('engine not started'));
export function bindMute(fn: SetMute): void { setMute = fn; }
const send = (chatId: number, muteUntil: number | null) => { setMute(chatId, muteUntil).catch((e) => console.warn('mute:', String(e))); };

/** Выключить на seconds секунд (null — навсегда). */
// явный выбор пользователя важнее прежнего списка: его запись больше не переносим
export function muteChat(chatId: number, seconds: number | null): void { dropLegacy(chatId); send(chatId, seconds ? Date.now() + seconds * 1000 : 0); }
export function unmuteChat(chatId: number): void { dropLegacy(chatId); send(chatId, null); }
/** Переключатель: выключенный — включить, иначе выключить навсегда. */
export function toggleMute(chatId: number): void { if (isChatMuted(chatId)) unmuteChat(chatId); else muteChat(chatId, null); }

/** Звук нескольким сразу: выключить — навсегда (как toggleMute), включить — только тем, у кого выключен. */
export function muteMany(ids: number[], muted: boolean): void {
  for (const id of ids) if (isChatMuted(id) !== muted) { if (muted) muteChat(id, null); else unmuteChat(id); }
}

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
const alive = (t: number | undefined, now: number) => t !== undefined && (t === 0 || t > now);

// Прежний список устройства (relay.muted + сроки relay.mutedUntil): id → до (0 — навсегда). Живёт, пока не перенесён.
let legacy = new Map<number, number>();
let legacyKv: KV | null = null;

/** Прочитать прежние ключи (до первого кадра — значки сразу верные). Истёкшие не берём. */
export function loadLegacyMutes(store?: KV, now = Date.now()): void {
  legacy = new Map(); legacyKv = null;
  let kv: KV, ids: unknown, at: unknown;
  try {
    kv = store ?? localStorage;
    if (kv.getItem(MUTED_KEY) === null && kv.getItem(UNTIL_KEY) === null) return;
    ids = parse(kv, MUTED_KEY); at = parse(kv, UNTIL_KEY);
  } catch { return; }   // приватный режим
  legacyKv = kv;
  const u = at && typeof at === 'object' && !Array.isArray(at) ? at as Record<string, unknown> : {};
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!Number.isInteger(id)) continue;
    const t = u[id];
    if (typeof t === 'number' && t > 0) { if (t > now) legacy.set(id, t); }
    else legacy.set(id, 0);
  }
}

function dropLegacy(chatId: number): void { if (legacy.delete(chatId)) saveLegacy(); }

/** Остаток — обратно в ключи; пусто — ключи удаляем, перенос окончен. */
function saveLegacy(): void {
  if (!legacyKv) return;
  try {
    if (!legacy.size) { legacyKv.removeItem(MUTED_KEY); legacyKv.removeItem(UNTIL_KEY); legacyKv = null; return; }
    legacyKv.setItem(MUTED_KEY, JSON.stringify([...legacy.keys()]));
    legacyKv.setItem(UNTIL_KEY, JSON.stringify(Object.fromEntries([...legacy].filter(([, t]) => t > 0))));
  } catch { /* ok */ }
}

/**
 * Шаг разового переноса в setMute. Ждём первой синхронизации: тогда список чатов — этого аккаунта
 * (ключи были общими для устройства, чужие id сервер отверг бы тостом). Шлём только чаты из списка;
 * которых нет — ждут, пока список не догрузится целиком (chatsComplete), тогда они чужие — молча выбрасываем.
 * Ждать полный список для всех нельзя: страницы диалогов грузятся докруткой, а старые выключенные чаты обычно глубоко.
 * Отказ движка — запись остаётся до следующей попытки (повтор того же setMute безвреден). true — перенос окончен.
 */
export async function migrateLegacyMutes(s = getGlobal(), set: SetMute = setMute, now = Date.now()): Promise<boolean> {
  if (!legacyKv) return true;
  if (!s.chatsLoaded || !s.status.synced) return false;
  const known = new Set(s.chats.map((c) => c.id));
  const todo = [...legacy].filter(([id, t]) => known.has(id) && alive(t, now));
  try { await Promise.all(todo.map(([id, t]) => set(id, t))); } catch (e) { console.warn('mute migration:', String(e)); return false; }
  for (const [id] of todo) legacy.delete(id);
  for (const [id, t] of [...legacy]) if (!alive(t, now) || s.status.chatsComplete) legacy.delete(id);
  saveLegacy();
  return !legacyKv;
}

/** Старт: прочитать прежние ключи и переносить по мере готовности списка чатов. */
export function startMuteMigration(): void {
  loadLegacyMutes();
  if (!legacyKv) return;
  let busy = false, last: unknown[] = [];
  const step = () => {
    const g = getGlobal(), key = [g.chats, g.chatsLoaded, g.status.synced, g.status.chatsComplete];
    if (busy || key.every((v, i) => v === last[i])) return;
    busy = true; last = key;
    void migrateLegacyMutes().then((done) => { busy = false; if (done) off(); else step(); });
  };
  const off = subscribeGlobal(step);
  step();
}
