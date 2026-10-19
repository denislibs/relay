import { searchTerms } from '@relay/protocol';
import { tabsOf } from './derive';
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

export function req<T>(r: IDBRequest<T>): Promise<T> {
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

/** Слова сообщения для указателя: только подтверждённые и не удалённые; имя файла и теги трека вложения (первыми — предел 64 слова), потом текст */
export function termsOf(m: LocalMessage): string[] {
  if (m.id == null || m.deleted) return [];
  const a = m.attachment;
  return searchTerms(a ? [a.name, a.title, a.performer, m.body].filter(Boolean).join(' ') : m.body);
}

/** Правка сохранённой строки сообщения, которого нет в памяти (sort подтверждённого = id) */
export interface RowPatch { chatId: number; id: number; patch: Partial<LocalMessage> }

export interface WriteBatch {
  rowPatches?: RowPatch[];
  put: Partial<Record<StoreName, unknown[]>>;
  del: Partial<Record<StoreName, IDBValidKey[]>>;
}

/** Одна транзакция на всю пачку: данные и lastSeq записываются атомарно. */
export function write(db: IDBDatabase, batch: WriteBatch): Promise<void> {
  const dropChats = batch.del.chats ?? [];
  const names = STORES.filter((s) => (batch.put[s]?.length ?? 0) > 0 || (batch.del[s]?.length ?? 0) > 0 || ((s === 'messages' || s === 'terms') && (dropChats.length > 0 || (batch.rowPatches?.length ?? 0) > 0)));
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
        for (const term of termsOf(m)) t.objectStore('terms').delete([term, m.chatId, m.sort]);   // слова удалённого чата
        c.delete(); c.continue();
      };
    }
  }
  // правка незагруженного сообщения: строка и её слова — вместе, той же транзакцией (иначе удалённый текст остался бы в кэше и поиске)
  for (const { chatId, id, patch } of batch.rowPatches ?? []) {
    const cur = t.objectStore('messages').index('byChat').openCursor(IDBKeyRange.only([chatId, id]));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      const old = c.value as LocalMessage & { tab?: string };
      const next = { ...old, ...patch } as LocalMessage & { tab?: string };
      const terms = t.objectStore('terms');
      for (const term of termsOf(old)) terms.delete([term, old.chatId, old.sort]);
      for (const term of termsOf(next)) terms.put({ term, chatId: next.chatId, sort: next.sort, key: next.key });
      const tab = tabsOf(next)[0];
      if (tab) next.tab = tab; else delete next.tab;
      c.update(next);
    };
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
