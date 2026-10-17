import type { LocalMessage } from './types';

export type StoreName = 'chats' | 'messages' | 'outbox' | 'pendingReads' | 'meta' | 'users' | 'ops';
const STORES: StoreName[] = ['chats', 'messages', 'outbox', 'pendingReads', 'meta', 'users', 'ops'];
const VERSION = 3; // 2: blobs — файлы, ждущие отправки; 3: users — кэш профилей, ops — очередь операций настроек

/**
 * onVersionChange: другая вкладка (новая сборка) открывает базу более новой версии. Соединение закрываем сразу,
 * иначе её обновление ждёт нас вечно; движок после этого мёртв — хост просит вкладки перезагрузиться.
 */
export function openDb(name: string, opts: { onVersionChange?: () => void; version?: number } = {}): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, opts.version ?? VERSION);
    // старую версию держит открытой вкладка прежней сборки: ждём, пока она закроется (её onversionchange)
    r.onblocked = () => console.warn(`idb ${name}: upgrade to v${opts.version ?? VERSION} is waiting for other tabs to close the old version`);
    r.onupgradeneeded = (e) => {
      const db = r.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('chats', { keyPath: 'id' });
        db.createObjectStore('messages', { keyPath: 'key' }).createIndex('byChat', ['chatId', 'sort']);
        db.createObjectStore('outbox', { keyPath: 'clientId' });
        db.createObjectStore('pendingReads', { keyPath: 'chatId' });
        db.createObjectStore('meta', { keyPath: 'k' });
      }
      if (e.oldVersion < 2) db.createObjectStore('blobs', { keyPath: 'clientId' });
      if (e.oldVersion < 3) { db.createObjectStore('users', { keyPath: 'id' }); db.createObjectStore('ops', { keyPath: 'id' }); }
    };
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
