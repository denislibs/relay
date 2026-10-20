// Глобальный поиск (левая колонка, как в Telegram Web): режим поиска, вкладки, недавние чаты и загрузка
// результатов. Состояние режима — в global (searchOpen, searchTab, search); выдача — на вкладках.
import type { MediaTab } from '@relay/protocol';
import type { MediaHit, PersonHit } from '@relay/sync-engine/src/globalSearch';
import { getGlobal, setGlobal } from './global';
import { callEngine } from './settingsData';

export type SearchTab = 'chats' | MediaTab;
export const SEARCH_TABS: { id: SearchTab; label: string }[] = [
  { id: 'chats', label: 'Чаты' }, { id: 'media', label: 'Медиа' }, { id: 'link', label: 'Ссылки' },
  { id: 'file', label: 'Файлы' }, { id: 'audio', label: 'Музыка' }, { id: 'voice', label: 'Голосовые' },
];

export function openSearch(): void { if (!getGlobal().searchOpen) setGlobal({ searchOpen: true }); }
/** Выход из поиска (стрелка, Esc, «Назад»): запрос, вкладка и выдача сбрасываются, как в Telegram. */
export function closeSearch(): void {
  setGlobal({ searchOpen: false, search: '', searchTab: 'chats' });
  (document.activeElement as HTMLElement | null)?.blur?.();
}
export function setSearchTab(tab: SearchTab): void { setGlobal({ searchTab: tab }); }

// ---------- недавние: чаты, открытые из поиска (на этом устройстве, до 10, как в Telegram) ----------
const RECENT_KEY = 'relay.recentSearch';
let recent: number[] = (() => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(v) ? v.filter(Number.isInteger).slice(0, 10) : []; } catch { return []; } })();
const recentSubs = new Set<() => void>();
function saveRecent(next: number[]): void {
  recent = next;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* приватный режим — только в памяти */ }
  for (const f of recentSubs) f();
}
export const getRecent = (): number[] => recent;
export function subscribeRecent(f: () => void): () => void { recentSubs.add(f); return () => { recentSubs.delete(f); }; }
export function addRecent(chatId: number): void { saveRecent([chatId, ...recent.filter((x) => x !== chatId)].slice(0, 10)); }
export function clearRecent(): void { saveRecent([]); }

// ---------- запросы: через движок (с сетью — сервер, без сети — с устройства, см. sync-engine/src/globalSearch.ts) ----------
export type { MediaHit, PersonHit } from '@relay/sync-engine/src/globalSearch';

/** Вкладка медиа по всем чатам: страница новых сверху. before — next прошлой страницы (без сети движок отдаёт границу
 *  просмотренного), если его нет — id последнего показанного. Пустая страница без сети при hasMore — предел работы
 *  за страницу: просим следующую сразу (не больше нескольких раз), чтобы интерфейсу было что показать. */
export async function searchGlobalMedia(kind: MediaTab, q: string, before?: number): Promise<{ hits: MediaHit[]; hasMore: boolean; next?: number }> {
  for (let i = 0; ; i++) {
    const r = await callEngine<{ hits: MediaHit[]; hasMore: boolean; next?: number }>({ type: 'searchMedia', kind, q, ...(before ? { before } : {}) });
    const next = r.next ?? r.hits[r.hits.length - 1]?.message.id;
    if (r.hits.length || !r.hasMore || next == null || i >= 5) return { ...r, ...(next != null ? { next } : {}) };
    before = next;
  }
}

export const searchPeople = (q: string) => callEngine<PersonHit[]>({ type: 'searchPeople', q });

/** «Частые собеседники» — личные чаты; ответ кэшируем на минуту (как Top people в Telegram). */
let top: { at: number; ids: Promise<number[]> } | null = null;
export function topChats(): Promise<number[]> {
  if (!top || Date.now() - top.at > 60_000) {
    top = { at: Date.now(), ids: callEngine<number[]>({ type: 'topChats' }).catch(() => { top = null; return []; }) };
  }
  return top.ids;
}

/** «Октябрь 2026» — заголовок месяца в выдаче. */
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export function monthLabel(iso: string): string { const d = new Date(iso); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
export const monthKey = (iso: string): string => { const d = new Date(iso); return d.getFullYear() + '-' + d.getMonth(); };
