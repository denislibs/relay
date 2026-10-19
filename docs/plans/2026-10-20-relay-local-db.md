# Локальная база воркера: одна нормализованная схема — план реализации

> **Для исполнителей-агентов:** обязательный навык — superpowers:subagent-driven-development (рекомендуется)
> или superpowers:executing-plans; задачи выполняются по порядку, шаги отмечаются чекбоксами (`- [ ]`).

**Цель.** Все данные клиента — в одной копии внутри воркера (память + IndexedDB), разложенные без дублей,
свежие по журналу; страница только подписывается и читает готовое. Убрать «вторые кэши» страницы
(имена, фото, выключенные чаты, участники, музыка, фото профиля) и копии внутри базы (название и фото
собеседника в чате, контактное имя в профиле). Чтение — мгновенное: из памяти, по индексам, с переиспользованием
готовых элементов.

**Архитектура.** Воркер держит таблицы в памяти (`Map`) и пишет их пачками в IndexedDB (как сейчас `flush`).
Схема — один файл: таблицы, ключи, индексы, версия, шаги обновления. Хранится нормализованно: у каждой сущности
одна строка; связи — по id. Отдаётся собранно: запросы (`queries.ts`) склеивают строки в памяти и переиспользуют
элемент, пока не изменилась ни одна из строк, из которых он собран (версии строк). Журнал сервера приносит изменения
строк; HTTP-ответы не перетирают более свежие строки (у каждой строки — `seq`).

**Стек.** Bun, TypeScript, Preact; движок `packages/sync-engine` (SharedWorker, IndexedDB, fake-indexeddb в тестах);
сервер `apps/server` (Postgres, журнал `updates`); веб `apps/web`.

## Общие требования

- Код telegram-tt/tweb (GPL) не копируем; берём только поведение и числа из конфигов.
- Порядок прежний: сначала тест, потом код; коммит на каждую задачу; в коммит — только свои файлы
  (в этой папке параллельно работают другие сессии).
- Комментарии в коде — по-русски, в стиле окружающего кода.
- Миграции сервера — следующие свободные номера после последнего (на сегодня последний — `130`).
- Версия IndexedDB воркера: `4` (сейчас `3`).
- Ничего не теряем при обновлении: неотправленное (`outbox`, `blobs`, `ops`, `pendingReads`) переживает переход на v4.
- Плавность прежде всего: никаких миганий при переходе (данные с прошлого запуска показываются сразу).
- Пределы хранения (согласованы): сообщения ~500 последних на чат + открытое окно, всего ~50 000;
  люди ~5 000; участники — полностью для групп до 1 000, иначе первые 200; музыка и фото профиля — по 100 на человека.
- Тесты: сервер — `docker compose --profile test run --rm test`; движок — `docker compose --profile test run --rm test-engine`;
  веб — `cd apps/web && bun test`; набор UI — `cd packages/relay-ui && bun test`.
- Пуш на GitHub — только после явного «да» пользователя.

---

## Как будет выглядеть база (итог)

```
IndexedDB воркера, версия 4
───────────────────────────────────────────────────────────────────────────────────────────────
users          ключ id                    публичный профиль человека + seq
contacts       ключ userId                контактное имя, заметка + seq          (было: meta.contacts)
blocked        ключ userId                когда заблокирован + seq               (было: meta.blocks)
chats          ключ id                    чат: peerId | group, muteUntil, ranges, mediaCounts, mediaDone,
                                          membersDone + производные: last, unread
messages       ключ key
  byChat         [chatId, sort]           лента
  byTab          [chatId, tab, sort]      общие медиа (tab ставится при записи; у обычного текста — нет)
members        ключ [chatId, userId]      роль, звание, порядок
  byChat         [chatId, order]
profileMusic   ключ [userId, attId]       трек профиля
  byUser         [userId, addedAt]
profilePhotos  ключ [userId, pid]         фото профиля
  byUser         [userId, at]
terms          ключ [term, chatId, sort]  указатель слов для поиска без сети; значение — key сообщения
outbox, blobs, pendingReads, ops          без изменений
meta           ключ k                     только одиночные значения: lastSeq, epoch, hydrated, dialogs*, me, settings
```

Что уходит со страницы: `global.names`, `global.photos`, `global.muted`, `global.myMusic`, `localStorage`
`relay.names` / `relay.muted` / `relay.mutedUntil`, кэши `members.ts`, `profilePhoto.ts` (история фото),
`ensureNames` → `/users?ids=` со страницы.

## Как будет быстро читаться

1. **Память — первична.** Каждая таблица целиком в `Map` воркера (`Tables`), IndexedDB — только для переживания
   перезагрузки. Запрос никогда не ждёт диска, кроме первой загрузки и догрузки старых сообщений чата.
2. **Индексы в памяти рядом с таблицами:** сообщения чата — отсортированный массив (`chatMessages`, уже есть);
   медиа чата по вкладке — отсортированный массив ключей; участники чата — массив по `order`; треки и фото — по владельцу.
3. **Версии строк вместо `JSON.stringify`.** Каждая строка в памяти несёт счётчик `v` (растёт при изменении).
   Элемент запроса (`Item`) кэшируется по подписи из версий строк, из которых собран (чат + собеседник + контакт).
   Сейчас список чатов сравнивает элементы через `JSON.stringify` — это уходит.
4. **Страница читает по id без поиска по массивам:** одна подписка «люди» кладёт `people: Record<id, Item>` в global;
   компоненты берут `people[id]` селектором — перерисовываются только они.

## Порядок и параллельность

```
Этап 1 — основа схемы (задачи 1–6)          ← строго первым, по порядку
Этап 2 — люди в воркере (7–9)               ← после этапа 1
Этап 3 — выключенные уведомления (10–12)    ← после этапа 1; можно параллельно с этапом 2 (другие файлы)
Этап 4 — участники групп (13–15)            ← после этапа 2
Этап 5 — общие медиа (16–19)                ← после этапа 1; лучше после 2
Этап 6 — музыка и фото профиля (20–21)      ← после этапа 2
Этап 7 — поиск без сети (22–23)             ← после этапа 5 (общая запись сообщений)
Этап 8 — уборка и размер базы (24–25)       ← последним
```
Каждый этап заканчивается рабочим приложением и отдельным коммитом (или несколькими). Этапы 3 и 5 можно отдать
отдельным сессиям, когда этап 1 влит.

---

## Этап 1. Основа схемы

### Задача 1: Описание схемы в одном файле и версия 4

**Файлы:**
- Создать: `packages/sync-engine/src/schema.ts`
- Изменить: `packages/sync-engine/src/idb.ts` (весь upgrade и списки хранилищ берутся из схемы)
- Изменить: `packages/sync-engine/src/devdata.ts:7,19`, `packages/sync-engine/src/devstats.ts:108` (списки хранилищ — из схемы)
- Тест: `packages/sync-engine/test/idb.test.ts`

**Интерфейсы:**
- Даёт: `SCHEMA_VERSION = 4`, `type StoreName` (все хранилища, включая `blobs` — сейчас его нет в `StoreName`,
  поэтому `write()` не может его трогать), `STORES: readonly StoreName[]`, `upgrade(db, oldVersion, tx)`,
  `CACHE_STORES` (то, что можно стереть и взять снимком заново) и `KEEP_STORES` (outbox, blobs, ops, pendingReads).

```ts
// schema.ts — единственное место, где описаны таблицы IndexedDB воркера
export const SCHEMA_VERSION = 4;

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
  meta:          { keyPath: 'k' },
  outbox:        { keyPath: 'clientId', keep: true },
  blobs:         { keyPath: 'clientId', keep: true },
  ops:           { keyPath: 'id', keep: true },
  pendingReads:  { keyPath: 'chatId', keep: true },
} as const satisfies Record<string, StoreDef>;

export type StoreName = keyof typeof SCHEMA;
export const STORES = Object.keys(SCHEMA) as StoreName[];
export const KEEP_STORES = STORES.filter((s) => (SCHEMA[s] as StoreDef).keep);
export const CACHE_STORES = STORES.filter((s) => !(SCHEMA[s] as StoreDef).keep);

/**
 * Обновление базы. Переход на 4 меняет форму строк (чат без копий собеседника, контакты отдельно), поэтому
 * кэш (CACHE_STORES) стирается и берётся снимком заново; неотправленное (KEEP_STORES) остаётся как есть.
 */
export function upgrade(db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void {
  for (const name of STORES) {
    const def = SCHEMA[name] as StoreDef;
    if (oldVersion > 0 && oldVersion < 4 && !def.keep && db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
    const store = db.objectStoreNames.contains(name) ? tx.objectStore(name) : db.createObjectStore(name, { keyPath: def.keyPath });
    for (const ix of def.indexes ?? []) if (!store.indexNames.contains(ix.name)) store.createIndex(ix.name, ix.keyPath);
  }
}
```

- [ ] **Шаг 1: тест — свежая база v4 имеет все хранилища и индексы; переход с v3 стирает кэш и сохраняет outbox/blobs/ops/pendingReads**

```ts
test('schema v4: every store and index exists', async () => {
  const db = await openDb('schema-fresh');
  for (const s of STORES) expect(db.objectStoreNames.contains(s)).toBe(true);
  const tx = db.transaction(['messages', 'members'], 'readonly');
  expect([...tx.objectStore('messages').indexNames].sort()).toEqual(['byChat', 'byTab']);
  expect([...tx.objectStore('members').indexNames]).toEqual(['byChat']);
});

test('upgrade 3 → 4 keeps unsent work and drops the cache', async () => {
  const v3 = await openDb('schema-up', { version: 3 });   // старый upgrade (оставить в тесте копию v3-шагов)
  await write(v3, { put: { outbox: [{ clientId: 'c1', chatId: 1, body: 'hi', createdAt: 1 }], chats: [{ id: 1 }], meta: [{ k: 'lastSeq', v: 7 }] }, del: {} });
  v3.close();
  const v4 = await openDb('schema-up');
  expect(await getAll(v4, 'outbox')).toHaveLength(1);
  expect(await getAll(v4, 'chats')).toHaveLength(0);
  expect(await getAll(v4, 'meta')).toHaveLength(0);   // lastSeq пропал → движок возьмёт снимок
});
```

- [ ] **Шаг 2:** запустить `docker compose --profile test run --rm test-engine bun test test/idb.test.ts` — падает (нет `STORES`/`byTab`).
- [ ] **Шаг 3:** написать `schema.ts`; в `idb.ts` заменить `VERSION`, `StoreName`, `STORES` и тело `onupgradeneeded` на
  `upgrade(db, e.oldVersion, r.transaction!)`; `devdata.ts`/`devstats.ts` берут `STORES` из схемы.
- [ ] **Шаг 4:** тест проходит; весь набор движка — без новых падений.
- [ ] **Шаг 5:** коммит `feat(engine): one schema file for IndexedDB, version 4`.

### Задача 2: Версия у каждой строки и единое правило «старое не перетирает новое»

Сейчас `seq` людей хранится только в памяти (`ProfileCache.userSeqs`): после перезагрузки старый HTTP-ответ может
затереть свежую запись журнала. Правило делаем одно на все таблицы и храним `seq` в самой строке.

**Файлы:**
- Создать: `packages/sync-engine/src/rows.ts`
- Тест: `packages/sync-engine/test/rows.test.ts`

**Интерфейсы:**
- Даёт:

```ts
/** Строка таблицы в памяти воркера: seq — номер записи журнала, на момент которой она верна (0 — неизвестно);
 *  v — счётчик изменений в этой вкладке воркера (для подписи элементов запросов, не хранится на диске). */
export type Row<T> = T & { seq: number; v: number };

/** Таблица в памяти с отметкой изменённых строк для flush. */
export class Table<K, T> {
  readonly rows = new Map<K, Row<T>>();
  readonly dirty = new Set<K>();
  readonly removed = new Set<K>();
  get(k: K): Row<T> | undefined;
  /** Записать, если seq не меньше сохранённого; вернёт true, если строка изменилась. */
  put(k: K, value: T, seq: number): boolean;
  delete(k: K): boolean;
  /** Забрать изменения для write(): put — значения без v, del — ключи. */
  collect(): { put: (T & { seq: number })[]; del: K[] };
  load(list: (T & { seq?: number })[], key: (x: T) => K): void;
}
```

- [ ] **Шаг 1: тесты**

```ts
test('an older seq never overwrites a newer row; equal seq with new content does', () => {
  const t = new Table<number, { id: number; name: string }>();
  expect(t.put(1, { id: 1, name: 'Анна' }, 10)).toBe(true);
  expect(t.put(1, { id: 1, name: 'Старое' }, 9)).toBe(false);
  expect(t.get(1)!.name).toBe('Анна');
  expect(t.put(1, { id: 1, name: 'Аня' }, 10)).toBe(true);
  expect(t.get(1)!.v).toBe(2);
});
test('same content does not mark the row dirty', () => {
  const t = new Table<number, { id: number; name: string }>();
  t.put(1, { id: 1, name: 'Анна' }, 1); t.collect();
  expect(t.put(1, { id: 1, name: 'Анна' }, 2)).toBe(false);
  expect(t.collect().put).toHaveLength(0);
});
```

- [ ] **Шаг 2:** запустить — падает.
- [ ] **Шаг 3:** реализовать `Table` (сравнение содержимого — поверхностное по полям + `JSON.stringify` только для вложенных
  объектов `photo`/`music`; `v` — `prev.v + 1`).
- [ ] **Шаг 4:** тесты проходят.
- [ ] **Шаг 5:** коммит `feat(engine): versioned rows with a single stale-write rule`.

### Задача 3: Люди, контакты и чёрный список — своими таблицами

**Файлы:**
- Изменить: `packages/sync-engine/src/profile.ts` (`ProfileCache.users` → `Table<number, PublicUser>`; убрать `userSeqs`)
- Изменить: `packages/sync-engine/src/contacts.ts` (`ContactsCache.base` → `Table<number, ContactBase>`; meta `contacts` → хранилище `contacts`)
- Изменить: `packages/sync-engine/src/blocks.ts` (`BlocksCache.base` → `Table`; meta `blocks` → хранилище `blocked`)
- Изменить: `packages/sync-engine/src/store.ts` (`open`: загрузка из новых хранилищ; `flush`: `put.users/contacts/blocked` из `collect()`)
- Тесты: `packages/sync-engine/test/profile.test.ts`, `contacts.test.ts`, `store.test.ts`

**Интерфейсы:**
- Даёт: `store.users: Table<number, PublicUser>`, `store.contacts.table: Table<number, ContactBase>`, `store.blocks.table: Table<number, BlockedBase>`.
- Сохраняет: `floor` контактов и чёрного списка (снимок поднимает нижнюю границу) — в meta `contactsFloor`/`blocksFloor` (мелкие числа).

- [ ] **Шаг 1: тесты**
  1. «userUpdated с seq 12, затем ответ GET /users/:id со снимком seq 11 — остаётся версия 12, и после перезапуска движка тоже» (открыть движок заново на той же базе и проверить `user` запрос).
  2. «1000 контактов; правка одного пишет в IndexedDB одну строку `contacts`» (подсчитать через обёртку `write`, считающую строки).
  3. «блокировка и разблокировка переживают перезапуск».
- [ ] **Шаг 2:** запустить — 1 и 2 падают.
- [ ] **Шаг 3:** перенести хранение; `ProfileCache.applyUser(u, seq)` → `store.users.put(u.id, u, seq ?? 0)`.
- [ ] **Шаг 4:** весь набор движка зелёный.
- [ ] **Шаг 5:** коммит `refactor(engine): people, contacts and blocks in their own stores with persisted seq`.

### Задача 4: Показываемое имя — одно правило; контактное имя не вшито в профиль

Сервер в профиле отдаёт `name` уже с контактным именем зрителя и `publicName` — собственное (как Telegram). Клиент
хранит в `users` профиль как пришёл, но **показывает** имя только через одну функцию.

**Файлы:**
- Создать: `packages/sync-engine/src/names.ts`
- Изменить: `packages/sync-engine/src/contacts.ts` (убрать `retitle`/`retitleChats`/`titleOf` — их заменяет `displayName`)
- Тест: `packages/sync-engine/test/names.test.ts`

**Интерфейсы:**
```ts
/** Как зритель видит человека: контактное имя, если есть контакт; иначе собственное имя профиля. */
export function displayName(store: Store, userId: number): string;
/** Имя и фото для строки: { name, photo, v } — v = подпись из версий users + contacts (для кэша элементов). */
export function personView(store: Store, userId: number): { name: string; photo: ProfilePhoto | null; sig: string };
```
`displayName = contact ? full(contact.firstName, contact.lastName) : (user.publicName ?? user.name)`.

- [ ] **Шаг 1: тесты:** нет контакта → публичное имя; контакт «Мама» → «Мама»; переименование контакта меняет
  `displayName`, а строка `users` не меняется (`users.get(id).v` прежний); удаление контакта → снова публичное имя.
- [ ] **Шаг 2–4:** запустить, реализовать, зелёный.
- [ ] **Шаг 5:** коммит `feat(engine): one display-name rule for people`.

### Задача 5: Чат без копий собеседника

**Файлы:**
- Изменить: `packages/sync-engine/src/types.ts` — у `LocalChat` убрать `title` для личных чатов (оставить `title` только группе
  — её название из `group`), убрать `photo`, `named`, `membersRev` (в задаче 14).
- Изменить: `packages/sync-engine/src/store.ts:221 applyChats` — `s.peer` кладётся в `users` (`users.put(peer.id, peer, seq)`), чат хранит только `peerId`.
- Изменить: `packages/sync-engine/src/profile.ts:99-108 applyUserUpdated` — больше не переписывает чаты.
- Изменить: `packages/sync-engine/src/queries.ts:20-29 chatItem` — `title`/`photo`/`peer.name` берутся из `personView(store, peerId)`;
  группа — из `chat.group`.
- Изменить: `packages/sync-engine/src/engine.ts:171` — `store.titleOf` → `displayName`.
- Изменить: поиск (`engine.ts:541`, `chatTitle`) — `displayName` для личных.
- Тест: `packages/sync-engine/test/queries.test.ts`

- [ ] **Шаг 1: тесты:**
  1. «userUpdated переименовал собеседника — строка списка обновилась, а строка `chats` в IndexedDB не переписана»
     (счётчик записей `chats` в `write` = 0).
  2. «чат, узнанный из сообщения (собеседник неизвестен) — название появляется, когда пришёл профиль» (заменяет логику `named`).
- [ ] **Шаг 2–4:** запустить, реализовать, зелёный; веб-тесты (`apps/web`) — без изменений поведения.
- [ ] **Шаг 5:** коммит `refactor(engine): direct chats keep only peerId; title and photo come from people`.

### Задача 6: Элементы запросов по версиям строк; производные поля — в одном месте

**Файлы:**
- Создать: `packages/sync-engine/src/derive.ts`
- Изменить: `packages/sync-engine/src/queries.ts:11-15 result()` — подпись элемента из версий строк вместо `JSON.stringify`
- Изменить: `packages/sync-engine/src/store.ts` — `putMessage`/`patchMessage`/удаление зовут `derive.onMessage`
- Тест: `packages/sync-engine/test/derive.test.ts`, `queries.test.ts`

**Интерфейсы:**
```ts
/** Производные поля чата пересчитываются только здесь. kind: что случилось с сообщением. */
export function onMessage(store: Store, chat: LocalChat, m: LocalMessage, kind: 'added' | 'edited' | 'deleted'): void;
// обновляет: chat.last/lastAt (последнее не удалённое), chat.unread (входящие после lastReadId),
//            chat.mediaCounts[tab] (задача 18) — каждое поле одной функцией
export function recomputeLast(store: Store, chat: LocalChat): void;
```
Подпись элемента списка чатов: `` `${chat.v}|${peer?.sig ?? ''}|${typing}` ``.

- [ ] **Шаг 1: тесты:** удалили последнее сообщение → `last` = предыдущее; правка последнего → `last.body` новый;
  список чатов из 1000 строк: изменился один чат → `diffResults` даёт ровно 1 upsert, и время сборки списка
  не растёт от числа чатов (замер: второй вызов `computeQuery` на неизменной базе < 2 мс на 1000 чатов).
- [ ] **Шаг 2–4:** запустить, реализовать, зелёный.
- [ ] **Шаг 5:** коммит `perf(engine): query items signed by row versions; derived chat fields in one place`.

---

## Этап 2. Люди в воркере (исправляет баг с устаревшими именами)

### Задача 7: Сервер — `/users?ids=` отдаёт полный профиль

Сейчас `usersByIds` (`apps/server/src/domain/users.ts:6`) отдаёт только `{id, name, photo}`. Нужен тот же `PublicUser`,
что и `GET /users/:id` (с правилами приватности и `seq` зрителя).

**Файлы:**
- Изменить: `apps/server/src/domain/users.ts` — через `COLS` + `publicUser(viewer, r, contactName, ctx)` (`profile.ts:55`), `seq: selfSeq(viewer)`
- Тест: `apps/server/test/users.test.ts` (создать, если нет)

- [ ] **Шаг 1: тест:** `GET /users?ids=a,b,c` → `{ users: PublicUser[], seq }`; скрытое правилами поле (bio) — `null`;
  чужой без общего чата не возвращается; заблокировавший — без фото и музыки.
- [ ] **Шаг 2–4:** запустить, реализовать, зелёный.
- [ ] **Шаг 5:** коммит `feat(server): /users?ids returns full public profiles with seq`.

### Задача 8: Движок — пачка незнакомых и запрос `people`

**Файлы:**
- Изменить: `packages/sync-engine/src/engine.ts:685 fetchUsers` — одна пачка `GET /users?ids=` (до 200) вместо запроса на человека;
  ответ кладётся с `seq` ответа
- Изменить: `packages/sync-engine/src/types.ts` — `Query` + `{ kind: 'people'; ids: number[] }`
- Изменить: `packages/sync-engine/src/engine.ts:330-360` — `people` строится из `personView` + `users`; неизвестные id → `userWants`
- Тест: `packages/sync-engine/test/profile.test.ts`

- [ ] **Шаг 1: тесты:** подписка `people` на 50 незнакомых → ровно один HTTP-запрос; две вкладки одного воркера просят
  одних и тех же — один запрос; `userUpdated` меняет элемент у подписчика; без сети после перезапуска имена и фото есть.
- [ ] **Шаг 2–4:** запустить, реализовать, зелёный.
- [ ] **Шаг 5:** коммит `feat(engine): people query with batched lookups`.

### Задача 9: Страница — `people` вместо `names`/`photos`/`ensureNames`

**Файлы:**
- Создать: `apps/web/src/people.ts` — одна подписка на воркер с набором нужных id
- Изменить читателей `global.names` и `global.photos`: `music.ts:21`, `ui/preview.tsx:75`, `ui/Feed.tsx:151,340,747,798`,
  `ui/Sidebar.tsx:61-62`, `ui/SharedMedia.tsx:101,117,233`, `ui/Chat.tsx:126,134,412,509`,
  `ui/search/GlobalSearch.tsx:196,203,227,263,276,322-325,377-378`, `profilePhoto.ts:15-24` (`userPhoto`)
- Удалить: `data.ts` `ensureNames`/`flushNames`/`rememberNames` (L702-725) и засев имён из списка чатов (L68-70);
  `profilePhoto.ts` `rememberPhotos`; `global.names`, `global.photos`; ключ `relay.names` (+ разовая очистка у всех)
- Тест: `apps/web/src/people.test.ts`

**Интерфейсы:**
```ts
/** Хочу видеть этих людей: id копятся до конца микрозадачи и уходят одной подпиской. */
export function wantPeople(ids: number[]): void;
/** Имя и фото человека (как зритель его видит) — селектор, перерисовывает только при изменении этого человека. */
export function usePerson(id: number | null | undefined): { name: string; photo: ProfilePhoto | null } | null;
export function personName(id: number): string;   // для не-компонентов (уведомления, превью)
```
`global.people: Record<number, Item>` заполняет одна подписка `people`; при новых id подписка пересоздаётся в той же
микрозадаче (старые элементы остаются на экране — без мигания).

- [ ] **Шаг 1: тесты:** `wantPeople([1,2]); wantPeople([2,3])` в одной микрозадаче → одна подписка с `[1,2,3]`;
  `usePerson` возвращает прежнее значение, пока подписка пересоздаётся.
- [ ] **Шаг 2–4:** запустить, реализовать, заменить читателей, `bunx tsc --noEmit` и `bun test` зелёные.
- [ ] **Шаг 5: проверка в браузере:** группа с незнакомыми авторами — имена и аватарки на месте; переименовать
  пользователя во второй вкладке — имя в ленте группы меняется без перезагрузки; офлайн-перезагрузка — имена на месте.
- [ ] **Шаг 6:** коммит `refactor(web): people come from the worker; names/photos caches removed`.

---

## Этап 3. Выключенные уведомления — на сервере и через журнал

### Задача 10: Сервер — `muteUntil` у участника чата

**Файлы:**
- Создать: `apps/server/migrations/131_chat_mute.sql`
- Изменить: `apps/server/src/domain/chats.ts` (снимок списка чатов отдаёт `muteUntil`), новый `domain/chatNotify.ts`
- Изменить: `apps/server/src/http.ts` — `PUT /chats/:id/notify { muteUntil: number | null }` (мс; `0` — навсегда)
- Изменить: `packages/protocol/src/index.ts` — `Update` + `{ type: 'chatNotify'; chatId: Id; muteUntil: number | null }`;
  `ChatSummary.muteUntil?`
- Изменить: `apps/server/src/domain/push.ts:122` — доставка пропускает чат, если `chat_members.mute_until` в будущем
  (или «навсегда»); поле `muted` подписки остаётся для старых вкладок, пока они не обновятся
- Тест: `apps/server/test/chatNotify.test.ts`

```sql
-- 131_chat_mute.sql: выключенные уведомления чата — настройка аккаунта (одна на все устройства), как в Telegram
alter table chat_members add column if not exists mute_until timestamptz;   -- null — включены; 'infinity' — навсегда
```

- [ ] **Шаг 1: тесты:** выключить на 8 часов → запись `chatNotify` в журналах своих устройств (только себе);
  push по этому чату не уходит; через 8 часов (подменить `now()` в тесте) — уходит; `muteUntil: null` включает.
- [ ] **Шаг 2–4:** запустить, реализовать, зелёный.
- [ ] **Шаг 5:** коммит `feat(server): per-chat mute stored on the account and sent through the journal`.

### Задача 11: Движок — `chat.muteUntil` и операция выключения

**Файлы:**
- Изменить: `packages/sync-engine/src/types.ts` (`LocalChat.muteUntil?: number | null`), `store.ts` (`applyUpdate` → `chatNotify`, `applyChats`)
- Изменить: `packages/sync-engine/src/engine.ts` — действие `setMute { chatId, muteUntil }` через `ops` (ключ `mute:<chatId>`,
  оптимистично видно сразу, без сети — дождётся)
- Изменить: `packages/sync-engine/src/queries.ts` — `chatItem` отдаёт `muteUntil`
- Тест: `packages/sync-engine/test/mute.test.ts`

- [ ] **Шаг 1: тесты:** выключили на одном «устройстве» (движок A) → у движка B того же пользователя `muteUntil` пришёл по журналу;
  без сети выключили → видно сразу, после подключения ушло на сервер.
- [ ] **Шаг 2–4, коммит** `feat(engine): chat mute through ops and the journal`.

### Задача 12: Страница — `isMuted(chat)` вместо `global.muted`

**Файлы:**
- Изменить: `apps/web/src/mute.ts` — `isMuted(chat, now)`, один таймер до ближайшего истечения; `muteChat`/`unmuteChat` → `engine.call setMute`
- Изменить читателей: `data.ts:55`, `notify.ts:42,67,107`, `notifyRules.ts:12,20`, `ui/Info.tsx:29-36,43`, `folderNav.tsx:39-45`,
  `ui/ChatMenu.tsx:23`, `ui/Sidebar.tsx:135,187,260,290`, `ui/contacts/EditContact.tsx:53,107,123`
- Разовый перенос: при старте, если в `localStorage` есть `relay.muted`/`relay.mutedUntil`, — отправить `setMute` для каждого и удалить ключи
- Тест: `apps/web/src/mute.test.ts`

- [ ] **Шаг 1: тесты:** `isMuted` для `null`, будущего, прошлого, `0` (навсегда); перенос старых ключей вызывает `setMute` и чистит их.
- [ ] **Шаг 2–4;** проверка в браузере: выключить чат в одной вкладке/профиле — во второй значок «выключено» появился сам.
- [ ] **Шаг 5:** коммит `refactor(web): mute state comes from the chat`.

---

## Этап 4. Участники групп

### Задача 13: Сервер — изменения состава в журнале

**Файлы:**
- Изменить: `apps/server/src/domain/groupRights.ts:143-146 broadcastMembers(tx, chatId)` → `broadcastMembers(tx, chatId, delta)`
- Изменить вызовы в `apps/server/src/domain/groups.ts`: L280 `acceptMember`, L318 `addGroupMembers`, L331 `dropMember`,
  L390 `restrictGroupMember`, L416 `setGroupAdmin`, L434 `setGroupRank`, L448 `makeOwner`
- Изменить: `packages/protocol/src/index.ts` — `Update` + `{ type: 'members'; chatId: Id; upsert: MemberRow[]; remove: Id[] }`,
  `MemberRow = { userId: Id; role: 'owner'|'admin'|'member'; rank: string | null }`; `membersChanged` убрать
- Тест: `apps/server/test/groups.test.ts` (дополнить)

- [ ] **Шаг 1: тесты:** добавили двоих → у всех участников запись `members` с двумя `upsert`; сделали админом → `upsert` с ролью;
  исключили → `remove`; вместе с новым участником всем приходит `userUpdated` его профиля (если раньше не виделись).
- [ ] **Шаг 2–4, коммит** `feat(server): member changes travel as deltas in the journal`.

### Задача 14: Движок — таблица `members`

**Файлы:**
- Создать: `packages/sync-engine/src/members.ts` — `MembersCache` (`Table<string, MemberRow & {chatId, order}>`, индекс в памяти по чату)
- Изменить: `store.ts` (`applyUpdate` → `members`; `LocalChat.membersDone`; убрать `membersRev`), `engine.ts` (загрузка
  `GET /chats/:id/members` → строки `members` + профили в `users`; присутствие — только в памяти), `types.ts` (`Query` + `{ kind: 'members'; chatId }`)
- Тест: `packages/sync-engine/test/members.test.ts`

Пределы: группа до 1 000 — список целиком (`membersDone = true`); больше — первые 200 (`membersDone = false`).

- [ ] **Шаг 1: тесты:** открыли участников → один запрос, строки в базе; перезапуск без сети → список сразу из базы;
  запись журнала `members` добавила человека — подписчик получил одну строку (без перечитывания).
- [ ] **Шаг 2–4, коммит** `feat(engine): group members stored and kept fresh by the journal`.

### Задача 15: Страница — `useMembers` из воркера

**Файлы:**
- Изменить: `apps/web/src/members.ts` (кэш и `fetch` уходят; `useMembers(chatId)` — подписка `members`)
- Изменить: `ui/Info.tsx:85`, `ui/Chat.tsx:398`, `ui/SharedMedia.tsx:42`, `ui/group/EditGroup.tsx:21` (без `membersRev`)
- [ ] **Шаги:** тест хука (данные из подписки, без своего запроса), правка, проверка в браузере (добавили участника в
  одной вкладке — во второй список обновился без перечитывания), коммит `refactor(web): members come from the worker`.

---

## Этап 5. Общие медиа

### Задача 16: Одна функция «вкладка сообщения» для сервера и клиента

**Файлы:**
- Изменить: `packages/protocol/src/index.ts` — `export function mediaTab(m: Pick<Message, 'kind' | 'attachment' | 'body' | 'entities'>): MediaTab | null`
  (правила как в `apps/server/src/domain/chats.ts:215-217 tabWhere`: фото, видео и файл-видео → `media`; `audio` → `audio`;
  голос и кружок → `voice`; ссылка в тексте или сущностях → `link`; прочие файлы → `file`)
- Тест: `packages/protocol/test/mediaTab.test.ts` — по одному случаю на каждое правило + «текст без ссылки → null»;
  серверный тест: для каждого сообщения выборка `tabWhere` совпадает с `mediaTab`.
- [ ] **Шаги:** тест, реализация, коммит `feat(protocol): one mediaTab rule shared by server and client`.

### Задача 17: Диапазоны истории — медиа не рвут ленту

Старые фото, догруженные для вкладки «Медиа», ложатся в ту же таблицу `messages`, но между ними и лентой может быть
дыра. Лента не должна показать сообщения через дыру. Чат хранит **отрезки непрерывной истории**.

**Файлы:**
- Изменить: `packages/sync-engine/src/types.ts` — `LocalChat.ranges: [fromSort, toSort][]` (взамен `historyComplete` — он = отрезок от начала)
- Изменить: `packages/sync-engine/src/store.ts` — `applyHistory` сливает отрезки; новое сообщение продлевает последний
- Изменить: `packages/sync-engine/src/queries.ts:messageWindow` — окно ограничено отрезком, в котором якорь; `hasOlder` —
  «отрезок не с начала истории»
- Тест: `packages/sync-engine/test/queries.test.ts`

- [ ] **Шаг 1: тесты:** история [100..200], медиа догрузили 10 и 20 → лента у 100 показывает `hasOlder = true` и не включает 10/20;
  догрузили историю 21..99 → отрезки слились, 10 и 20 всё ещё за дырой; дошли до начала → `hasOlder = false`.
- [ ] **Шаг 2–4, коммит** `feat(engine): history ranges so stray messages never join the feed`.

### Задача 18: Медиа и счётчики в воркере

**Файлы:**
- Изменить: `store.ts` — при записи сообщения ставить `m.tab = mediaTab(m) ?? undefined`; в памяти — массивы ключей по `[chatId, tab]`
- Изменить: `derive.ts` — `mediaCounts` растут/уменьшаются в `onMessage`; первый раз берутся с сервера (`/media/counts`) и запоминаются
- Изменить: `engine.ts:828-829` — `chatMedia`/`chatMediaCounts` становятся запросом `{ kind: 'media'; chatId; tab; limit }`:
  отдаёт из памяти сразу, догружает с сервера по `/media` старше самого старого известного, отмечает `chat.mediaDone[tab]`
- Тест: `packages/sync-engine/test/media.test.ts`

- [ ] **Шаг 1: тесты:** пришло новое фото → `mediaCounts.media + 1` и оно первым во вкладке без запроса; удалили → минус;
  повторное открытие вкладки — без запроса; без сети после перезапуска вкладка показывает сохранённое.
- [ ] **Шаг 2–4, коммит** `feat(engine): shared media served from the worker`.

### Задача 19: Страница — «Общие медиа» из подписки

**Файлы:** `apps/web/src/ui/SharedMedia.tsx` (`TabList`, счётчики), `apps/web/src/data.ts:614-619` (`chatMedia*` уходят)
- [ ] **Шаги:** правка, `bun test`, проверка в браузере (открыть «Информацию» дважды — второй раз без запросов в сети воркера;
  прислать фото — появилось первым во вкладке сразу), коммит `refactor(web): shared media from the worker`.

---

## Этап 6. Музыка и фото профиля

### Задача 20: Движок — `profileMusic` и `profilePhotos`

**Файлы:**
- Создать: `packages/sync-engine/src/profileLists.ts` — таблицы, загрузка `GET /users/:id/music` и `/users/:id/photos?limit=100`
- Изменить: `profile.ts` — при `userUpdated`, где сменились `music.top`/`music.count` или главное фото, список человека
  помечается устаревшим и перечитывается, если на него есть подписка
- Изменить: `engine.ts` — действия `addProfileMusic`/`removeProfileMusic` через `ops` (оптимистично); запросы
  `{ kind: 'profileMusic'; userId }`, `{ kind: 'profilePhotos'; userId }`
- Тест: `packages/sync-engine/test/profileLists.test.ts`
- [ ] **Шаги:** тесты (смена сводки музыки → перечитали список; свой трек добавили без сети → виден сразу, ушёл после
  подключения; список переживает перезапуск), реализация, коммит `feat(engine): profile music and photos stored in the worker`.

### Задача 21: Страница — без `myMusic` и кэша фото

**Файлы:** `apps/web/src/music.ts` (`refreshMyMusic`, `toggleProfileMusic`, `inProfile`, `loadProfileMusic`, `playProfileTop`),
`apps/web/src/ui/Playlist.tsx:14`, `apps/web/src/profilePhoto.ts:83-95` (`useProfilePhotos`), `apps/web/src/global.ts` (`myMusic` уходит)
- [ ] **Шаги:** тесты `inProfile` по подписке, правка, проверка в браузере (добавить трек — кнопка в плеере и плашка
  под аватаром у собеседника обновились), коммит `refactor(web): profile music and photos from the worker`.

---

## Этап 7. Поиск без сети

### Задача 22: Указатель слов

**Файлы:**
- Изменить: `packages/protocol/src/index.ts` — `export function searchTerms(text: string): string[]` (нижний регистр, `ё → е`,
  слова из букв и цифр, длина 2–32, без повторов, не больше 64 слов на сообщение)
- Изменить: `store.ts` / `flush` — при записи, правке и удалении сообщения обновлять строки `terms` (в той же транзакции)
- Тест: `packages/protocol/test/searchTerms.test.ts`, `packages/sync-engine/test/terms.test.ts`
- [ ] **Шаги:** тесты («Ёжик пришёл!» → `['ежик','пришел']`; правка убирает старые слова; удаление — все), реализация,
  коммит `feat(engine): word index for messages`.

### Задача 23: Поиск — сначала локально, потом сервер

**Файлы:** `packages/sync-engine/src/engine.ts:541 search` — без сети: пересечение диапазонов
`[term, ...]..[term+'￿', ...]` по каждому слову запроса (последнее — по началу слова); с сетью: локальные
результаты сразу, серверные дописываются (`source: 'local' | 'server'`, повторы по key убираются)
- [ ] **Шаги:** тесты (без сети «прив вст» находит «Привет, встречаемся?»; с сетью — локальные первыми, потом серверные без дублей),
  реализация, коммит `feat(engine): offline search over the word index`.

---

## Этап 8. Уборка и размер базы

### Задача 24: Пределы и уборка

**Файлы:**
- Создать: `packages/sync-engine/src/evict.ts`
- Изменить: `engine.ts` — уборка в простое после `flush`, не чаще раза в 10 минут
- Тест: `packages/sync-engine/test/evict.test.ts`

**Правила:**
- Сообщения: у каждого чата оставить последние 500 + окно, открытое сейчас; всего больше 50 000 — давно не открытые чаты
  урезать до последних 50. Не трогать: неотправленные, закреплённые, последнее сообщение чата. Урезание обновляет `ranges`.
- Люди: больше 5 000 — удалить тех, на кого не ссылаются чаты (`peerId`), участники, контакты, чёрный список,
  авторы оставшихся сообщений.
- Участники: группы больше 1 000 — оставить первые 200.
- Музыка и фото профиля: по 100 на человека; удалённый человек — вместе с его списками.
- `terms` удаляются вместе со своими сообщениями (в той же транзакции).

- [ ] **Шаги:** тесты (60 000 сообщений → осталось ≤ 50 000, последние и неотправленные целы; человек без ссылок удалён,
  с ссылкой — нет; лента после уборки догружает старое с сервера), реализация, коммит `feat(engine): storage limits and eviction`.

### Задача 25: Размер базы в «Данные и память»

**Файлы:** `apps/web/src/ui/settings/Data.tsx`, `apps/web/src/storageInfo.ts`; действие движка `storageStats`
(число строк по таблицам + `navigator.storage.estimate()`)
- [ ] **Шаги:** тест `storageStats`, строка «Сообщения и чаты — N МБ» рядом с медиа-кэшем, кнопка «Очистить»
  (уже есть `resetLocal`), проверка в браузере, коммит `feat(web): local database size in Data and storage`.

---

## Проверка всего вместе (после этапа 8)

- [ ] Весь набор тестов сервера, движка, веба и набора UI — зелёный.
- [ ] Браузер: вход новым пользователем; список чатов, лента, группа с незнакомыми, «Информация» (участники, медиа,
  музыка), выключение чата, поиск — всё работает; затем выключить сеть и перезагрузить — всё то же видно.
- [ ] Две вкладки: переименование, выключение чата, новый участник, новый трек профиля — во второй вкладке без перезагрузки.
- [ ] Вкладка «Сеть» страницы: при обычной работе нет запросов `/users?ids`, `/chats/:id/members`, `/users/:id/music`.
- [ ] Обновление со старой версии (v3): неотправленное сообщение, набранное до обновления, уходит после.
