import { searchTerms } from '@relay/protocol';
import { termsOf } from './idb';
import type { LocalMessage } from './types';

type TermRow = { term: string; chatId: number; sort: number; key: string };

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

/** Все строки указателя, у которых слово начинается с w (ключ [term, chatId, sort]). */
const prefix = (w: string) => IDBKeyRange.bound([w, -Infinity, -Infinity], [w + '￿', Infinity, Infinity]);

const CHUNK = 64;   // строк сообщений за одну транзакцию чтения

/**
 * Поиск по указателю слов на устройстве (работает без сети). Каждое слово запроса — по началу слова (И для всех):
 * «прив вст» находит «Привет, встречаемся?». Сначала считаем строки указателя по каждому слову (count по диапазону)
 * и берём только самое редкое; кандидаты — новые первыми — проверяем по самой строке сообщения (все слова, не удалено),
 * пока не наберём limit + 1. Цена: одно чтение диапазона самого редкого слова + чтение строк до limit + 1 совпадений;
 * полного прохода по сообщениям нет. loaded — сообщение из памяти (оно новее строки в IDB).
 */
export async function searchLocal(
  db: IDBDatabase, q: string, o: { chatId?: number; beforeId?: number; limit: number },
  loaded: (chatId: number, key: string) => LocalMessage | undefined,
): Promise<{ list: LocalMessage[]; hasMore: boolean }> {
  const words = searchTerms(q);
  if (!words.length) return { list: [], hasMore: false };
  const terms = db.transaction('terms').objectStore('terms');
  const counts = await Promise.all(words.map((w) => req(terms.count(prefix(w)))));
  if (counts.some((n) => n === 0)) return { list: [], hasMore: false };
  const rare = words[counts.indexOf(Math.min(...counts))];
  const rows = (await req(db.transaction('terms').objectStore('terms').getAll(prefix(rare)))) as TermRow[];
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
  return { list: list.slice(0, o.limit), hasMore: list.length > o.limit };
}
