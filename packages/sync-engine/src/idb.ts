import type { LocalMessage } from './types';

export type StoreName = 'chats' | 'messages' | 'outbox' | 'pendingReads' | 'meta';
const STORES: StoreName[] = ['chats', 'messages', 'outbox', 'pendingReads', 'meta'];
const VERSION = 1;

export function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('chats', { keyPath: 'id' });
      db.createObjectStore('messages', { keyPath: 'key' }).createIndex('byChat', ['chatId', 'sort']);
      db.createObjectStore('outbox', { keyPath: 'clientId' });
      db.createObjectStore('pendingReads', { keyPath: 'chatId' });
      db.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => resolve(r.result);
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
  const names = STORES.filter((s) => (batch.put[s]?.length ?? 0) > 0 || (batch.del[s]?.length ?? 0) > 0);
  if (!names.length) return Promise.resolve();
  const t = db.transaction(names, 'readwrite');
  for (const s of names) {
    const os = t.objectStore(s);
    for (const v of batch.put[s] ?? []) os.put(v);
    for (const k of batch.del[s] ?? []) os.delete(k);
  }
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
