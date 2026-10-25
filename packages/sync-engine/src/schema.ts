// Единственное место, где описаны таблицы IndexedDB воркера
export const SCHEMA_VERSION = 6;

type Index = { name: string; keyPath: string | string[] };
type StoreDef = { keyPath: string | string[]; indexes?: Index[]; keep?: true };

export const SCHEMA = {
  chats:         { keyPath: 'id' },
  messages:      { keyPath: 'key', indexes: [{ name: 'byChat', keyPath: ['chatId', 'sort'] }, { name: 'byTab', keyPath: ['chatId', 'tab', 'sort'] }] },
  users:         { keyPath: 'id' },
  contacts:      { keyPath: 'userId' },
  blocked:       { keyPath: 'userId' },
  members:       { keyPath: ['chatId', 'userId'], indexes: [{ name: 'byChat', keyPath: ['chatId', 'order'] }] },
  profileMusic:  { keyPath: ['userId', 'attId'], indexes: [{ name: 'byUser', keyPath: ['userId', 'addedAt'] }] },
  profilePhotos: { keyPath: ['userId', 'pid'], indexes: [{ name: 'byUser', keyPath: ['userId', 'at'] }] },
  terms:         { keyPath: ['term', 'chatId', 'sort'] },
  chatSeq:       { keyPath: 'chatId' },   // журналы чатов (группы, каналы): номер, до которого применён
  meta:          { keyPath: 'k' },
  outbox:        { keyPath: 'clientId', keep: true },
  blobs:         { keyPath: 'clientId', keep: true },
  ops:           { keyPath: 'id', keep: true },
  pendingReads:  { keyPath: 'chatId', keep: true },
} as const satisfies Record<string, StoreDef>;

export type StoreName = keyof typeof SCHEMA;
export const STORES = Object.keys(SCHEMA) as StoreName[];
/** Неотправленное: переживает обновление схемы. */
export const KEEP_STORES = STORES.filter((s) => (SCHEMA[s] as StoreDef).keep);
/** Кэш: можно стереть и взять снимком заново. */
export const CACHE_STORES = STORES.filter((s) => !(SCHEMA[s] as StoreDef).keep);

/**
 * Обновление базы. Переход на 4 меняет форму строк (чат без копий собеседника, контакты отдельно), на 5 — события
 * групп приходят журналом чата (chatSeq), старый кэш их позиций не знает; 6 — в кэше могли остаться сообщения,
 * у которых событие attachmentUpdated стёрло имя файла и миниатюру (сервер слал вложение без текста);
 * во всех случаях кэш (CACHE_STORES) стирается и берётся снимком заново; неотправленное (KEEP_STORES) остаётся как есть.
 */
export function upgrade(db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void {
  for (const name of STORES) {
    const def = SCHEMA[name] as StoreDef;
    if (oldVersion > 0 && oldVersion < 6 && !def.keep && db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
    const store = db.objectStoreNames.contains(name) ? tx.objectStore(name) : db.createObjectStore(name, { keyPath: def.keyPath });
    for (const ix of def.indexes ?? []) if (!store.indexNames.contains(ix.name)) store.createIndex(ix.name, ix.keyPath);
  }
}
