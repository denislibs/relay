import { searchTerms } from '@relay/protocol';
import { req, termsOf } from './idb';
import type { LocalMessage } from './types';

type TermRow = { term: string; chatId: number; sort: number; key: string };

/** Все строки указателя, у которых слово начинается с w (ключ [term, chatId, sort]). */
const prefix = (w: string) => IDBKeyRange.bound([w, -Infinity, -Infinity], [w + '\uffff', Infinity, Infinity]);

const CHUNK = 64;   // строк сообщений за одну транзакцию чтения
/** Предел строк указателя на слово и на один поиск: «пр» на 50 000 сообщений не читается целиком. */
export const TERMS_CAP = 2000;

/** Сколько строк в диапазоне, но не больше cap: курсор по ключам останавливается на cap (count() прошёл бы весь диапазон). */
function countUpTo(store: IDBObjectStore, range: IDBKeyRange, cap: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const cur = store.openKeyCursor(range);
    cur.onsuccess = () => { if (!cur.result || ++n >= cap) resolve(n); else cur.result.continue(); };
    cur.onerror = () => reject(cur.error);
  });
}

/**
 * Поиск по указателю слов на устройстве (работает без сети). Каждое слово запроса — по началу слова (И для всех):
 * «прив вст» находит «Привет, встречаемся?». По каждому слову считаем строки указателя (не больше cap) и читаем
 * диапазон только самого редкого (тоже не больше cap); кандидаты — новые первыми — проверяем по самой строке
 * сообщения (все слова, не удалено), пока не наберём limit + 1. Полного прохода нет: не больше cap строк на слово
 * при подсчёте, cap строк кандидатов и строки сообщений до limit + 1 совпадений.
 * Если даже самое редкое слово упёрлось в cap (все слова частые, например «пр»), кандидаты — первые cap строк
 * по ключу [term, chatId, sort], то есть не по времени: «новые первыми» — только среди них, hasMore = true
 * (интерфейс дочитает с сервера или по уточнённому запросу). loaded — сообщение из памяти (оно новее строки в IDB).
 */
export async function searchLocal(
  db: IDBDatabase, q: string, o: { chatId?: number; beforeId?: number; limit: number; cap?: number },
  loaded: (chatId: number, key: string) => LocalMessage | undefined,
): Promise<{ list: LocalMessage[]; hasMore: boolean }> {
  const words = searchTerms(q);
  if (!words.length) return { list: [], hasMore: false };
  const cap = o.cap ?? TERMS_CAP;
  const terms = db.transaction('terms').objectStore('terms');
  const counts = await Promise.all(words.map((w) => countUpTo(terms, prefix(w), cap)));
  if (counts.some((n) => n === 0)) return { list: [], hasMore: false };
  const least = Math.min(...counts);
  const rare = words[counts.indexOf(least)];
  const capped = least >= cap;   // кандидаты неполные
  const rows = (await req(db.transaction('terms').objectStore('terms').getAll(prefix(rare), cap))) as TermRow[];
  // одно сообщение может совпасть несколькими словами («прив» → «привет», «приветик»)
  const seen = new Set<string>();
  const cand: TermRow[] = [];
  for (const r of rows) {
    if (o.chatId != null && r.chatId !== o.chatId) continue;
    if (o.beforeId != null && r.sort >= o.beforeId) continue;
    if (seen.has(r.key)) continue;
    seen.add(r.key); cand.push(r);
  }
  cand.sort((x, y) => y.sort - x.sort);
  const fits = (m: LocalMessage | undefined): m is LocalMessage => {
    if (!m || m.id == null || m.deleted) return false;
    const own = termsOf(m);
    return words.every((w) => own.some((t) => t.startsWith(w)));
  };
  const list: LocalMessage[] = [];
  for (let i = 0; i < cand.length && list.length <= o.limit; i += CHUNK) {
    const part = cand.slice(i, i + CHUNK);
    const mem = part.map((r) => loaded(r.chatId, r.key));
    const missing = part.filter((_, j) => !mem[j]);
    const fromDb = new Map<string, LocalMessage | undefined>();
    if (missing.length) {
      const store = db.transaction('messages').objectStore('messages');
      const got = await Promise.all(missing.map((r) => req(store.get(r.key)) as Promise<LocalMessage | undefined>));
      missing.forEach((r, j) => fromDb.set(r.key, got[j]));
    }
    for (let j = 0; j < part.length && list.length <= o.limit; j++) {
      const m = mem[j] ?? fromDb.get(part[j].key);
      if (fits(m)) list.push(m);
    }
  }
  return { list: list.slice(0, o.limit), hasMore: capped || list.length > o.limit };
}
