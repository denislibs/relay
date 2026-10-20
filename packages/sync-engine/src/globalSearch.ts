// Глобальный поиск левой колонки без сети: люди (профили и контакты на устройстве), вкладки медиа по всем чатам
// (IndexedDB, индекс byTab) и «частые собеседники». С сетью движок спрашивает сервер (/search/people, /search/media,
// /search/top), здесь — то, что отвечаем, когда сети нет или запрос не удался.
import { MEDIA_TABS, type MediaTab, type Message, type ProfilePhoto, type PublicUser } from '@relay/protocol';
import { tabsOf } from './derive';
import { contactName } from './contacts';
import { chatTitle, displayName } from './names';
import type { Store } from './store';
import type { LocalMessage } from './types';

export interface PersonHit { id: number; name: string; username: string | null; photo: ProfilePhoto | null; chatId: number | null }
export interface MediaHit { message: Message; chatTitle: string | null; chatKind: 'direct' | 'group' }

/** Слова для сравнения — как searchTerms (NFC, нижний регистр, ё → е, по не-буквам), но и однобуквенные: «а» ищет «Анна». */
export function nameWords(text: string): string[] {
  return text.normalize('NFC').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 64);
}
/** Каждое слово запроса — начало какого-то слова текста. */
const fitsWords = (q: string[], own: string[]) => q.every((w) => own.some((t) => t.startsWith(w)));

type ContactLike = { firstName: string; lastName: string; user?: PublicUser };

/**
 * Люди на устройстве: профили (users) и контакты (с ещё не подтверждёнными). Совпадение — каждое слово запроса
 * начинает слово имени (как зритель его видит, и собственного имени — как на сервере) или @имени. Себя и системных
 * не показываем. chatId — личный чат с человеком; фото — из профиля. Порядок: контакты, затем по имени.
 */
export function localPeople(store: Store, contacts: ReadonlyMap<number, ContactLike>, meId: number, raw: string, limit = 20): PersonHit[] {
  const q = nameWords(raw.trim().replace(/^@/, ''));
  if (!q.length) return [];
  const direct = new Map<number, number>();
  for (const c of store.chats.values()) if (c.kind === 'direct' && c.peerId != null && !direct.has(c.peerId)) direct.set(c.peerId, c.id);
  const ids = new Set<number>([...store.users.rows.keys(), ...contacts.keys()]);
  const out: (PersonHit & { contact: boolean })[] = [];
  for (const id of ids) {
    if (id === meId) continue;
    const u = store.users.get(id) ?? contacts.get(id)?.user, c = contacts.get(id);
    if (u?.system) continue;
    const name = displayName(store, id) || (c ? contactName(c) : '');
    if (!name) continue;
    const username = u?.username ?? null;
    const own = [...nameWords(name), ...nameWords(u?.publicName ?? u?.name ?? ''), ...(username ? [username.toLowerCase()] : [])];
    if (!fitsWords(q, own)) continue;
    out.push({ id, name, username, photo: u?.photo ?? null, chatId: direct.get(id) ?? null, contact: !!c });
  }
  out.sort((a, b) => Number(b.contact) - Number(a.contact) || a.name.localeCompare(b.name, 'ru'));
  return out.slice(0, limit).map(({ contact: _c, ...p }) => p);
}

/** Сколько строк одного чата (на одну основную вкладку) просматриваем за страницу: предел работы без сети. */
export const MEDIA_SCAN_CAP = 400;

/**
 * Вкладка медиа по всем чатам с устройства: страница новых сверху (по id — он общий для всех чатов, как на сервере),
 * before — id последнего показанного. У каждого чата — курсор по byTab [chatId, tab, sort] от новых (ниже before):
 * берём не больше limit + 1 подходящих (вкладка по mediaTabs, не удалено, запрос — по началу слов текста, имени
 * файла, названия и исполнителя) и смотрим не больше MEDIA_SCAN_CAP строк. Ссылки бывают и в подписях файлов —
 * для «ссылок» курсоры по всем основным вкладкам. Затем слияние по id; hasMore — где-то осталось ещё.
 */
export async function localMedia(db: IDBDatabase, store: Store, kind: MediaTab, raw: string, before: number | undefined, limit = 40): Promise<{ hits: MediaHit[]; hasMore: boolean }> {
  const q = nameWords(raw.trim());
  const upper = before ?? Infinity;
  const mains: readonly MediaTab[] = kind === 'link' ? MEDIA_TABS : [kind];
  const fits = (m: LocalMessage): boolean => {
    if (m.id == null || !tabsOf(m).includes(kind)) return false;
    if (!q.length) return true;
    const a = m.attachment as { name?: string; title?: string | null; performer?: string | null } | null;
    const text = kind === 'link' ? m.body : [m.body, a?.name, a?.title, a?.performer].filter(Boolean).join(' ');
    return fitsWords(q, nameWords(text));
  };
  let more = false;
  const found: LocalMessage[] = [];
  const index = db.transaction('messages').objectStore('messages').index('byTab');
  const scan = (chatId: number, tab: MediaTab) => new Promise<void>((resolve, reject) => {
    let seen = 0, got = 0;
    const r = index.openCursor(IDBKeyRange.bound([chatId, tab, -Infinity], [chatId, tab, upper], false, true), 'prev');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const cur = r.result;
      if (!cur) return resolve();
      if (++seen > MEDIA_SCAN_CAP || got > limit) { more = true; return resolve(); }
      const row = cur.value as LocalMessage;
      const m = store.loadedMessage(chatId, row.key) ?? row;   // в памяти — новее строки
      if (fits(m)) { found.push(m); got++; }
      cur.continue();
    };
  });
  await Promise.all([...store.chats.keys()].flatMap((chatId) => mains.map((t) => scan(chatId, t))));
  const uniq = new Map<string, LocalMessage>();
  for (const m of found) uniq.set(m.key, m);
  const list = [...uniq.values()].sort((a, b) => b.id! - a.id!);
  const page = list.slice(0, limit);
  return {
    hits: page.map((m) => {
      const c = store.chats.get(m.chatId);
      return { message: toMessage(m), chatTitle: c ? chatTitle(store, c) : null, chatKind: c?.kind ?? 'direct' };
    }),
    hasMore: more || list.length > limit,
  };
}

/** Строка кэша → сообщение протокола (без полей устройства). */
function toMessage(m: LocalMessage): Message {
  const { key: _k, sort: _s, status: _st, progress: _p, ...rest } = m as LocalMessage & { progress?: unknown; tab?: unknown };
  delete (rest as { tab?: unknown }).tab;
  return { ...rest, id: m.id! } as unknown as Message;
}

/** «Частые собеседники» без сети: личные чаты (кроме служебного) по времени последнего сообщения. */
export function localTop(store: Store, limit = 10): number[] {
  return [...store.chats.values()]
    .filter((c) => c.kind === 'direct' && !c.system && c.peerId != null && c.last)
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0))
    .slice(0, limit).map((c) => c.id);
}
