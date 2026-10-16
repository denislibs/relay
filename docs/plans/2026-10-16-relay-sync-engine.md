# Relay Sync Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Headless-движок клиента в `packages/sync-engine`: локальная база в IndexedDB, синхронизация с сервером этапа 1, очередь отправки, указатель прочтения и живые подписки с патчами; хосты SharedWorker и Dedicated Worker (с выбором лидера) и клиент для главного потока.

**Architecture:** `Engine` владеет доменным состоянием (`Store`: чаты + сообщения, ленивая подгрузка сообщений чата из IDB), пишет его в IDB пачками вместе с `lastSeq`, синхронизируется через WebSocket (`hello` → `sync since lastSeq`, `poke` → `sync`, `tooLong` → снимок по HTTP). Интерфейс общается с движком только через подписки (`watch(query)` → `snapshot`, затем `diff`) и действия (`call(action)`). `HostCore` раздаёт подписки нескольким клиентам-портам; хосты: SharedWorker (порты вкладок) и Dedicated Worker (лидер по Web Locks, остальные вкладки — виртуальные порты через BroadcastChannel).

**Tech Stack:** TypeScript, Bun 1.4.2, IndexedDB (в тестах `fake-indexeddb@6.2.5`), WebSocket, BroadcastChannel, Web Locks, MessageChannel; тесты — `bun test` в Docker против настоящего сервера этапа 1 (`apps/server`).

## Global Constraints

- Всё запускается в Docker: новый сервис `test-engine` в compose (`working_dir: /app/packages/sync-engine`, база `relay_test`).
- Ключ сообщения на клиенте — `clientId` (uuid): одинаков для локального черновика, ack и `newMessage` с сервера → слияние без дублей.
- `lastSeq` пишется в IDB в той же транзакции, что и применённые изменения.
- Сообщение создаётся локально со статусом `pending` сразу, без сети; статусы: `pending` → `sent` (ack) → `read` (`readBy`), `failed` при неповторяемой ошибке.
- Указатель прочтения монотонен; `seen` от UI схлопывается: не чаще одного `read` на чат за `readFlushMs` (по умолчанию 1000 мс); неотправленные указатели переживают перезапуск (`pendingReads`).
- Патчи подписок отправляются не чаще раза в `frameMs` (по умолчанию 16 мс): сначала `snapshot`, дальше только `diff` (`upsert` / `remove` / `order`).
- Подписки этапа: `chatList`, `messages`, `counters`.
- Первый вход и `tooLong`: `hello` → seq S → снимок `GET /chats` → `lastSeq = S` → `sync since S`; сообщения с `id ≤ последнего id из снимка` не увеличивают `unread` повторно.
- Хост-протокол версионирован: клиент шлёт `{t:'hello', build}`; при несовпадении хост отвечает `{t:'reload'}`.

## File Structure

```
packages/sync-engine/
  package.json                 @relay/sync-engine, deps: @relay/protocol; dev: fake-indexeddb
  bunfig.toml                  preload: test/setup.ts (fake-indexeddb + миграции сервера)
  src/types.ts                 LocalChat, LocalMessage, Query, Patch, Action, EngineConfig
  src/idb.ts                   openDb, put/delete батчем, getAll, getByChat
  src/store.ts                 Store: состояние в памяти + грязные ключи + flush в IDB
  src/queries.ts               вычисление результатов подписок + diff
  src/transport.ts             WsTransport: соединение, переподключение с backoff, кадры
  src/engine.ts                Engine: bootstrap, sync, apply, outbox, reads, watch/call
  src/host-core.ts             HostCore: клиенты-порты, подписки, батч патчей, hello/версия
  src/hosts/shared.worker.ts   SharedWorker: onconnect → core.attach, пульс
  src/hosts/dedicated.ts       createDedicatedHost: лидер (Web Locks) + BroadcastChannel
  src/hosts/dedicated.worker.ts точка входа Dedicated Worker
  src/client.ts                EngineClient (главный поток) + Mirror + connectEngine
  src/index.ts                 публичный экспорт
  test/setup.ts, test/helpers.ts
  test/store.test.ts, queries.test.ts, engine.test.ts, outbox.test.ts, reads.test.ts, hosts.test.ts
```

## Interfaces (общие для всех задач)

```ts
// types.ts
export type Status = 'pending' | 'sent' | 'read' | 'failed';
export interface LocalMessage { key: string; clientId: string; id: number | null; chatId: number; senderId: number; body: string; replyToId: number | null; createdAt: string; status: Status; sort: number }
export interface LocalChat { id: number; kind: 'direct' | 'group'; title: string | null; lastReadId: number; unread: number; knownMaxId: number; peerReadUpTo: number; last: LocalMessage | null; lastAt: string }
export type Query =
  | { kind: 'chatList'; limit: number }
  | { kind: 'messages'; chatId: number; limit: number }
  | { kind: 'counters' };
export type Patch =
  | { op: 'snapshot'; items: Item[]; order: string[] }
  | { op: 'diff'; upsert: Item[]; remove: string[]; order?: string[] };
export type Item = { key: string } & Record<string, unknown>;
export type Action =
  | { type: 'sendMessage'; chatId: number; body: string; replyToId?: number | null }
  | { type: 'seen'; chatId: number; upToId: number }
  | { type: 'loadOlder'; chatId: number }
  | { type: 'retry'; clientId: string };
export interface EngineConfig { userId: number; dbName: string; httpBase: string; wsUrl: string; authHeaders?: () => Record<string, string>; frameMs?: number; readFlushMs?: number; backoffMs?: [number, number] }

// engine.ts
export interface WatchHandle { update(q: Query): void; close(): void }
export class Engine {
  static open(cfg: EngineConfig): Promise<Engine>;
  watch(q: Query, onPatch: (p: Patch) => void): WatchHandle;
  call(a: Action): Promise<unknown>;          // sendMessage → { clientId }
  connect(): void; disconnect(): void;        // сеть вкл/выкл (офлайн в тестах)
  whenIdle(): Promise<void>;                  // нет незавершённой синхронизации/отправки/патчей
  close(): Promise<void>;
}

// host-core.ts — протокол порта
type ToHost = { t: 'hello'; build: string } | { t: 'watch' | 'update'; sub: number; query: Query } | { t: 'unwatch'; sub: number } | { t: 'call'; id: number; action: Action } | { t: 'ping' } | { t: 'bye' };
type FromHost = { t: 'patches'; items: { sub: number; patch: Patch }[] } | { t: 'result'; id: number; ok: boolean; value?: unknown; error?: string } | { t: 'reload' } | { t: 'pong' };
export interface PortLike { post(msg: FromHost): void; onMessage(cb: (msg: ToHost) => void): void }
```

---

### Task 1: Пакет, IndexedDB и Store с сохранением
**Files:** `package.json`, `bunfig.toml`, `src/types.ts`, `src/idb.ts`, `src/store.ts`, `test/setup.ts`, `test/helpers.ts`, `test/store.test.ts`; Modify: `apps/server/Dockerfile` (копировать `packages/sync-engine/package.json`), `docker-compose.yml` (сервис `test-engine`).

- [ ] Тест `store.test.ts`: применить к Store `newMessage` и `readOwn`, `flush()` вместе с `lastSeq=2`, открыть второй Store на той же базе → чаты, последнее сообщение, `lastReadId`, `lastSeq` восстановлены; сообщения чата лениво грузятся `loadChatMessages(chatId)` в порядке `sort`.
- [ ] Тест: повторный `newMessage` с тем же `clientId` не дублирует сообщение и не увеличивает `unread`; `newMessage` своего сообщения не увеличивает `unread`; `id ≤ knownMaxId` не увеличивает `unread`.
- [ ] Реализация `idb.ts` (обёртка над IDB: stores `chats`(id), `messages`(key, index `byChat` = [chatId, sort]), `outbox`(clientId), `pendingReads`(chatId), `meta`(k)) и `store.ts`.
- [ ] `docker compose run --rm --build test-engine bun test test/store.test.ts` → PASS. Commit.

### Task 2: Подписки и патчи
**Files:** `src/queries.ts`, `test/queries.test.ts`.
- [ ] Тест: `chatList` упорядочен по `lastAt` убыв.; первый вызов → `snapshot`; изменение одного чата → `diff` с одним `upsert` и новым `order` только если порядок изменился; удаление → `remove`; одинаковый результат → патча нет. `messages` — последние `limit` по `sort`. `counters` — `{unreadChats, unreadMessages}`.
- [ ] Реализация: `computeQuery(store, q): {items, order}` и `diffResults(prev, next): Patch | null` (сравнение элементов по стабильной сериализации).
- [ ] PASS. Commit.

### Task 3: Транспорт и синхронизация
**Files:** `src/transport.ts`, `src/engine.ts`, `test/engine.test.ts`.
- [ ] Тест (сервер этапа 1 запускается в процессе теста): два движка A и B; B смотрит `chatList` и `messages`; A отправляет через сервер → B получает `poke` → `sync` → патч с сообщением и `unread=1`.
- [ ] Тест: первый вход с пустой базой при уже существующих сообщениях → снимок `/chats`, `unread` из снимка не удваивается последующим `sync`.
- [ ] Тест: `tooLong` (журнал B очищен на сервере, у B старый `lastSeq`) → движок берёт снимок и продолжает.
- [ ] Тест: `loadOlder` подгружает историю по HTTP и расширяет подписку.
- [ ] Реализация транспорта (backoff `[250, 5000]`, `onOpen/onFrame/onClose`) и `Engine` (bootstrap, цикл `sync` с `more`, `poke`, применение, flush, планирование патчей раз в `frameMs`).
- [ ] PASS. Commit.

### Task 4: Outbox и ReadTracker
**Files:** Modify `src/engine.ts`; `test/outbox.test.ts`, `test/reads.test.ts`.
- [ ] Тест outbox: `disconnect()` → `sendMessage` → в подписке сразу `pending`; переоткрыть движок с той же базой (перезапуск вкладки) → сообщение и очередь на месте; `connect()` → `sent`, у собеседника появилось ровно одно сообщение; порядок трёх офлайн-сообщений сохраняется.
- [ ] Тест: неповторяемая ошибка (пустое тело) → `failed`; `retry` переотправляет.
- [ ] Тест reads: B шлёт 20 `seen` подряд → на сервер уходит один `read` с максимумом; `unread` гаснет сразу локально; у A статус своего сообщения → `read`; `seen` в офлайне переживает перезапуск и уходит после подключения.
- [ ] Реализация: очередь по порядку, один кадр в полёте, `ack`/`err` по `reqId`; ReadTracker с `pendingReads`.
- [ ] PASS. Commit.

### Task 5: Хосты и клиент
**Files:** `src/host-core.ts`, `src/hosts/shared.worker.ts`, `src/hosts/dedicated.ts`, `src/hosts/dedicated.worker.ts`, `src/client.ts`, `src/index.ts`, `test/hosts.test.ts`.
- [ ] Тест HostCore через `MessageChannel`: два клиента подписаны на разные чаты → каждый получает только свои патчи; `call(sendMessage)` → `result` с `clientId`; несовпадение `build` → `reload`; `bye` снимает подписки клиента.
- [ ] Тест Dedicated: две «вкладки» с общим фейковым `locks` и BroadcastChannel → первая лидер, вторая проксирует; подписка второй получает патчи; лидер закрывается → вторая становится лидером, переподписывается и продолжает получать патчи.
- [ ] Тест `Mirror`: применение `snapshot`/`diff` даёт тот же список, что и прямой `computeQuery`.
- [ ] PASS. Полный прогон `docker compose run --rm test && docker compose run --rm test-engine`. Commit.
