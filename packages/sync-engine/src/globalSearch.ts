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
 * Люди на устройстве — те, кого зритель видит (как на сервере): контакты (с ещё не подтверждёнными), собеседники
 * личных чатов и участники групп из members; имя и фото — из профилей (users). Совпадение — каждое слово запроса
 * начинает слово имени (как зритель его видит, и собственного имени — как на сервере) или @имени. Себя и системных
 * не показываем. chatId — личный чат с человеком; фото — из профиля. Порядок: контакты, затем по имени.
 */
export function localPeople(store: Store, contacts: ReadonlyMap<number, ContactLike>, meId: number, raw: string, limit = 20): PersonHit[] {
  const q = nameWords(raw.trim().replace(/^@/, ''));
  if (!q.length) return [];
  // кого зритель видит, как на сервере: контакты, собеседники личных чатов и участники его групп (что есть на устройстве)
  const direct = new Map<number, number>();
  const ids = new Set<number>(contacts.keys());
  for (const c of store.chats.values()) {
    if (c.kind === 'direct') { if (c.peerId != null) { ids.add(c.peerId); if (!direct.has(c.peerId)) direct.set(c.peerId, c.id); } }
    else for (const m of store.members.list(c.id)) ids.add(m.userId);
  }
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

/** Предел работы без сети на одну страницу: строк индекса byTab на все чаты вместе. */
export const MEDIA_BUDGET = 6000;
/** Строк одного курсора за круг: чаты продвигаются по очереди, ни один не съедает весь предел. */
const MEDIA_CHUNK = 100;

/** Курсор одного чата по одной основной вкладке: stop — sort последней просмотренной строки (ниже не смотрели). */
type Scan = { chatId: number; tab: MediaTab; stop: number; done: boolean; hits: number };

/**
 * Вкладка медиа по всем чатам с устройства: страница новых сверху (по id — он общий для всех чатов, как на сервере),
 * before — с какого id (не включая) продолжать. У каждого чата — курсор по byTab [chatId, tab, sort] от новых:
 * подходящее — по mediaTabs (не удалено), запрос — по началу слов текста, имени файла, названия и исполнителя.
 * Ссылки бывают и в подписях файлов — для «ссылок» курсоры по всем основным вкладкам; чаты и вкладки, где по
 * счётчикам (mediaCounts) пусто, не открываем. Курсоры идут кругами по MEDIA_CHUNK строк, все вместе — не больше
 * MEDIA_BUDGET строк за страницу (первую строку каждый курсор читает всегда — иначе страница не продвинулась бы).
 * Граница (frontier) — самый высокий stop недочитанного курсора: от неё и выше просмотрено всё (stop — уже
 * просмотренная строка), ниже — не всё, поэтому в ответ идёт только найденное не ниже неё; next = граница, а before
 * не включает себя — следующая страница начнётся сразу под ней. Круги идут, пока страница не полна, предел не исчерпан и есть недочитанные
 * курсоры, у которых меньше limit + 1 находок. next — откуда продолжать (последнее показанное, если находок больше
 * limit, иначе граница); его же интерфейс передаёт следующим before. Нет next — дальше пусто.
 */
export async function localMedia(db: IDBDatabase, store: Store, kind: MediaTab, raw: string, before: number | undefined, limit = 40, budget = MEDIA_BUDGET):
  Promise<{ hits: MediaHit[]; hasMore: boolean; next?: number; scanned: number }> {
  const q = nameWords(raw.trim());
  const upper = before ?? Infinity;
  const fits = (m: LocalMessage): boolean => {
    if (m.id == null || !tabsOf(m).includes(kind)) return false;
    if (!q.length) return true;
    const a = m.attachment as { name?: string; title?: string | null; performer?: string | null } | null;
    const text = kind === 'link' ? m.body : [m.body, a?.name, a?.title, a?.performer].filter(Boolean).join(' ');
    return fitsWords(q, nameWords(text));
  };
  const scans: Scan[] = [];
  for (const c of store.chats.values()) {
    const counts = c.mediaCounts;
    if (counts?.[kind] === 0) continue;
    const mains: readonly MediaTab[] = kind === 'link' ? MEDIA_TABS.filter((t) => t === 'link' || counts?.[t] !== 0) : [kind];
    for (const tab of mains) scans.push({ chatId: c.id, tab, stop: upper, done: false, hits: 0 });
  }
  const found = new Map<string, LocalMessage>();
  let scanned = 0, first = true;
  const step = (index: IDBIndex, sc: Scan, n: number) => new Promise<void>((resolve, reject) => {
    let read = 0;
    const r = index.openCursor(IDBKeyRange.bound([sc.chatId, sc.tab, -Infinity], [sc.chatId, sc.tab, sc.stop], false, true), 'prev');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const cur = r.result;
      if (!cur) { sc.done = true; return resolve(); }
      if (read >= n) return resolve();   // stop — последняя просмотренная; эта строка — в следующий круг
      read++; scanned++;
      const row = cur.value as LocalMessage;
      sc.stop = row.sort;
      const m = store.loadedMessage(sc.chatId, row.key) ?? row;   // в памяти — новее строки
      if (fits(m)) { found.set(m.key, m); sc.hits++; }
      if (sc.hits > limit) return resolve();
      cur.continue();
    };
  });
  const frontier = () => scans.reduce((f, sc) => (sc.done ? f : Math.max(f, sc.stop)), -Infinity);
  // строка на самой границе уже просмотрена — она в ответе
  const above = () => [...found.values()].filter((m) => m.id! >= frontier()).sort((a, b) => b.id! - a.id!);
  for (;;) {
    const active = scans.filter((sc) => !sc.done && sc.hits <= limit);
    const left = budget - scanned;
    if (!active.length || (!first && left <= 0)) break;
    const share = Math.min(MEDIA_CHUNK, Math.max(first ? 1 : 0, Math.floor(left / active.length)));
    if (share <= 0) {
      // предел почти исчерпан: остаток — первым по очереди (граница выше всех — её и двигаем)
      active.sort((a, b) => b.stop - a.stop);
      const index = db.transaction('messages').objectStore('messages').index('byTab');
      await step(index, active[0], left);
    } else {
      const index = db.transaction('messages').objectStore('messages').index('byTab');
      await Promise.all(active.map((sc) => step(index, sc, share)));
    }
    first = false;
    if (above().length >= limit) break;
  }
  const list = above(), page = list.slice(0, limit), f = frontier();
  const next = list.length > limit ? page[page.length - 1].id! : f > -Infinity ? f : undefined;
  return {
    hits: page.map((m) => {
      const c = store.chats.get(m.chatId);
      return { message: toMessage(m), chatTitle: c ? chatTitle(store, c) : null, chatKind: c?.kind ?? 'direct' };
    }),
    hasMore: next !== undefined, ...(next !== undefined ? { next } : {}), scanned,
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
