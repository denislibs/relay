# Несколько процессов сервера и Valkey (этап 2 бэкенда) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** сервер Relay работает корректно в нескольких процессах за балансировщиком: «печатает…», онлайн и прямые кадры доходят до пользователя, где бы ни висел его сокет.

**Architecture:** эфемерное состояние уходит из памяти процесса в Valkey. Кадры, которые домен рассылает мимо журнала (`publish(topic, msg)`: «печатает…», присутствие, изменения контактов и приватности), идут через pub/sub Valkey: процесс подписан на топики своих сокетов и раздаёт пришедшее локально через `server.publish`. «Кто онлайн» — счётчики соединений по процессам в хэше Valkey плюс ключ-пауза после ухода; Lua-скрипт меняет счётчик и считает сумму атомарно, поэтому переходы «появился» и «ушёл» определяются по всей системе, а не по одному процессу. Транзакционное остаётся в Postgres: «есть новое» по журналу (`NOTIFY updates`) и завершение сеансов (`NOTIFY sessions`) уже работают между процессами и не меняются.

**Tech Stack:** Bun 1.4 (встроенный `RedisClient`), TypeScript, Valkey 8, PostgreSQL 17, nginx (только для проверки масштабирования), Docker Compose, `bun test`.

## Global Constraints

- Новых npm-зависимостей нет: клиент Valkey — встроенный в Bun `RedisClient`.
- Valkey хранит только эфемерное: журнал, outbox, сообщения и сеансы остаются в Postgres.
- Режим Valkey — одиночный узел (не кластер): Lua-скрипты обращаются к ключам, вычисленным внутри скрипта.
- Образ Valkey — с зафиксированным тегом (`valkey/valkey:8.1-alpine` или новее из 8.x; проверить существование тега перед использованием).
- Все ключи и каналы — с префиксом `RELAY_BUS_PREFIX` (по умолчанию `relay`, в тестах `relay_test`), чтобы тесты и dev-стек на одном Valkey не видели друг друга.
- Без кода из telegram-tt и tweb (GPL).
- Тесты — только в Docker: `docker compose --profile test run --rm test` и `docker compose --profile test run --rm test-engine`.
- Комментарии в коде — по-русски, как во всём `apps/server`.
- Номер миграции: на master последняя `117_jobs.sql`. Здесь — **`118_drop_live_conns.sql`**; если номер занят, следующий свободный.
- Работать в своей ветке; в master — только по слову пользователя.

## Решения и почему

- **Отдельный процесс Gateway пока не выделяем.** Кадры сокета (`send`, `read`, `edit`…) вызывают те же доменные функции, что и HTTP; выделение Gateway потребовало бы RPC между процессами без выигрыша на нынешнем объёме. Масштабирование даёт запуск нескольких одинаковых процессов `server` за балансировщиком, когда их состояние общее. Отдельный Gateway — когда число сокетов станет узким местом.
- **Журнальные «есть новое» остаются на `NOTIFY`.** `pg_notify` уходит только после коммита — это гарантия, которую pub/sub Valkey не даёт. Нагрузка — один LISTEN на процесс.
- **Таблица `live_conns` из этапа 1 удаляется.** Её интерфейс (`onlineUsers`) остаётся, реализация переезжает в Valkey: пишется на каждом подключении, а не раз в минуту, и смотрит на всю систему.
- **Липкие сессии на балансировщике не нужны:** после этого этапа у процесса не остаётся состояния, которое должно совпадать между HTTP-запросом и сокетом.

## File Structure

| Файл | Ответственность |
|---|---|
| `docker-compose.yml` | сервис `valkey`; `VALKEY_URL` и `RELAY_BUS_PREFIX` у `server`, `worker`, `test`, `test-engine` |
| `docker-compose.scale.yml` | второй процесс `server2` и `lb` (nginx) для ручной проверки |
| `docker/nginx/relay.conf` | балансировка HTTP и WebSocket на два процесса |
| `apps/server/src/valkey.ts` | общий клиент, префикс ключей, `flushOwn()` для тестов |
| `apps/server/src/bus.ts` | `createBus(deliver)`: публикация в Valkey, подписки по топикам со счётчиком ссылок |
| `apps/server/src/http.ts` | `publish` через шину; подписка и отписка топиков сокета |
| `apps/server/src/domain/liveRegistry.ts` | реестр онлайна на Valkey: `processAlive`, `connect`, `disconnect`, `connectionCount`, `onlineUsers` |
| `apps/server/src/domain/presence.ts` | переходы «появился/ушёл» по всей системе; `presenceFor` получает `online` параметром |
| `apps/server/src/domain/contacts.ts` | передаёт `online` в `presenceFor` |
| `apps/server/src/realtime.ts` | отметка «процесс жив» каждые 30 с вместо `heartbeat()` раз в минуту |
| `apps/server/migrations/118_drop_live_conns.sql` | удаление таблицы |
| `apps/server/test/helpers.ts`, `packages/sync-engine/test/helpers.ts` | чистка ключей Valkey в `resetDb` |
| `apps/server/test/valkey.test.ts` | клиент и префикс |
| `apps/server/test/bus.test.ts` | два сервера в одном процессе: «печатает…» доходит через шину |
| `apps/server/test/liveRegistry.test.ts` | реестр онлайна (переписан) |
| `apps/server/test/multiprocess.test.ts` | два настоящих процесса сервера: присутствие, «печатает…», сообщения, push |

---

### Task 1: Valkey в стеке и клиент

**Files:**
- Modify: `docker-compose.yml`
- Create: `apps/server/src/valkey.ts`
- Modify: `apps/server/test/helpers.ts`, `packages/sync-engine/test/helpers.ts`
- Test: `apps/server/test/valkey.test.ts`

**Interfaces:**
- Produces:
  - `valkey(): RedisClient` — общий клиент процесса (ленивый, бросает, если нет `VALKEY_URL`)
  - `PREFIX: string` — `${RELAY_BUS_PREFIX ?? 'relay'}:`
  - `key(k: string): string` — `PREFIX + k`
  - `flushOwn(): Promise<void>` — удалить все ключи с префиксом (тесты)

- [ ] **Step 1: Проверить API клиента Bun**

Run: `docker compose run --rm --no-deps server bun -e "const { RedisClient } = await import('bun'); console.log(typeof RedisClient.prototype.subscribe, typeof RedisClient.prototype.duplicate, typeof RedisClient.prototype.send)"`
Expected: `function function function`. Если чего-то нет — в Bun 1.4.2 API отличается: свериться с `https://bun.com/docs/runtime/redis` и поправить код задач 1–2 под фактические имена методов.

- [ ] **Step 2: Сервис и переменные окружения**

В `docker-compose.yml` добавить сервис (рядом с `postgres`):

```yaml
  valkey:
    image: valkey/valkey:8.1-alpine
    command: ["valkey-server", "--save", "", "--appendonly", "no"]   # только эфемерное: без записи на диск
    ports: ["6380:6379"]
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 30
```

У сервисов `server` и `worker` в `environment` добавить `VALKEY_URL: redis://valkey:6379`, в `depends_on` — `valkey: { condition: service_healthy }`.
У сервисов `test` и `test-engine` — `VALKEY_URL: redis://valkey:6379`, `RELAY_BUS_PREFIX: relay_test` и тот же `depends_on`.

- [ ] **Step 3: Тест клиента**

`apps/server/test/valkey.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { flushOwn, key, PREFIX, valkey } from '../src/valkey';

test('keys carry the test prefix; flushOwn removes only them', async () => {
  expect(PREFIX).toBe('relay_test:');
  await valkey().set(key('probe'), '1');
  await valkey().set('foreign:probe', '1');
  await flushOwn();
  expect(await valkey().get(key('probe'))).toBeNull();
  expect(await valkey().get('foreign:probe')).toBe('1');
  await valkey().del('foreign:probe');
});
```

- [ ] **Step 4: Убедиться, что тест падает**

Run: `docker compose --profile test run --rm test bun test valkey`
Expected: FAIL — `Cannot find module '../src/valkey'`.

- [ ] **Step 5: Клиент**

`apps/server/src/valkey.ts`:

```ts
import { RedisClient } from 'bun';

/**
 * Valkey — только эфемерное состояние (онлайн, «печатает…», рассылка кадров между процессами).
 * Всё, что должно пережить перезапуск, — в Postgres. Ключи и каналы с префиксом: тесты и dev-стек
 * на одном Valkey друг друга не видят.
 */
let client: RedisClient | null = null;

export function valkey(): RedisClient {
  if (!client) {
    const url = process.env.VALKEY_URL;
    if (!url) throw new Error('VALKEY_URL is not set');
    client = new RedisClient(url);
  }
  return client;
}

export const PREFIX = (process.env.RELAY_BUS_PREFIX ?? 'relay') + ':';
export const key = (k: string): string => PREFIX + k;

/** Тесты: удалить свои ключи (по префиксу), чужие не трогать. */
export async function flushOwn(): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = (await valkey().send('SCAN', [cursor, 'MATCH', PREFIX + '*', 'COUNT', '500'])) as [string, string[]];
    cursor = next;
    if (keys.length) await valkey().send('DEL', keys);
  } while (cursor !== '0');
}
```

- [ ] **Step 6: Чистка в тестах**

`apps/server/test/helpers.ts`, в начало `resetDb`:

```ts
import { flushOwn } from '../src/valkey';
```

```ts
export async function resetDb(): Promise<void> {
  await flushOwn();   // онлайн и прочее эфемерное прошлых тестов
  await sql`truncate …`;   // строка truncate — без изменений
```

То же в `packages/sync-engine/test/helpers.ts` (импорт из `'../../../apps/server/src/valkey'`), первой строкой `resetDb`.

- [ ] **Step 7: Тесты проходят**

Run: `docker compose --profile test run --rm test bun test valkey && docker compose --profile test run --rm test`
Expected: PASS; весь набор — 0 fail.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml apps/server/src/valkey.ts apps/server/test/valkey.test.ts apps/server/test/helpers.ts packages/sync-engine/test/helpers.ts
git commit -m "feat(server): Valkey in the stack for ephemeral state; prefixed keys, per-test cleanup"
```

---

### Task 2: Рассылка кадров между процессами

**Зачем:** `publish` сейчас — `server.publish` Bun, он доходит только до сокетов этого процесса. «Печатает…» от пользователя на процессе A не дойдёт до собеседника на процессе B.

**Files:**
- Create: `apps/server/src/bus.ts`
- Modify: `apps/server/src/http.ts` (строка `const publish: Publish = …` и обработчики `websocket.open` / `websocket.close`)
- Test: `apps/server/test/bus.test.ts`

**Interfaces:**
- Consumes: `valkey`, `key` (Task 1).
- Produces:
  - `interface Bus { publish(topic: string, msg: string): void; listen(topic: string): Promise<void>; unlisten(topic: string): Promise<void>; close(): Promise<void> }`
  - `createBus(deliver: (topic: string, msg: string) => void): Bus`

- [ ] **Step 1: Тест — два сервера, один пользователь на каждом**

`apps/server/test/bus.test.ts`:

```ts
import type { ServerFrame } from '@relay/protocol';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { resetPresence } from '../src/domain/presence';
import { createServer } from '../src/http';
import { nextFrame, resetDb } from './helpers';

// у каждого сервера своя шина и своё подключение-подписчик — как у двух процессов
const s1 = createServer({ port: 0 }), s2 = createServer({ port: 0 });
afterAll(async () => { await s1.stop(true); await s2.stop(true); });
beforeEach(async () => { await resetDb(); resetPresence(); });

const base = (s: typeof s1) => `http://localhost:${s.port}`;
async function login(name: string) {
  return (await (await fetch(`${base(s1)}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
}
async function connect(s: typeof s1, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${s.port}/ws?token=${token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}

test('typing from a socket on one server reaches the peer on another', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const { id: chatId } = (await (await fetch(`${base(s1)}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number };
  const wa = await connect(s1, a.token), wb = await connect(s2, b.token);
  const got = nextFrame(wb, (f) => f.op === 'typing');
  wa.send(JSON.stringify({ op: 'typing', chatId }));
  expect(await got).toEqual({ op: 'typing', chatId, userId: a.userId } satisfies ServerFrame);
  wa.close(); wb.close();
});

test('a closed socket stops receiving: the topic is unsubscribed when the last socket leaves', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const { id: chatId } = (await (await fetch(`${base(s1)}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number };
  const wa = await connect(s1, a.token);
  const wb1 = await connect(s2, b.token), wb2 = await connect(s2, b.token);
  wb1.close();
  await Bun.sleep(50);
  const got = nextFrame(wb2, (f) => f.op === 'typing');   // второй сокет того же пользователя всё ещё получает
  wa.send(JSON.stringify({ op: 'typing', chatId }));
  expect(await got).toMatchObject({ op: 'typing', userId: a.userId });
  wa.close(); wb2.close();
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `docker compose --profile test run --rm test bun test bus`
Expected: FAIL — первый тест ждёт `typing` и падает с `timeout waiting for frame`.

- [ ] **Step 3: Шина**

`apps/server/src/bus.ts`:

```ts
import type { RedisClient } from 'bun';
import { key, valkey } from './valkey';

/**
 * Кадры мимо журнала («печатает…», присутствие, изменения контактов) — между процессами через pub/sub Valkey.
 * Процесс подписан на топики своих сокетов (счётчик ссылок: подписка — с первым сокетом, отписка — с последним)
 * и раздаёт пришедшее локально через deliver (server.publish). Свои публикации приходят так же — отдельной
 * локальной доставки нет, иначе кадр пришёл бы дважды. Доставка «как получится»: это не данные.
 */
export interface Bus {
  publish(topic: string, msg: string): void;
  listen(topic: string): Promise<void>;
  unlisten(topic: string): Promise<void>;
  close(): Promise<void>;
}

export function createBus(deliver: (topic: string, msg: string) => void): Bus {
  const refs = new Map<string, number>();
  let sub: Promise<RedisClient> | null = null;
  // подписка занимает соединение целиком — отдельное от команд
  const subscriber = () => (sub ??= (async () => { await valkey().connect(); return valkey().duplicate(); })());
  const channel = (topic: string) => key('t:' + topic);
  return {
    publish(topic, msg) {
      valkey().publish(channel(topic), msg).catch((e) => console.error('bus publish:', e));
    },
    async listen(topic) {
      const n = (refs.get(topic) ?? 0) + 1;
      refs.set(topic, n);
      if (n === 1) await (await subscriber()).subscribe(channel(topic), (msg: string) => deliver(topic, msg));
    },
    async unlisten(topic) {
      const n = (refs.get(topic) ?? 0) - 1;
      if (n > 0) { refs.set(topic, n); return; }
      refs.delete(topic);
      // команды идут по одному соединению по порядку: быстрые «отписка → подписка» не перепутаются
      await (await subscriber()).unsubscribe(channel(topic));
    },
    async close() {
      if (sub) (await sub).close();
      sub = null;
      refs.clear();
    },
  };
}
```

- [ ] **Step 4: Подключить в http.ts**

В `apps/server/src/http.ts`:

```ts
import { createBus } from './bus';
```

Заменить строку `const publish: Publish = (topic, msg) => { server.publish(topic, msg); };` на:

```ts
  // кадры мимо журнала — через Valkey, чтобы дошли до сокетов в любом процессе
  const bus = createBus((topic, msg) => { server.publish(topic, msg); });
  const publish: Publish = (topic, msg) => bus.publish(topic, msg);
```

Обработчики сокета:

```ts
      async open(ws) {
        ws.subscribe(`user:${ws.data.userId}`);
        ws.subscribe(`session:${ws.data.sessionId}`);
        // подписка в Valkey — до объявления «в сети»: ответные кадры собеседников не должны потеряться
        await Promise.all([bus.listen(`user:${ws.data.userId}`), bus.listen(`session:${ws.data.sessionId}`)])
          .catch((err) => console.error('bus:', err));
        trackSocket(ws.data.sessionId, ws);
        countSocket(ws.data.userId, 1);
        connected(publish, ws.data.userId).catch((err) => console.error('presence:', err));
      },
      close(ws) {
        untrackSocket(ws.data.sessionId, ws);
        countSocket(ws.data.userId, -1);
        disconnected(publish, ws.data.userId);
        void bus.unlisten(`user:${ws.data.userId}`).catch((err) => console.error('bus:', err));
        void bus.unlisten(`session:${ws.data.sessionId}`).catch((err) => console.error('bus:', err));
      },
```

И закрывать шину вместе с сервером — перед `return server;`:

```ts
  // остановка сервера закрывает и соединение-подписчик (иначе тесты и процесс не завершатся)
  const stop = server.stop.bind(server);
  server.stop = (async (force?: boolean) => { await bus.close(); return stop(force); }) as typeof server.stop;
```

- [ ] **Step 5: Тесты проходят**

Run: `docker compose --profile test run --rm test bun test bus presence`
Expected: PASS — 2 новых теста, `presence` без изменений.

- [ ] **Step 6: Весь набор и движок**

Run: `docker compose --profile test run --rm test && docker compose --profile test run --rm test-engine`
Expected: 0 fail в обоих. Если тесты зависают на завершении — подписчик не закрыт: проверить, что каждый тестовый `createServer` останавливается через `server.stop(...)`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/bus.ts apps/server/src/http.ts apps/server/test/bus.test.ts
git commit -m "feat(server): frames outside the journal travel between processes over Valkey pub/sub"
```

---

### Task 3: «Кто онлайн» по всей системе

**Зачем:** счётчик соединений сейчас в памяти процесса. Пользователь с вкладкой на процессе A и телефоном на процессе B: закрыл вкладку — A решит, что он ушёл, и разошлёт «был(а) в …», хотя телефон на связи.

**Files:**
- Modify: `apps/server/src/domain/liveRegistry.ts` (полностью)
- Modify: `apps/server/src/domain/presence.ts` (`isOnline`, `presenceFor`, `connected`, `disconnected`, `announcePair`, `reannounce`, `listPresence`, `resetPresence`)
- Modify: `apps/server/src/domain/contacts.ts:29`
- Modify: `apps/server/src/realtime.ts`
- Create: `apps/server/migrations/118_drop_live_conns.sql`
- Modify: `apps/server/test/helpers.ts` (убрать `live_conns` из `truncate`)
- Test: `apps/server/test/liveRegistry.test.ts` (переписать)

**Interfaces:**
- Consumes: `valkey`, `key` (Task 1).
- Produces (`liveRegistry.ts`):
  - `PROCESS_ID: string`
  - `processAlive(pid?: string): Promise<void>` — отметка «процесс жив» на 90 с
  - `processGone(pid?: string): Promise<void>` — при штатной остановке
  - `connect(userId: number, pid?: string): Promise<{ total: number; returning: boolean }>` — `total` — соединений пользователя во всех живых процессах после подключения; `returning` — вернулся в паузе после ухода
  - `disconnect(userId: number, pid?: string): Promise<number>` — `total` после отключения; при 0 ставит паузу
  - `connectionCount(userId: number): Promise<number>` — без учёта паузы
  - `onlineUsers(userIds: number[]): Promise<Set<number>>` — с учётом паузы (как раньше)
- Produces (`presence.ts`): `presenceFor(viewer: number, owner: number, lastSeenAt: unknown, ctx: PrivacyCtx, online: boolean): PresenceItem`; `isOnline` удаляется.

- [ ] **Step 1: Тесты реестра**

`apps/server/test/liveRegistry.test.ts` целиком:

```ts
import { beforeEach, expect, test } from 'bun:test';
import { connect, connectionCount, disconnect, onlineUsers, processAlive, processGone } from '../src/domain/liveRegistry';
import { resetDb } from './helpers';

process.env.RELAY_PRESENCE_GRACE_MS = '300';
beforeEach(resetDb);

const P1 = 'proc-1', P2 = 'proc-2';
beforeEach(async () => { await processAlive(P1); await processAlive(P2); });

test('totals count sockets across processes', async () => {
  expect(await connect(7, P1)).toEqual({ total: 1, returning: false });
  expect(await connect(7, P2)).toEqual({ total: 2, returning: false });
  expect(await connect(7, P2)).toEqual({ total: 3, returning: false });
  expect(await disconnect(7, P1)).toBe(2);
  expect(await connectionCount(7)).toBe(2);
});

test('last socket gone: online during the pause, then offline; coming back in the pause is "returning"', async () => {
  await connect(7, P1);
  expect(await disconnect(7, P1)).toBe(0);
  expect(await onlineUsers([7, 8])).toEqual(new Set([7]));      // пауза: перезагрузка вкладки — не уход
  expect(await connectionCount(7)).toBe(0);
  expect(await connect(7, P2)).toEqual({ total: 1, returning: true });
  await disconnect(7, P2);
  await Bun.sleep(400);
  expect(await onlineUsers([7])).toEqual(new Set());
});

test('a dead process does not count, and its stale counts are dropped', async () => {
  await connect(7, P1);
  await processGone(P1);
  expect(await connectionCount(7)).toBe(0);
  expect(await onlineUsers([7])).toEqual(new Set());
  await processAlive(P1);                                        // тот же id снова жив — старый счётчик уже стёрт
  expect(await connect(7, P2)).toEqual({ total: 1, returning: false });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `docker compose --profile test run --rm test bun test liveRegistry`
Expected: FAIL — `connect is not exported` (или аналогичная ошибка импорта).

- [ ] **Step 3: Реестр на Valkey**

`apps/server/src/domain/liveRegistry.ts` целиком:

```ts
import { key, PREFIX, valkey } from '../valkey';

/**
 * Кто онлайн — по всей системе. presence:<user> — хэш «процесс → число сокетов»; proc:<pid> — процесс жив
 * (ставится каждые 30 с на 90 с); left:<user> — пауза после ухода последнего сокета (перезагрузка вкладки
 * не «уход»). Скрипты меняют счётчик и считают сумму атомарно; счётчики умерших процессов стираются по пути.
 * Одиночный узел Valkey: скрипты обращаются к ключам proc:*, вычисленным внутри.
 */
export const PROCESS_ID = crypto.randomUUID();
const ALIVE_SEC = 90;
const graceMs = () => Number(process.env.RELAY_PRESENCE_GRACE_MS ?? 4000);

// сумма по живым процессам; поля умерших удаляются (KEYS[1] — presence:<user>, ARGV[1] — префикс)
const SUM = `
local function total(h, prefix)
  local t, f = 0, redis.call('HGETALL', h)
  for i = 1, #f, 2 do
    if redis.call('EXISTS', prefix .. 'proc:' .. f[i]) == 1 then t = t + tonumber(f[i + 1])
    else redis.call('HDEL', h, f[i]) end
  end
  return t
end`;

const CONNECT = `${SUM}
redis.call('HINCRBY', KEYS[1], ARGV[2], 1)
local returning = redis.call('DEL', KEYS[2])
return { total(KEYS[1], ARGV[1]), returning }`;

const DISCONNECT = `${SUM}
if redis.call('HINCRBY', KEYS[1], ARGV[2], -1) <= 0 then redis.call('HDEL', KEYS[1], ARGV[2]) end
local t = total(KEYS[1], ARGV[1])
if t == 0 then redis.call('SET', KEYS[2], '1', 'PX', ARGV[3]) end
return t`;

const COUNT = `${SUM}
return total(KEYS[1], ARGV[1])`;

// ARGV[1] — префикс, ARGV[2..] — id; онлайн: есть сокеты в живом процессе или идёт пауза
const ONLINE = `${SUM}
local out = {}
for i = 2, #ARGV do
  if total(ARGV[1] .. 'presence:' .. ARGV[i], ARGV[1]) > 0 or redis.call('EXISTS', ARGV[1] .. 'left:' .. ARGV[i]) == 1 then
    out[#out + 1] = ARGV[i]
  end
end
return out`;

const run = (script: string, keys: string[], args: (string | number)[]) =>
  valkey().send('EVAL', [script, String(keys.length), ...keys, ...args.map(String)]);

export async function processAlive(pid = PROCESS_ID): Promise<void> {
  await valkey().send('SET', [key('proc:' + pid), '1', 'EX', String(ALIVE_SEC)]);
}

export async function processGone(pid = PROCESS_ID): Promise<void> {
  await valkey().send('DEL', [key('proc:' + pid)]);
}

export async function connect(userId: number, pid = PROCESS_ID): Promise<{ total: number; returning: boolean }> {
  const [total, returning] = (await run(CONNECT, [key(`presence:${userId}`), key(`left:${userId}`)], [PREFIX, pid])) as [number, number];
  return { total: Number(total), returning: Number(returning) === 1 };
}

export async function disconnect(userId: number, pid = PROCESS_ID): Promise<number> {
  return Number(await run(DISCONNECT, [key(`presence:${userId}`), key(`left:${userId}`)], [PREFIX, pid, graceMs()]));
}

export async function connectionCount(userId: number): Promise<number> {
  return Number(await run(COUNT, [key(`presence:${userId}`)], [PREFIX]));
}

export async function onlineUsers(userIds: number[]): Promise<Set<number>> {
  if (!userIds.length) return new Set();
  const ids = (await run(ONLINE, [], [PREFIX, ...userIds])) as (string | number)[];
  return new Set(ids.map(Number));
}
```

- [ ] **Step 4: Процесс отмечается живым**

`apps/server/src/realtime.ts`: заменить импорт `heartbeat` на `processAlive`; отметиться сразу при старте (до приёма сокетов) и каждые 30 с; при остановке — `processGone`:

```ts
import { processAlive, processGone } from './domain/liveRegistry';
```

В начале `startRealtime`:

```ts
  await processAlive();   // до первого сокета: иначе его счётчик не попадёт в сумму
  const alive = setInterval(() => { processAlive().catch((e) => console.error('live registry:', e)); }, 30_000);
  alive.unref?.();
```

В ежеминутном таймере убрать строку с `heartbeat()`. В возвращаемой функции остановки добавить `clearInterval(alive); await processGone().catch(() => {});`.

Серверы, созданные в тестах без `startRealtime` (`createServer` напрямую), тоже должны считаться живыми: в `createServer` (`http.ts`) перед `return server;` добавить `void processAlive().catch((e) => console.error('live registry:', e));`.

- [ ] **Step 5: Переходы присутствия по всей системе**

`apps/server/src/domain/presence.ts`:

1. Импорт: `import { connect, connectionCount, disconnect, onlineUsers } from './liveRegistry';` вместо `markOffline, markOnline`.
2. Удалить `const conns`, функцию `isOnline` и (если больше не используется) `toRegistry` заменить на ту же очередь по пользователю под именем `serial`:

```ts
// подключения и отключения одного пользователя в этом процессе — по очереди: «ушёл → вернулся» не перепутаются
const queue = new Map<number, Promise<unknown>>();
function serial<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const next = (queue.get(userId) ?? Promise.resolve()).then(fn, fn);
  queue.set(userId, next);
  void next.finally(() => { if (queue.get(userId) === next) queue.delete(userId); }).catch(() => {});
  return next;
}
```

3. `presenceFor` получает `online` параметром:

```ts
export function presenceFor(viewer: number, owner: number, lastSeenAt: unknown, ctx: PrivacyCtx, online: boolean): PresenceItem {
  return canSeeLastSeen(viewer, owner, ctx) ? { userId: owner, online, lastSeen: iso(lastSeenAt) } : hidden(owner);
}
```

4. Вызовы `presenceFor` — передать онлайн из реестра:
   - `announcePair`: перед циклом `const online = await onlineUsers([c.a, c.b]);`, в вызове — `presenceFor(v, o, seen.get(o), c.after, online.has(o))`.
   - `reannounce`: `const on = (await onlineUsers([userId])).has(userId);`, в вызове — `presenceFor(peer, userId, row?.last_seen_at, ctx, on)`.
   - `listPresence`: `const online = await onlineUsers(rows.map((r) => Number(r.id)));`, в вызове — `presenceFor(userId, Number(r.id), r.last_seen_at, ctx, online.has(Number(r.id)))`.
   - `apps/server/src/domain/contacts.ts:29`: `const p = presenceFor(owner, r.id, lastSeen, ctx, (await onlineUsers([Number(r.id)])).has(Number(r.id)));` и импорт `onlineUsers` из `./liveRegistry`.

5. `connected` и `disconnected`:

```ts
export async function connected(publish: Publish, userId: number): Promise<void> {
  const pending = leaving.get(userId);
  if (pending) { clearTimeout(pending); leaving.delete(userId); }
  const { total, returning } = await serial(userId, () => connect(userId));
  // первый сокет во всей системе и не возврат в паузе — собеседникам «в сети»
  if (total === 1 && !returning) await announce(publish, { userId, online: true, lastSeen: null });
}

export function disconnected(publish: Publish, userId: number): void {
  void serial(userId, () => disconnect(userId)).then((total) => {
    if (total > 0) return;                         // ещё есть сокеты — здесь или в другом процессе
    leaving.set(userId, setTimeout(async () => {
      leaving.delete(userId);
      if ((await connectionCount(userId)) > 0) return;   // вернулся за паузу, в любом процессе
      const [row] = await sql`update users set last_seen_at = now() where id = ${userId} returning last_seen_at`;
      await announce(publish, { userId, online: false, lastSeen: row ? iso(row.last_seen_at) : null });
    }, graceMs()));
  }).catch((e) => console.error('presence:', e));
}
```

6. `resetPresence` — только локальные таймеры (ключи Valkey чистит `resetDb` через `flushOwn`):

```ts
export function resetPresence(): void {
  for (const t of leaving.values()) clearTimeout(t);
  leaving.clear();
  queue.clear();
}
```

7. Шапку-комментарий файла заменить: «Кто в сети — по всей системе (liveRegistry.ts, Valkey). “В сети” объявляем на первом сокете во всех процессах, “не в сети” — через GRACE_MS после последнего; таймер ставит процесс, на котором ушёл последний сокет. Рассылка собеседникам — через шину (publish), мимо журнала. Правило “Последний визит” …» — абзац про приватность оставить как есть.

- [ ] **Step 6: Таблица больше не нужна**

`apps/server/migrations/118_drop_live_conns.sql`:

```sql
-- «кто онлайн» переехал в Valkey (liveRegistry.ts)
drop table if exists live_conns;
```

`apps/server/test/helpers.ts`: убрать `live_conns` из списка `truncate`.

- [ ] **Step 7: Не осталось старого**

Run: `grep -rn "isOnline\|markOnline\|markOffline\|heartbeat\|live_conns" apps/server/src apps/server/test packages/sync-engine/test`
Expected: пусто, кроме миграций `117_jobs.sql` и `118_drop_live_conns.sql`. Тест push «an online recipient (any process) gets no push» вставляет строку в `live_conns` — переписать на реестр:

```ts
  await processAlive('other-proc');
  await connect(b, 'other-proc');
```

(импорт `connect`, `processAlive` из `../src/domain/liveRegistry`).

- [ ] **Step 8: Тесты проходят**

Run: `docker compose --profile test run --rm test && docker compose --profile test run --rm test-engine`
Expected: 0 fail; `liveRegistry` — 3 теста, `presence`, `contacts`, `privacy`, `push` — зелёные.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/domain/liveRegistry.ts apps/server/src/domain/presence.ts apps/server/src/domain/contacts.ts apps/server/src/realtime.ts apps/server/src/http.ts apps/server/migrations/118_drop_live_conns.sql apps/server/test
git commit -m "feat(server): online state across processes in Valkey — atomic per-process counters, grace key, dead processes ignored"
```

---

### Task 4: Два настоящих процесса — тест и стенд

**Files:**
- Test: `apps/server/test/multiprocess.test.ts`
- Create: `docker-compose.scale.yml`
- Create: `docker/nginx/relay.conf`

**Interfaces:**
- Consumes: всё из Task 1–3; `drainJobs` и `'../src/jobs/kinds'` из этапа 1.

- [ ] **Step 1: Тест с двумя процессами**

`apps/server/test/multiprocess.test.ts`:

```ts
import type { ServerFrame } from '@relay/protocol';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { nextFrame, resetDb } from './helpers';

// два отдельных процесса сервера (main.ts): своя память, общие Postgres и Valkey — как за балансировщиком
const PORTS = [3101, 3102];
const procs: ReturnType<typeof Bun.spawn>[] = [];

beforeAll(async () => {
  await resetDb();
  for (const port of PORTS) {
    procs.push(Bun.spawn(['bun', 'src/main.ts'], { cwd: import.meta.dir + '/..', env: { ...process.env, PORT: String(port), RELAY_PRESENCE_GRACE_MS: '200' }, stdout: 'inherit', stderr: 'inherit' }));
  }
  for (const port of PORTS) {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`http://localhost:${port}/health`).then((r) => r.ok, () => false)) break;
      await Bun.sleep(100);
    }
  }
});
afterAll(async () => { for (const p of procs) p.kill(); await Promise.all(procs.map((p) => p.exited)); });

const base = (i: number) => `http://localhost:${PORTS[i]}`;
async function login(name: string) {
  return (await (await fetch(`${base(0)}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
}
async function connect(i: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${PORTS[i]}/ws?token=${token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}

test('presence, typing and new messages cross processes; a second device keeps the user online', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const { id: chatId } = (await (await fetch(`${base(0)}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number };
  const wb = await connect(1, b.token);

  // Анна появляется на процессе 0 — Борис на процессе 1 видит «в сети»
  const online = nextFrame(wb, (f) => f.op === 'presence');
  const wa1 = await connect(0, a.token);
  expect(((await online) as Extract<ServerFrame, { op: 'presence' }>).items[0]).toMatchObject({ userId: a.userId, online: true });

  // «печатает…» — через шину
  const typing = nextFrame(wb, (f) => f.op === 'typing');
  wa1.send(JSON.stringify({ op: 'typing', chatId }));
  expect(await typing).toMatchObject({ op: 'typing', userId: a.userId });

  // сообщение — через журнал и NOTIFY
  const poke = nextFrame(wb, (f) => f.op === 'poke');
  wa1.send(JSON.stringify({ op: 'send', reqId: 'r1', chatId, clientId: crypto.randomUUID(), body: 'привет' }));
  await poke;

  // второе устройство Анны на процессе 1; закрытие первого не делает её «не в сети»
  const wa2 = await connect(1, a.token);
  const frames: ServerFrame[] = [];
  wb.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data))));
  wa1.close();
  await Bun.sleep(500);
  expect(frames.filter((f) => f.op === 'presence')).toEqual([]);

  // ушло последнее устройство — «не в сети» после паузы
  const offline = nextFrame(wb, (f) => f.op === 'presence', 3000);
  wa2.close();
  expect(((await offline) as Extract<ServerFrame, { op: 'presence' }>).items[0]).toMatchObject({ userId: a.userId, online: false });
  wb.close();
});
```

(Если кадр `send` в протоколе называется иначе или требует других полей — взять форму из `packages/protocol/src/index.ts`, `ClientFrame`.)

- [ ] **Step 2: Прогон**

Run: `docker compose --profile test run --rm test bun test multiprocess`
Expected: PASS. Если упало на «второе устройство» — смотреть `disconnect`/`connectionCount`; на «печатает…» — подписку в `websocket.open`.

- [ ] **Step 3: Стенд с балансировщиком**

`docker/nginx/relay.conf`:

```nginx
upstream relay {
  server server:3000;
  server server2:3000;
}
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
  listen 80;
  location / {
    proxy_pass http://relay;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
  }
}
```

`docker-compose.scale.yml`:

```yaml
# Проверка масштабирования: docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --build
services:
  server2:
    extends: { service: server }
    ports: !reset []
  lb:
    image: nginx:1.27-alpine
    volumes:
      - ./docker/nginx/relay.conf:/etc/nginx/conf.d/default.conf:ro
    ports: ["3080:80"]
    depends_on:
      server: { condition: service_started }
      server2: { condition: service_started }
```

(Если `extends` с `depends_on` не поддерживается установленной версией Compose — скопировать блок `server` под именем `server2` целиком, без `ports`.)

- [ ] **Step 4: Ручная проверка через балансировщик**

Run: `docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --build && sleep 5 && docker compose -f docker-compose.yml -f docker-compose.scale.yml ps --format '{{.Service}} {{.State}}'`
Expected: `server`, `server2`, `lb`, `worker`, `valkey` — running.

В браузере (Playwright или chrome-devtools, два изолированных контекста, вход через `POST http://localhost:3080/dev/login`) открыть `http://localhost:3080` двумя пользователями с общим личным чатом. Перезагрузить одну из вкладок несколько раз, пока сокеты не окажутся на разных процессах (`docker compose logs server server2` или `/dev/stats`, если показывает сокеты). Проверить:
- «в сети» / «был(а) …» у собеседника меняется при закрытии и открытии вкладки;
- «печатает…» видно у собеседника;
- сообщения доходят сразу в обе стороны;
- перезагрузка вкладки не даёт мигнуть «был(а) …».

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/multiprocess.test.ts docker-compose.scale.yml docker/nginx/relay.conf
git commit -m "test(server): two real server processes share presence, typing and pokes; nginx stand for scaling checks"
```

---

### Task 5: Проверка целиком

- [ ] **Step 1: Оба набора**

Run: `docker compose --profile test run --rm test && docker compose --profile test run --rm test-engine`
Expected: 0 fail.

- [ ] **Step 2: Обычный стек (один процесс) не сломан**

Run: `docker compose -f docker-compose.yml -f docker-compose.scale.yml down && docker compose up -d --build && sleep 5 && curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/health`
Expected: `200`; в браузере на `:3000` присутствие, «печатает…» и отправка работают как раньше.

- [ ] **Step 3: Valkey недоступен**

`docker compose stop valkey`, отправить сообщение в браузере.
Expected: сообщение доходит (журнал и `NOTIFY` от Valkey не зависят), в логах `server` — ошибки `bus publish:`/`live registry:`, процесс не падает. `docker compose start valkey` — после переподключения вкладки онлайн и «печатает…» снова работают. Если процесс падает или не восстанавливается без перезапуска — исправить (обработка ошибок клиента Bun: переподключение `RedisClient` автоматическое; при необходимости — пересоздание подписчика в `bus.ts` по событию закрытия соединения) и добавить это в отчёт.

- [ ] **Step 4: Итог для пользователя**

Коммиты, числа тестов, что проверено на стенде с балансировщиком, что нет. В master не сливать без слова пользователя.

---

## Что не входит в этап

- Отдельный процесс Gateway (см. «Решения»).
- Ограничение частоты запросов (rate limiting) — отдельной задачей поверх Valkey, когда понадобится.
- Перенос журнальных «есть новое» с `NOTIFY` в Valkey.
- Кластер Valkey и отказоустойчивость Valkey (реплика, Sentinel).

## Риски

- **Valkey упал:** теряются «печатает…», присутствие и кадры контактов/приватности; сообщения, синхронизация и push продолжают работать (push без Valkey не узнает, кто онлайн: `onlineUsers` бросит — задача `push.message` уйдёт на повтор, и push придёт с опозданием после восстановления). Это осознанная цена: всё потерянное — эфемерное.
- **Процесс упал без `processGone`:** его счётчики перестают учитываться через 90 с (истекает `proc:<pid>`); собеседники не получат кадр «не в сети» от этого процесса, но снимок присутствия при следующем подключении будет верным, а `last_seen_at` не обновится — допустимо.
- **Скрипты Lua читают ключи `proc:*`, не переданные в KEYS:** работает на одиночном узле; для кластера Valkey реестр придётся переделать (это записано в Global Constraints).

## Как реализовано: отступления от плана

- **API Bun 1.4.2** совпал с планом (`subscribe`, `unsubscribe`, `duplicate`, `send`, `publish`, `connect`); тег `valkey/valkey:8.1-alpine` существует; миграция — `118_drop_live_conns.sql`.
- **Порядок open/close сокета** (Task 2): `open` стал синхронным для локальных подписок и учёта сокета, а подписки в Valkey и `connected` идут цепочкой в `ws.data.opened`; `close` ждёт её. Иначе быстрый «открыл → закрыл» мог прислать `disconnect` раньше `connect`, и счётчик онлайна в Valkey зависал.
- **resetDb** после `flushOwn` снова ставит `processAlive()`: чистка стирает и ключ «процесс жив» тестового процесса.
- **contacts.ts**: `contactOf` синхронный — онлайн передаётся параметром; при недоступном Valkey контакты отдаются с «не в сети», а не падают.
- **main.ts**: по SIGTERM/SIGINT останавливает realtime → `processGone` (иначе «штатной остановки» не было).
- **Метка паузы** (найдено на стенде с nginx): таймер давней паузы с другого процесса объявлял «не в сети» раньше срока, а ключ более поздней паузы ещё жил — следующий сокет считался «вернувшимся», и собеседник не видел «в сети». Теперь в `left:<user>` — метка паузы; уход объявляет только таймер с этой меткой (`leave`, атомарно), ключ живёт 2×GRACE как страховка; если сокет вернулся, пока объявляли уход, — повторное «в сети». Тест — в `multiprocess.test.ts` и `liveRegistry.test.ts`.
- **Отказ Valkey** (Task 5): клиент Bun после короткого обрыва переподключается, но подписки не восстанавливает, а после ~10 с без Valkey закрывается насовсем (`Connection has failed`), даже с большим `maxRetries`. Общий клиент пересоздаётся после `onclose`; шина на `onconnect`/`onclose` заводит новое соединение-подписчик и подписывается на все топики заново (повтор раз в 2 с). `CONNECT` заодно отмечает процесс живым — перезапущенный Valkey пуст. Присваивание `onclose = null` в Bun 1.4.2 ломает `client.close` — не делать.
- **docker-compose.scale.yml**: `extends` без `file` не видит сервис из другого файла — `extends: { file: docker-compose.yml, service: server }`.
- **Тесты с сокетами** ждут 50 мс после `onopen`: подписка в Valkey идёт после открытия сокета.
