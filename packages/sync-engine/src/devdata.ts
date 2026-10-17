import { trimBodies } from './devlog';

/**
 * Раздел «Для разработчиков» → «Данные»: просмотр сторов IDB постранично, только чтение.
 * Тела сообщений и превью обрезаются так же, как в журнале (trimBodies): экран можно показать, не показывая переписку.
 */
export type DevStore = 'chats' | 'messages' | 'meta' | 'outbox' | 'pendingReads' | 'users' | 'ops';
export interface IdbReadArgs {
  store: DevStore;
  /** messages: сообщения одного чата (индекс byChat, по sort) */
  chatId?: number;
  /** поиск по ключу: подстрока строкового ключа */
  q?: string;
  offset?: number;
  limit?: number;
}
export interface IdbReadResult { rows: { key: string; value: object }[]; offset: number; more: boolean }

const STORES: DevStore[] = ['chats', 'messages', 'meta', 'outbox', 'pendingReads', 'users', 'ops'];
const MAX = 200;

export function readStore(db: IDBDatabase, a: IdbReadArgs): Promise<IdbReadResult> {
  if (!STORES.includes(a.store) || !db.objectStoreNames.contains(a.store)) return Promise.reject(new Error('bad_store'));
  const limit = Math.max(1, Math.min(MAX, a.limit ?? 100));
  const offset = Math.max(0, a.offset ?? 0);
  const q = a.q?.trim() || '';
  return new Promise((resolve, reject) => {
    const os = db.transaction(a.store).objectStore(a.store);
    const src: IDBObjectStore | IDBIndex = a.store === 'messages' && a.chatId != null ? os.index('byChat') : os;
    const range = a.store === 'messages' && a.chatId != null ? IDBKeyRange.bound([a.chatId, -Infinity], [a.chatId, Infinity]) : undefined;
    const r = src.openCursor(range);
    const rows: IdbReadResult['rows'] = [];
    let skipped = 0, advanced = !!q || offset === 0;
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const c = r.result;
      if (!c) { resolve({ rows, offset, more: false }); return; }
      // без поиска — сразу к offset; с поиском offset считается по найденным
      if (!advanced) { advanced = true; c.advance(offset); return; }
      const key = String(c.primaryKey);
      if (!q || key.includes(q)) {
        if (q && skipped < offset) skipped++;
        else {
          if (rows.length === limit) { resolve({ rows, offset, more: true }); return; }
          rows.push({ key, value: trimBodies(c.value as object) });
        }
      }
      c.continue();
    };
  });
}
