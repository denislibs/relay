// Каталог реакций (как в Telegram): картинки и анимации с сервера, порядок — порядок Telegram. Грузится один раз за
// сессию; до ответа (и без ассетов на сервере) плашки и панель показывают эмодзи глифами.
import { emojiKey, type ReactionAsset } from '@relay/protocol';
import { useEffect, useState } from 'preact/hooks';

/** Быстрые реакции, пока каталога нет (или сервер без ассетов). */
const FALLBACK = ['👍', '❤', '🔥', '🥰', '👏', '😁', '🤔'];
const RECENT_KEY = 'relay.reactions.recent';
const RECENT_MAX = 32;

let items: ReactionAsset[] = [];
let byKey = new Map<string, ReactionAsset>();
let version = 0;
let started = false;
const listeners = new Set<() => void>();

function set(next: ReactionAsset[]): void {
  items = next;
  byKey = new Map(next.map((r) => [r.key, r]));
  version++;
  for (const fn of listeners) fn();
}

/** Загрузить каталог (идемпотентно). Ошибка сети — остаёмся на глифах, повтор при следующем вызове. */
export function loadReactions(): void {
  if (started) return;
  started = true;
  fetch('/reactions', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() as Promise<{ items: ReactionAsset[] }> : Promise.reject(new Error(String(r.status)))))
    .then((j) => set(j.items.filter((r) => !r.inactive)), () => { started = false; });
}

export const reactionCatalog = (): ReactionAsset[] => items;
export const reactionByKey = (key: string): ReactionAsset | undefined => byKey.get(key);
/** Адрес картинки реакции по эмодзи (в любой форме записи), нет — undefined (глиф). */
export const reactionIcon = (emoji: string): string | undefined => byKey.get(emojiKey(emoji))?.static;

/** Версия каталога — для перерисовки строк ленты, когда он пришёл. */
export function useReactionCatalog(): number {
  const [v, setV] = useState(version);
  useEffect(() => {
    loadReactions();
    const fn = () => setV(version);
    listeners.add(fn);
    if (v !== version) fn();
    return () => { listeners.delete(fn); };
  }, []);
  return v;
}

export function recentReactions(): string[] {
  try { return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]).map(emojiKey); } catch { return []; }
}
export function pushRecentReaction(emoji: string): void {
  const k = emojiKey(emoji);
  const list = [k, ...recentReactions().filter((x) => x !== k)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* приватный режим */ }
}

/**
 * Реакции для панели и пикера: недавние вперёд, затем каталог; allowed — набор чата («некоторые»), остальные не
 * показываем. n — сколько взять (панель — 7). Без каталога — FALLBACK.
 */
export function quickReactions(allowed?: readonly string[] | null, n = 7): string[] {
  const base = items.length ? items.map((r) => r.key) : FALLBACK;
  const ok = allowed ? new Set(allowed.map(emojiKey)) : null;
  const out: string[] = [];
  for (const k of [...recentReactions(), ...base, ...(ok ? [...ok] : [])]) {
    if (ok && !ok.has(k)) continue;
    if (!ok && !items.length && !FALLBACK.includes(k)) continue;   // без каталога недавние вне FALLBACK не показываем
    if (ok || byKey.has(k) || !items.length) if (!out.includes(k)) out.push(k);
    if (out.length >= n) break;
  }
  return out;
}
