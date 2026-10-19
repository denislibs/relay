import { searchTerms } from '@relay/protocol';
import type { LocalMessage } from './types';

import { SCHEMA_VERSION, STORES, upgrade, type StoreName } from './schema';

export type { StoreName };

/**
 * onVersionChange: другая вкладка (новая сборка) открывает базу более новой версии. Соединение закрываем сразу,
 * иначе её обновление ждёт нас вечно; движок после этого мёртв — хост просит вкладки перезагрузиться.
 */
export function openDb(name: string, opts: { onVersionChange?: () => void; version?: number } = {}): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, opts.version ?? SCHEMA_VERSION);
    // старую версию держит открытой вкладка прежней сборки: ждём, пока она закроется (её onversionchange)
    r.onblocked = () => console.warn(`idb ${name}: upgrade to v${opts.version ?? SCHEMA_VERSION} is waiting for other tabs to close the old version`);
    r.onupgradeneeded = (e) => upgrade(r.result, e.oldVersion, r.transaction!);
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); opts.onVersionChange?.(); };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function getAll<T>(db: IDBDatabase, store: StoreName): Promise<T[]> {
  return req(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
}

export function getByChat(db: IDBDatabase, chatId: number): Promise<LocalMessage[]> {
  const index = db.transaction('messages').objectStore('messages').index('byChat');
  return req(index.getAll(IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity]))) as Promise<LocalMessage[]>;
}

export interface WriteBatch {
  put: Partial<Record<StoreName, unknown[]>>;
  del: Partial<Record<StoreName, IDBValidKey[]>>;
}

/** Одна транзакция на всю пачку: данные и lastSeq записываются атомарно. */
export function write(db: IDBDatabase, batch: WriteBatch): Promise<void> {
  const dropChats = batch.del.chats ?? [];
  const names = STORES.filter((s) => (batch.put[s]?.length ?? 0) > 0 || (batch.del[s]?.length ?? 0) > 0 || ((s === 'messages' || s === 'terms') && dropChats.length > 0));
  if (!names.length) return Promise.resolve();
  const t = db.transaction(names, 'readwrite');
  for (const s of names) {
    const os = t.objectStore(s);
    for (const v of batch.put[s] ?? []) os.put(v);
    for (const k of batch.del[s] ?? []) os.delete(k);
  }
  // удалённый чат — и все его сообщения (по индексу byChat), той же транзакцией
  if (dropChats.length) {
    const index = t.objectStore('messages').index('byChat');
    for (const id of dropChats) {
      const cur = index.openCursor(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        const m = c.value as LocalMessage;
        if (m.id != null && !m.deleted) for (const term of searchTerms(m.body)) t.objectStore('terms').delete([term, m.chatId, m.sort]);   // слова удалённого чата
        c.delete(); c.continue();
      };
    }
  }
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Файл неотправленного сообщения: лежит в IDB, чтобы отправка пережила офлайн и перезагрузку. */
export function putBlob(db: IDBDatabase, clientId: string, blob: Blob): Promise<unknown> {
  return req(db.transaction('blobs', 'readwrite').objectStore('blobs').put({ clientId, blob }));
}
export async function getBlob(db: IDBDatabase, clientId: string): Promise<Blob | null> {
  const row = (await req(db.transaction('blobs').objectStore('blobs').get(clientId))) as { blob: Blob } | undefined;
  return row?.blob ?? null;
}
export function delBlob(db: IDBDatabase, clientId: string): Promise<unknown> {
  return req(db.transaction('blobs', 'readwrite').objectStore('blobs').delete(clientId));
}
