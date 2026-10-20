// Индекс вложений, которые лежат на устройстве (IndexedDB `relay-attachments-on-device`).
// Сами файлы — в Cache Storage (mediaCache.ts), здесь только сведения о них: в каком ящике, сколько весит, когда
// сохранили и когда открывали. Так отметка «открывали» — крошечная запись, а не перезапись файла, очистка считает
// всё по индексу, не открывая файлы, а вкладки и Service Worker видят один и тот же список.

/** В каком ящике Cache Storage лежит файл. */
export type AttachmentBucket = 'auto-evictable' | 'saved-by-user';

/** Одна запись индекса: файл вложения на этом устройстве. */
export interface AttachmentOnDevice {
  fileId: string;
  bucket: AttachmentBucket;
  sizeBytes: number;
  mimeType: string;
  storedAt: number;        // когда положили в кэш, мс
  lastOpenedAt: number;    // когда последний раз отдавали (не чаще раза в час), мс
  /** Не файл целиком, а кусок начала видео (fileId = «<id>[/вариант]@<смещение>»): с какого байта и сколько весит весь файл. */
  chunkOf?: { offset: number; fullSize: number };
}

/** Очистка ящика auto-evictable (сохранённое вами она не трогает). 0 — без ограничения. */
export interface AutoCleanupPolicy { keepAutoDays: number; maxAutoMb: number }

export interface AttachmentIndex {
  get(fileId: string): Promise<AttachmentOnDevice | undefined>;
  all(): Promise<AttachmentOnDevice[]>;
  put(rec: AttachmentOnDevice): Promise<void>;
  delete(fileIds: string[]): Promise<void>;
  clear(): Promise<void>;
  getPolicy(): Promise<AutoCleanupPolicy | undefined>;
  setPolicy(p: AutoCleanupPolicy): Promise<void>;
}

export const ON_DEVICE_DB = 'relay-attachments-on-device';
const STORE_ATTACHMENTS = 'attachments';
const STORE_SETTINGS = 'settings';
const POLICY_KEY = 'auto-cleanup-policy';

let db: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  return db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(ON_DEVICE_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_ATTACHMENTS, { keyPath: 'fileId' });
      req.result.createObjectStore(STORE_SETTINGS);
    };
    req.onsuccess = () => {
      // другая вкладка/SW удалили базу (очистка данных) — следующий вызов откроет заново
      req.result.onversionchange = () => { req.result.close(); db = null; };
      req.result.onclose = () => { db = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  }).catch((e) => { db = null; throw e; });
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then((d) => new Promise<T>((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : (undefined as T));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  }));
}

/** Индекс в IndexedDB этого origin: одинаково работает на странице и в Service Worker. */
export const idbAttachmentIndex: AttachmentIndex = {
  get: (fileId) => run(STORE_ATTACHMENTS, 'readonly', (s) => s.get(fileId)),
  all: () => run(STORE_ATTACHMENTS, 'readonly', (s) => s.getAll()),
  put: (rec) => run(STORE_ATTACHMENTS, 'readwrite', (s) => { s.put(rec); }),
  delete: (ids) => (ids.length ? run(STORE_ATTACHMENTS, 'readwrite', (s) => { for (const id of ids) s.delete(id); }) : Promise.resolve()),
  clear: () => run(STORE_ATTACHMENTS, 'readwrite', (s) => { s.clear(); }),
  getPolicy: () => run(STORE_SETTINGS, 'readonly', (s) => s.get(POLICY_KEY)),
  setPolicy: (p) => run(STORE_SETTINGS, 'readwrite', (s) => { s.put(p, POLICY_KEY); }),
};

/** Индекс в памяти — для тестов. */
export function memoryAttachmentIndex(): AttachmentIndex & { rows: Map<string, AttachmentOnDevice> } {
  const rows = new Map<string, AttachmentOnDevice>();
  let policy: AutoCleanupPolicy | undefined;
  return {
    rows,
    get: async (id) => (rows.has(id) ? { ...rows.get(id)! } : undefined),
    all: async () => [...rows.values()].map((r) => ({ ...r })),
    put: async (r) => { rows.set(r.fileId, { ...r }); },
    delete: async (ids) => { for (const id of ids) rows.delete(id); },
    clear: async () => { rows.clear(); },
    getPolicy: async () => policy,
    setPolicy: async (p) => { policy = { ...p }; },
  };
}

/** Канал «список файлов на устройстве изменился»: вкладки перечитывают индекс. */
export const ON_DEVICE_CHANNEL = 'relay-attachments-on-device';
export function announceOnDeviceChanged(): void {
  try { const c = new BroadcastChannel(ON_DEVICE_CHANNEL); c.postMessage({ type: 'changed' }); c.close(); } catch { /* нет BroadcastChannel */ }
}
