# Relay Server Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поднять в Docker серверное ядро мессенджера: Postgres-схему, журнал изменений, идемпотентную отправку, монотонное прочтение, историю и WebSocket-протокол `hello`/`sync`/`send`/`read` с доставкой через LISTEN/NOTIFY.

**Architecture:** Bun.serve обслуживает HTTP и WebSocket в одном процессе. Доменные функции (`apps/server/src/domain/*`) работают с Postgres через клиент `postgres` и в той же транзакции пишут изменения в журнал `updates(user_id, seq)` без дыр. После коммита `pg_notify('updates', [userIds])` будит все процессы сервера, они шлют подписанным сокетам `poke`, а клиент сам забирает изменения через `sync`.

**Tech Stack:** Bun 1.4.2 (`oven/bun:1.4.2`), TypeScript, Postgres 17 (`postgres:17-alpine`), клиент `postgres@3.4.9`, Docker Compose, `bun test`.

## Global Constraints

- Всё запускается и тестируется в Docker: `docker compose up` для разработки, `docker compose run --rm test` для тестов. Локально нужен только Docker.
- Bun в образе: `oven/bun:1.4.2`. Postgres: `postgres:17-alpine`. Клиент БД: `postgres@3.4.9`.
- Журнал: `updates(user_id, seq)`, `seq` растёт на 1 без пропусков и пишется в той же транзакции, что и данные.
- Отправка идемпотентна: `UNIQUE (sender_id, client_id)`; повтор возвращает то же сообщение и не пишет журнал повторно.
- Прочтение монотонно: `last_read_id` только растёт; нельзя прочитать id больше максимального в чате.
- Изменения журнала в этом этапе: `newMessage`, `readOwn`, `readBy`.
- Межпроцессная доставка — только `LISTEN/NOTIFY`, без Redis.
- `bigint` из Postgres приводится к `number` в одном месте — в `db.ts`.
- Dev-вход (`POST /dev/login`, `POST /dev/chats`) работает только при `DEV_LOGIN=1`.
- Сессия: httpOnly-cookie `relay_session`; в базе хранится только SHA-256 токена.
- Пути ниже — от корня нового репозитория `relay/`.

## File Structure

```
relay-chat/
  package.json                    workspaces: apps/*, packages/*
  .dockerignore
  docker-compose.yml              postgres, migrate, server, test
  docker/postgres/init.sql        создаёт базу relay_test
  packages/protocol/
    package.json                  name: @relay/protocol
    src/index.ts                  типы Message, Update, JournalEntry, ClientFrame, ServerFrame, parseClientFrame
  apps/server/
    package.json                  name: @relay/server
    Dockerfile
    bunfig.toml                   preload тестов
    migrations/001_init.sql       схема
    src/db.ts                     пул postgres, тип Tx, bigint → number
    src/migrate.ts                раннер миграций (идемпотентный)
    src/domain/errors.ts          DomainError + коды
    src/domain/journal.ts         appendUpdates, fanOut, getUpdates, currentSeq
    src/domain/chats.ts           createChat, assertMember, listChats, getHistory
    src/domain/messages.ts        sendMessage
    src/domain/reads.ts           markRead
    src/auth.ts                   createUser, createSession, userIdFromToken, readSessionCookie
    src/ws.ts                     handleFrame(userId, frame) → ServerFrame[]
    src/http.ts                   createServer({ port }) → Bun.Server
    src/realtime.ts               startRealtime(server)
    src/main.ts                   точка входа процесса
    test/setup.ts                 миграции перед тестами
    test/helpers.ts               resetDb, makeUser, makeChat, nextFrame
    test/*.test.ts
```

---

### Task 1: Монорепозиторий, Docker и health-check

**Files:**
- Create: `package.json`, `.dockerignore`, `docker-compose.yml`, `docker/postgres/init.sql`
- Create: `apps/server/package.json`, `apps/server/Dockerfile`, `apps/server/bunfig.toml`, `apps/server/src/http.ts`
- Create: `packages/protocol/package.json`, `packages/protocol/src/index.ts`
- Test: `apps/server/test/health.test.ts`

**Interfaces:**
- Produces: `createServer(opts: { port: number }): import('bun').Server` в `apps/server/src/http.ts`; маршрут `GET /health` → `200 {"ok":true}`.
- Produces: сервис `test` в compose запускает `bun test` в `/app/apps/server` с `DATABASE_URL` на базу `relay_test`.

- [ ] **Step 1: Создать репозиторий и корневые файлы**

```bash
mkdir relay && cd relay && git init
```

`package.json`:
```json
{
  "name": "relay-chat",
  "private": true,
  "workspaces": ["apps/*", "packages/*"]
}
```

`.dockerignore`:
```
node_modules
**/node_modules
.git
```

`docker/postgres/init.sql`:
```sql
CREATE DATABASE relay_test;
```

`packages/protocol/package.json`:
```json
{ "name": "@relay/protocol", "version": "0.0.0", "private": true, "type": "module", "main": "src/index.ts", "types": "src/index.ts" }
```

`packages/protocol/src/index.ts` (пока пустой модуль, наполняется в Task 3):
```ts
export {};
```

`apps/server/package.json`:
```json
{
  "name": "@relay/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": { "@relay/protocol": "workspace:*", "postgres": "3.4.9" }
}
```

`apps/server/bunfig.toml`:
```toml
[test]
preload = ["./test/setup.ts"]
```

`apps/server/test/setup.ts` (наполняется в Task 2):
```ts
export {};
```

- [ ] **Step 2: Dockerfile и compose**

`apps/server/Dockerfile`:
```dockerfile
FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 3000
CMD ["bun", "apps/server/src/main.ts"]
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: relay
      POSTGRES_PASSWORD: relay
      POSTGRES_DB: relay
    ports: ["5433:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres/init.sql:/docker-entrypoint-initdb.d/01-test-db.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U relay"]
      interval: 2s
      timeout: 3s
      retries: 30

  migrate:
    build: { context: ., dockerfile: apps/server/Dockerfile }
    command: ["bun", "apps/server/src/migrate.ts"]
    environment:
      DATABASE_URL: postgres://relay:relay@postgres:5432/relay
    depends_on:
      postgres: { condition: service_healthy }

  server:
    build: { context: ., dockerfile: apps/server/Dockerfile }
    command: ["bun", "--watch", "apps/server/src/main.ts"]
    environment:
      DATABASE_URL: postgres://relay:relay@postgres:5432/relay
      PORT: "3000"
      DEV_LOGIN: "1"
    ports: ["3000:3000"]
    volumes:
      - ./apps:/app/apps
      - ./packages:/app/packages
    depends_on:
      migrate: { condition: service_completed_successfully }

  test:
    build: { context: ., dockerfile: apps/server/Dockerfile }
    profiles: ["test"]
    working_dir: /app/apps/server
    command: ["bun", "test"]
    environment:
      DATABASE_URL: postgres://relay:relay@postgres:5432/relay_test
      DEV_LOGIN: "1"
    volumes:
      - ./apps:/app/apps
      - ./packages:/app/packages
    depends_on:
      postgres: { condition: service_healthy }

volumes:
  pgdata: {}
```

- [ ] **Step 3: Сгенерировать lockfile внутри контейнера**

Run: `docker run --rm -v "$PWD":/app -w /app oven/bun:1.4.2 bun install`
Expected: создан `bun.lock`, в выводе `postgres@3.4.9`.

- [ ] **Step 4: Написать падающий тест health-check**

`apps/server/test/health.test.ts`:
```ts
import { afterAll, expect, test } from 'bun:test';
import { createServer } from '../src/http';

const server = createServer({ port: 0 });
afterAll(() => server.stop(true));

test('GET /health answers ok', async () => {
  const res = await fetch(`http://localhost:${server.port}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
```

- [ ] **Step 5: Запустить и убедиться, что падает**

Run: `docker compose run --rm --build test bun test test/health.test.ts`
Expected: FAIL — `Cannot find module '../src/http'`.

- [ ] **Step 6: Минимальная реализация**

`apps/server/src/http.ts`:
```ts
import type { Server } from 'bun';

export function createServer(opts: { port: number }): Server {
  return Bun.serve({
    port: opts.port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return Response.json({ ok: true });
      return new Response('Not found', { status: 404 });
    },
  });
}
```

- [ ] **Step 7: Запустить и убедиться, что проходит**

Run: `docker compose run --rm test bun test test/health.test.ts`
Expected: PASS, `1 pass`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: monorepo, docker compose and health check"
```

---

### Task 2: Подключение к БД, схема и миграции

**Files:**
- Create: `apps/server/src/db.ts`, `apps/server/src/migrate.ts`, `apps/server/migrations/001_init.sql`
- Modify: `apps/server/test/setup.ts`
- Create: `apps/server/test/helpers.ts`
- Test: `apps/server/test/migrate.test.ts`

**Interfaces:**
- Produces: `sql` (пул postgres, `bigint` → `number`), `type Tx = postgres.TransactionSql` в `src/db.ts`.
- Produces: `migrate(): Promise<string[]>` — применённые сейчас миграции, повторный вызов возвращает `[]`.
- Produces: `resetDb(): Promise<void>` в `test/helpers.ts` — очищает все таблицы кроме `schema_migrations`.

- [ ] **Step 1: Написать падающий тест**

`apps/server/test/migrate.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { sql } from '../src/db';
import { migrate } from '../src/migrate';

test('schema has all core tables', async () => {
  const rows = await sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
  const names = rows.map((r) => r.table_name);
  for (const t of ['chat_members', 'chats', 'messages', 'schema_migrations', 'sessions', 'updates', 'user_seq', 'users']) {
    expect(names).toContain(t);
  }
});

test('migrate is idempotent', async () => {
  expect(await migrate()).toEqual([]);
});

test('bigint columns come back as numbers', async () => {
  const [row] = await sql`select 9007199254740::bigint as n`;
  expect(row.n).toBe(9007199254740);
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `docker compose run --rm test bun test test/migrate.test.ts`
Expected: FAIL — `Cannot find module '../src/db'`.

- [ ] **Step 3: Пул соединений**

`apps/server/src/db.ts`:
```ts
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

// bigint (OID 20) → number. Все id и seq помещаются в 2^53.
export const sql = postgres(url, {
  max: 10,
  idle_timeout: 20,
  onnotice: () => {},
  types: {
    bigint: { to: 20, from: [20], serialize: (v: number) => String(v), parse: (v: string) => Number(v) },
  },
});

export type Tx = postgres.TransactionSql<{ bigint: number }>;
```

- [ ] **Step 4: Схема**

`apps/server/migrations/001_init.sql`:
```sql
create table users (
  id          bigint generated always as identity primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table sessions (
  token_hash  text primary key,
  user_id     bigint not null references users on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create table chats (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('direct', 'group')),
  title       text,
  created_at  timestamptz not null default now()
);

create table chat_members (
  chat_id       bigint not null references chats on delete cascade,
  user_id       bigint not null references users on delete cascade,
  role          text not null default 'member',
  last_read_id  bigint not null default 0,
  joined_at     timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create index chat_members_user on chat_members (user_id);

create table messages (
  chat_id      bigint not null references chats on delete cascade,
  id           bigint generated always as identity,
  sender_id    bigint not null references users,
  client_id    uuid not null,
  kind         text not null default 'text',
  body         text not null,
  reply_to_id  bigint,
  created_at   timestamptz not null default now(),
  primary key (chat_id, id),
  unique (sender_id, client_id)
);
create index messages_chat_id_desc on messages (chat_id, id desc);

create table user_seq (
  user_id  bigint primary key references users on delete cascade,
  seq      bigint not null
);

create table updates (
  user_id     bigint not null references users on delete cascade,
  seq         bigint not null,
  type        text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, seq)
);
```

- [ ] **Step 5: Раннер миграций**

`apps/server/src/migrate.ts`:
```ts
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from './db';

const dir = join(import.meta.dir, '..', 'migrations');

export async function migrate(): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql`select name from schema_migrations`).map((r) => r.name as string));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const text = await Bun.file(join(dir, name)).text();
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${name})`;
    });
    applied.push(name);
  }
  return applied;
}

if (import.meta.main) {
  const applied = await migrate();
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
  await sql.end();
}
```

- [ ] **Step 6: Подготовка тестов и хелперы**

`apps/server/test/setup.ts`:
```ts
import { migrate } from '../src/migrate';

await migrate();
```

`apps/server/test/helpers.ts`:
```ts
import { sql } from '../src/db';

export async function resetDb(): Promise<void> {
  await sql`truncate users, sessions, chats, chat_members, messages, user_seq, updates restart identity cascade`;
}
```

- [ ] **Step 7: Запустить и убедиться, что проходит**

Run: `docker compose run --rm test bun test test/migrate.test.ts`
Expected: PASS, `3 pass`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(server): postgres pool, schema and migration runner"
```

---

### Task 3: Протокол и журнал изменений

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Create: `apps/server/src/domain/errors.ts`, `apps/server/src/domain/journal.ts`
- Modify: `apps/server/test/helpers.ts`
- Test: `apps/server/test/journal.test.ts`

**Interfaces:**
- Produces в `@relay/protocol`: типы `Id`, `Message`, `Update`, `JournalEntry`, `ClientFrame`, `ServerFrame`, `ErrorCode`.
- Produces в `domain/errors.ts`: `class DomainError extends Error { code: ErrorCode }`.
- Produces в `domain/journal.ts`:
  - `appendUpdates(tx: Tx, entries: { userId: number; update: Update }[]): Promise<void>`
  - `fanOut(tx: Tx, userIds: number[], update: Update): Promise<void>`
  - `currentSeq(userId: number): Promise<number>`
  - `getUpdates(userId: number, since: number, limit?: number): Promise<{ items: JournalEntry[]; seq: number; more: boolean; tooLong: boolean }>`
- Produces в `test/helpers.ts`: `makeUser(name?: string): Promise<number>`.

- [ ] **Step 1: Типы протокола**

`packages/protocol/src/index.ts`:
```ts
export type Id = number;

export interface Message {
  id: Id;
  chatId: Id;
  senderId: Id;
  clientId: string;
  kind: 'text';
  body: string;
  replyToId: Id | null;
  createdAt: string; // ISO
}

export type Update =
  | { type: 'newMessage'; message: Message }
  | { type: 'readOwn'; chatId: Id; upToId: Id }
  | { type: 'readBy'; chatId: Id; userId: Id; upToId: Id };

export interface JournalEntry { seq: number; update: Update }

export type ErrorCode = 'bad_frame' | 'unauthorized' | 'not_member' | 'not_found' | 'too_long' | 'internal';

export type ClientFrame =
  | { op: 'hello'; lastSeq: number }
  | { op: 'sync'; since: number }
  | { op: 'send'; reqId: string; clientId: string; chatId: Id; body: string; replyToId?: Id | null }
  | { op: 'read'; reqId: string; chatId: Id; upToId: Id }
  | { op: 'ping' };

export type ServerFrame =
  | { op: 'hello'; seq: number }
  | { op: 'updates'; from: number; to: number; items: JournalEntry[]; more: boolean }
  | { op: 'tooLong'; seq: number }
  | { op: 'ack'; reqId: string; result: Record<string, unknown> }
  | { op: 'err'; reqId?: string; code: ErrorCode; retry: boolean }
  | { op: 'poke' }
  | { op: 'pong' };
```

- [ ] **Step 2: Написать падающий тест журнала**

`apps/server/test/helpers.ts` — добавить:
```ts
export async function makeUser(name = 'user'): Promise<number> {
  const [row] = await sql`insert into users (name) values (${name}) returning id`;
  return row.id as number;
}
```

`apps/server/test/journal.test.ts`:
```ts
import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { appendUpdates, currentSeq, fanOut, getUpdates } from '../src/domain/journal';
import { makeUser, resetDb } from './helpers';

beforeEach(resetDb);

const ping = (chatId: number) => ({ type: 'readOwn' as const, chatId, upToId: 1 });

test('fanOut gives every user a gapless seq', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  await sql.begin((tx) => fanOut(tx, [a, b], ping(1)));
  await sql.begin((tx) => fanOut(tx, [a], ping(2)));
  expect(await currentSeq(a)).toBe(2);
  expect(await currentSeq(b)).toBe(1);
  const { items } = await getUpdates(a, 0);
  expect(items.map((i) => i.seq)).toEqual([1, 2]);
  expect(items[1].update).toEqual(ping(2));
});

test('getUpdates returns only what is after `since` and pages with `more`', async () => {
  const a = await makeUser();
  for (let i = 1; i <= 5; i++) await sql.begin((tx) => fanOut(tx, [a], ping(i)));
  const page = await getUpdates(a, 1, 2);
  expect(page.items.map((i) => i.seq)).toEqual([2, 3]);
  expect(page.more).toBe(true);
  expect(page.seq).toBe(5);
  expect((await getUpdates(a, 5)).items).toEqual([]);
});

test('getUpdates reports tooLong when the log was trimmed past `since`', async () => {
  const a = await makeUser();
  for (let i = 1; i <= 3; i++) await sql.begin((tx) => fanOut(tx, [a], ping(i)));
  await sql`delete from updates where user_id = ${a} and seq <= 2`;
  expect((await getUpdates(a, 0)).tooLong).toBe(true);
  expect((await getUpdates(a, 2)).tooLong).toBe(false);
});

test('appendUpdates writes different updates to different users in one call', async () => {
  const a = await makeUser(), b = await makeUser();
  await sql.begin((tx) => appendUpdates(tx, [{ userId: b, update: ping(9) }, { userId: a, update: ping(8) }]));
  expect((await getUpdates(a, 0)).items[0].update).toEqual(ping(8));
  expect((await getUpdates(b, 0)).items[0].update).toEqual(ping(9));
});

test('a rolled-back transaction leaves no seq gap', async () => {
  const a = await makeUser();
  await sql.begin((tx) => fanOut(tx, [a], ping(1)));
  await sql.begin(async (tx) => { await fanOut(tx, [a], ping(2)); throw new Error('boom'); }).catch(() => {});
  await sql.begin((tx) => fanOut(tx, [a], ping(3)));
  expect((await getUpdates(a, 0)).items.map((i) => i.seq)).toEqual([1, 2]);
});
```

- [ ] **Step 3: Запустить и убедиться, что падает**

Run: `docker compose run --rm test bun test test/journal.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/journal'`.

- [ ] **Step 4: Ошибки домена**

`apps/server/src/domain/errors.ts`:
```ts
import type { ErrorCode } from '@relay/protocol';

export class DomainError extends Error {
  constructor(public code: ErrorCode, message: string = code) {
    super(message);
  }
}
```

- [ ] **Step 5: Журнал**

`apps/server/src/domain/journal.ts`:
```ts
import type { JournalEntry, Update } from '@relay/protocol';
import { sql, type Tx } from '../db';

export const MAX_BATCH = 500;

/** Пишет по одной записи журнала на каждый элемент. Блокирует user_seq в порядке возрастания user_id — без дедлоков между параллельными транзакциями. */
export async function appendUpdates(tx: Tx, entries: { userId: number; update: Update }[]): Promise<void> {
  const sorted = [...entries].sort((x, y) => x.userId - y.userId);
  const users = new Set<number>();
  for (const { userId, update } of sorted) {
    const [row] = await tx`
      insert into user_seq (user_id, seq) values (${userId}, 1)
      on conflict (user_id) do update set seq = user_seq.seq + 1
      returning seq`;
    await tx`insert into updates (user_id, seq, type, payload) values (${userId}, ${row.seq}, ${update.type}, ${tx.json(update as never)})`;
    users.add(userId);
  }
  // уведомление уйдёт только после коммита
  if (users.size) await tx`select pg_notify('updates', ${JSON.stringify([...users])})`;
}

export function fanOut(tx: Tx, userIds: number[], update: Update): Promise<void> {
  return appendUpdates(tx, [...new Set(userIds)].map((userId) => ({ userId, update })));
}

export async function currentSeq(userId: number): Promise<number> {
  const [row] = await sql`select seq from user_seq where user_id = ${userId}`;
  return row ? (row.seq as number) : 0;
}

export async function getUpdates(userId: number, since: number, limit = MAX_BATCH) {
  const seq = await currentSeq(userId);
  if (since >= seq) return { items: [] as JournalEntry[], seq, more: false, tooLong: false };
  const [first] = await sql`select min(seq) as min from updates where user_id = ${userId}`;
  if (first.min !== null && since < (first.min as number) - 1) return { items: [] as JournalEntry[], seq, more: false, tooLong: true };
  const rows = await sql`select seq, payload from updates where user_id = ${userId} and seq > ${since} order by seq limit ${limit}`;
  const items: JournalEntry[] = rows.map((r) => ({ seq: r.seq as number, update: r.payload as Update }));
  const last = items.length ? items[items.length - 1].seq : since;
  return { items, seq, more: last < seq, tooLong: false };
}
```

- [ ] **Step 6: Запустить и убедиться, что проходит**

Run: `docker compose run --rm test bun test test/journal.test.ts`
Expected: PASS, `5 pass`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(server): protocol types and gapless update journal"
```

---

### Task 4: Чаты, членство и идемпотентная отправка

**Files:**
- Create: `apps/server/src/domain/chats.ts`, `apps/server/src/domain/messages.ts`
- Modify: `apps/server/test/helpers.ts`
- Test: `apps/server/test/messages.test.ts`

**Interfaces:**
- Consumes: `fanOut`, `getUpdates` (Task 3), `DomainError` (Task 3).
- Produces в `domain/chats.ts`:
  - `createChat(kind: 'direct' | 'group', title: string | null, memberIds: number[]): Promise<number>`
  - `assertMember(tx: Tx | typeof sql, chatId: number, userId: number): Promise<void>` — бросает `DomainError('not_member')`
  - `toMessage(row): Message`
- Produces в `domain/messages.ts`:
  - `MAX_BODY = 4096`
  - `sendMessage(userId: number, input: { chatId: number; clientId: string; body: string; replyToId?: number | null }): Promise<{ message: Message; duplicate: boolean }>`
- Produces в `test/helpers.ts`: `makeChat(memberIds: number[], kind?: 'direct' | 'group'): Promise<number>`.

- [ ] **Step 1: Написать падающий тест**

`apps/server/test/helpers.ts` — добавить:
```ts
import { createChat } from '../src/domain/chats';

export function makeChat(memberIds: number[], kind: 'direct' | 'group' = memberIds.length > 2 ? 'group' : 'direct'): Promise<number> {
  return createChat(kind, kind === 'group' ? 'Группа' : null, memberIds);
}
```

`apps/server/test/messages.test.ts`:
```ts
import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { getUpdates } from '../src/domain/journal';
import { sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const cid = () => crypto.randomUUID();

test('send stores the message and writes newMessage to every member', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const { message, duplicate } = await sendMessage(a, { chatId: chat, clientId: cid(), body: 'привет' });
  expect(duplicate).toBe(false);
  expect(message).toMatchObject({ chatId: chat, senderId: a, body: 'привет', kind: 'text', replyToId: null });
  for (const u of [a, b]) {
    const { items } = await getUpdates(u, 0);
    expect(items).toEqual([{ seq: 1, update: { type: 'newMessage', message } }]);
  }
});

test('repeating a clientId returns the same message and writes nothing new', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const clientId = cid();
  const first = await sendMessage(a, { chatId: chat, clientId, body: 'раз' });
  const again = await sendMessage(a, { chatId: chat, clientId, body: 'раз' });
  expect(again.duplicate).toBe(true);
  expect(again.message.id).toBe(first.message.id);
  expect((await getUpdates(b, 0)).items).toHaveLength(1);
  const [{ n }] = await sql`select count(*)::int as n from messages`;
  expect(n).toBe(1);
});

test('non-members cannot send', async () => {
  const a = await makeUser(), b = await makeUser(), stranger = await makeUser();
  const chat = await makeChat([a, b]);
  await expect(sendMessage(stranger, { chatId: chat, clientId: cid(), body: 'x' })).rejects.toMatchObject({ code: 'not_member' });
});

test('empty and too long bodies are rejected', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  await expect(sendMessage(a, { chatId: chat, clientId: cid(), body: '   ' })).rejects.toMatchObject({ code: 'bad_frame' });
  await expect(sendMessage(a, { chatId: chat, clientId: cid(), body: 'x'.repeat(4097) })).rejects.toMatchObject({ code: 'too_long' });
});

test('replyToId must point to a message in the same chat', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]), other = await makeChat([a, b]);
  const { message } = await sendMessage(a, { chatId: other, clientId: cid(), body: 'там' });
  await expect(sendMessage(a, { chatId: chat, clientId: cid(), body: 'ответ', replyToId: message.id })).rejects.toMatchObject({ code: 'not_found' });
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `docker compose run --rm test bun test test/messages.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/chats'`.

- [ ] **Step 3: Чаты и членство**

`apps/server/src/domain/chats.ts`:
```ts
import type { Message } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';

export async function createChat(kind: 'direct' | 'group', title: string | null, memberIds: number[]): Promise<number> {
  return sql.begin(async (tx) => {
    const [chat] = await tx`insert into chats (kind, title) values (${kind}, ${title}) returning id`;
    for (const userId of new Set(memberIds)) {
      await tx`insert into chat_members (chat_id, user_id) values (${chat.id}, ${userId})`;
    }
    return chat.id as number;
  });
}

export async function assertMember(db: Tx | typeof sql, chatId: number, userId: number): Promise<void> {
  const [row] = await db`select 1 from chat_members where chat_id = ${chatId} and user_id = ${userId}`;
  if (!row) throw new DomainError('not_member');
}

export function toMessage(r: Record<string, unknown>): Message {
  return {
    id: r.id as number,
    chatId: r.chat_id as number,
    senderId: r.sender_id as number,
    clientId: r.client_id as string,
    kind: 'text',
    body: r.body as string,
    replyToId: (r.reply_to_id as number | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
  };
}
```

- [ ] **Step 4: Отправка**

`apps/server/src/domain/messages.ts`:
```ts
import type { Message } from '@relay/protocol';
import { sql } from '../db';
import { assertMember, toMessage } from './chats';
import { DomainError } from './errors';
import { fanOut } from './journal';

export const MAX_BODY = 4096;

export async function sendMessage(
  userId: number,
  input: { chatId: number; clientId: string; body: string; replyToId?: number | null },
): Promise<{ message: Message; duplicate: boolean }> {
  const body = input.body.trim();
  if (!body) throw new DomainError('bad_frame', 'empty body');
  if (body.length > MAX_BODY) throw new DomainError('too_long');

  return sql.begin(async (tx) => {
    await assertMember(tx, input.chatId, userId);
    if (input.replyToId != null) {
      const [target] = await tx`select 1 from messages where chat_id = ${input.chatId} and id = ${input.replyToId}`;
      if (!target) throw new DomainError('not_found', 'reply target');
    }
    const inserted = await tx`
      insert into messages (chat_id, sender_id, client_id, kind, body, reply_to_id)
      values (${input.chatId}, ${userId}, ${input.clientId}, 'text', ${body}, ${input.replyToId ?? null})
      on conflict (sender_id, client_id) do nothing
      returning *`;
    if (inserted.length === 0) {
      const [existing] = await tx`select * from messages where sender_id = ${userId} and client_id = ${input.clientId}`;
      return { message: toMessage(existing), duplicate: true };
    }
    const message = toMessage(inserted[0]);
    const members = await tx`select user_id from chat_members where chat_id = ${input.chatId}`;
    await fanOut(tx, members.map((m) => m.user_id as number), { type: 'newMessage', message });
    return { message, duplicate: false };
  });
}
```

- [ ] **Step 5: Запустить и убедиться, что проходит**

Run: `docker compose run --rm test bun test test/messages.test.ts`
Expected: PASS, `5 pass`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): chats, membership and idempotent send"
```

---

### Task 5: Монотонное прочтение

**Files:**
- Create: `apps/server/src/domain/reads.ts`
- Test: `apps/server/test/reads.test.ts`

**Interfaces:**
- Consumes: `appendUpdates`, `getUpdates` (Task 3), `assertMember`, `sendMessage` (Task 4).
- Produces: `markRead(userId: number, chatId: number, upToId: number): Promise<{ lastReadId: number; changed: boolean }>`; пишет `readOwn` себе и `readBy` остальным участникам одним вызовом `appendUpdates`.

- [ ] **Step 1: Написать падающий тест**

`apps/server/test/reads.test.ts`:
```ts
import { beforeEach, expect, test } from 'bun:test';
import { getUpdates } from '../src/domain/journal';
import { sendMessage } from '../src/domain/messages';
import { markRead } from '../src/domain/reads';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const send = (u: number, chat: number, body: string) => sendMessage(u, { chatId: chat, clientId: crypto.randomUUID(), body }).then((r) => r.message.id);

test('read moves the pointer and tells own devices and the sender', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const m1 = await send(a, chat, 'раз');
  expect(await markRead(b, chat, m1)).toEqual({ lastReadId: m1, changed: true });
  const own = (await getUpdates(b, 1)).items.map((i) => i.update);
  expect(own).toEqual([{ type: 'readOwn', chatId: chat, upToId: m1 }]);
  const toSender = (await getUpdates(a, 1)).items.map((i) => i.update);
  expect(toSender).toEqual([{ type: 'readBy', chatId: chat, userId: b, upToId: m1 }]);
});

test('the pointer never moves back and repeated reads write nothing', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const m1 = await send(a, chat, '1'), m2 = await send(a, chat, '2');
  await markRead(b, chat, m2);
  expect(await markRead(b, chat, m1)).toEqual({ lastReadId: m2, changed: false });
  expect(await markRead(b, chat, m2)).toEqual({ lastReadId: m2, changed: false });
  expect((await getUpdates(a, 0)).items.filter((i) => i.update.type === 'readBy')).toHaveLength(1);
});

test('cannot read past the newest message', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const m1 = await send(a, chat, '1');
  await expect(markRead(b, chat, m1 + 1000)).rejects.toMatchObject({ code: 'not_found' });
});

test('strangers cannot mark read', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const chat = await makeChat([a, b]);
  const m1 = await send(a, chat, '1');
  await expect(markRead(c, chat, m1)).rejects.toMatchObject({ code: 'not_member' });
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `docker compose run --rm test bun test test/reads.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/reads'`.

- [ ] **Step 3: Реализация**

`apps/server/src/domain/reads.ts`:
```ts
import { sql } from '../db';
import { DomainError } from './errors';
import { appendUpdates } from './journal';

export async function markRead(userId: number, chatId: number, upToId: number): Promise<{ lastReadId: number; changed: boolean }> {
  return sql.begin(async (tx) => {
    const [me] = await tx`select last_read_id from chat_members where chat_id = ${chatId} and user_id = ${userId} for update`;
    if (!me) throw new DomainError('not_member');
    const [{ max }] = await tx`select coalesce(max(id), 0) as max from messages where chat_id = ${chatId}`;
    if (upToId > (max as number)) throw new DomainError('not_found', 'message');
    const current = me.last_read_id as number;
    if (upToId <= current) return { lastReadId: current, changed: false };

    await tx`update chat_members set last_read_id = ${upToId} where chat_id = ${chatId} and user_id = ${userId}`;
    const others = await tx`select user_id from chat_members where chat_id = ${chatId} and user_id <> ${userId}`;
    await appendUpdates(tx, [
      { userId, update: { type: 'readOwn', chatId, upToId } },
      ...others.map((o) => ({ userId: o.user_id as number, update: { type: 'readBy' as const, chatId, userId, upToId } })),
    ]);
    return { lastReadId: upToId, changed: true };
  });
}
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `docker compose run --rm test bun test test/reads.test.ts`
Expected: PASS, `4 pass`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): monotonic read pointer with readOwn/readBy"
```

---

### Task 6: Список чатов и история

**Files:**
- Modify: `apps/server/src/domain/chats.ts`
- Test: `apps/server/test/history.test.ts`

**Interfaces:**
- Consumes: `sendMessage` (Task 4), `markRead` (Task 5).
- Produces в `domain/chats.ts`:
  - `type ChatSummary = { id: number; kind: 'direct' | 'group'; title: string | null; lastReadId: number; unread: number; last: Message | null }`
  - `listChats(userId: number): Promise<ChatSummary[]>` — по убыванию времени последнего сообщения
  - `getHistory(userId: number, chatId: number, before: number | null, limit: number): Promise<{ messages: Message[]; hasMore: boolean }>` — `messages` по возрастанию id

- [ ] **Step 1: Написать падающий тест**

`apps/server/test/history.test.ts`:
```ts
import { beforeEach, expect, test } from 'bun:test';
import { getHistory, listChats } from '../src/domain/chats';
import { sendMessage } from '../src/domain/messages';
import { markRead } from '../src/domain/reads';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const send = (u: number, chat: number, body: string) => sendMessage(u, { chatId: chat, clientId: crypto.randomUUID(), body }).then((r) => r.message.id);

test('chat list: newest first, last message and unread from others only', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  const ab = await makeChat([a, b]), ac = await makeChat([a, c]);
  await send(b, ab, 'b1');
  await send(b, ab, 'b2');
  await send(a, ab, 'мой');
  await send(c, ac, 'c1');
  const list = await listChats(a);
  expect(list.map((x) => x.id)).toEqual([ac, ab]);
  expect(list[0]).toMatchObject({ unread: 1, last: { body: 'c1' } });
  expect(list[1]).toMatchObject({ unread: 2, last: { body: 'мой' } });
});

test('unread drops after markRead', async () => {
  const a = await makeUser(), b = await makeUser();
  const ab = await makeChat([a, b]);
  const m = await send(b, ab, 'x');
  await markRead(a, ab, m);
  expect((await listChats(a))[0]).toMatchObject({ unread: 0, lastReadId: m });
});

test('history pages backwards and returns ascending ids', async () => {
  const a = await makeUser(), b = await makeUser();
  const ab = await makeChat([a, b]);
  const ids: number[] = [];
  for (let i = 1; i <= 5; i++) ids.push(await send(a, ab, String(i)));
  const page1 = await getHistory(b, ab, null, 2);
  expect(page1.messages.map((m) => m.id)).toEqual([ids[3], ids[4]]);
  expect(page1.hasMore).toBe(true);
  const page2 = await getHistory(b, ab, ids[3], 10);
  expect(page2.messages.map((m) => m.id)).toEqual([ids[0], ids[1], ids[2]]);
  expect(page2.hasMore).toBe(false);
});

test('history is members only', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const ab = await makeChat([a, b]);
  await expect(getHistory(c, ab, null, 10)).rejects.toMatchObject({ code: 'not_member' });
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `docker compose run --rm test bun test test/history.test.ts`
Expected: FAIL — `Export named 'getHistory' not found`.

- [ ] **Step 3: Реализация** — добавить в `apps/server/src/domain/chats.ts`:

```ts
export type ChatSummary = {
  id: number;
  kind: 'direct' | 'group';
  title: string | null;
  lastReadId: number;
  unread: number;
  last: Message | null;
};

export async function listChats(userId: number): Promise<ChatSummary[]> {
  const rows = await sql`
    select c.id, c.kind, c.title, c.created_at as chat_created_at, cm.last_read_id,
           lm.id as m_id, lm.chat_id as m_chat_id, lm.sender_id as m_sender_id, lm.client_id as m_client_id,
           lm.body as m_body, lm.reply_to_id as m_reply_to_id, lm.created_at as m_created_at,
           (select count(*) from messages m
             where m.chat_id = c.id and m.id > cm.last_read_id and m.sender_id <> ${userId})::int as unread
      from chat_members cm
      join chats c on c.id = cm.chat_id
      left join lateral (
        select * from messages where chat_id = c.id order by id desc limit 1
      ) lm on true
     where cm.user_id = ${userId}
     order by coalesce(lm.created_at, c.created_at) desc, c.id desc`;
  return rows.map((r) => ({
    id: r.id as number,
    kind: r.kind as 'direct' | 'group',
    title: (r.title as string | null) ?? null,
    lastReadId: r.last_read_id as number,
    unread: r.unread as number,
    last: r.m_id == null ? null : toMessage({
      id: r.m_id, chat_id: r.m_chat_id, sender_id: r.m_sender_id, client_id: r.m_client_id,
      body: r.m_body, reply_to_id: r.m_reply_to_id, created_at: r.m_created_at,
    }),
  }));
}

export async function getHistory(userId: number, chatId: number, before: number | null, limit: number): Promise<{ messages: Message[]; hasMore: boolean }> {
  await assertMember(sql, chatId, userId);
  const take = Math.min(Math.max(limit, 1), 100);
  const rows = await sql`
    select * from messages
     where chat_id = ${chatId} and (${before}::bigint is null or id < ${before})
     order by id desc
     limit ${take + 1}`;
  const hasMore = rows.length > take;
  return { messages: rows.slice(0, take).reverse().map(toMessage), hasMore };
}
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `docker compose run --rm test bun test test/history.test.ts`
Expected: PASS, `4 pass`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): chat list with unread counts and paged history"
```

---

### Task 7: Сессии и HTTP API

**Files:**
- Create: `apps/server/src/auth.ts`
- Modify: `apps/server/src/http.ts`
- Test: `apps/server/test/http.test.ts`

**Interfaces:**
- Consumes: `createChat`, `listChats`, `getHistory` (Tasks 4, 6), `DomainError` (Task 3).
- Produces в `auth.ts`:
  - `createUser(name: string): Promise<number>`
  - `createSession(userId: number): Promise<string>` — сырой токен (base64url, 32 байта); в базе SHA-256
  - `userIdFromToken(token: string | null): Promise<number | null>`
  - `readSessionToken(req: Request): string | null` — из cookie `relay_session`, иначе из `?token=` (только при `DEV_LOGIN=1`)
- Produces в `http.ts`: маршруты
  - `POST /dev/login {name}` → `{userId, token}` + `Set-Cookie: relay_session=…; HttpOnly; SameSite=Lax; Path=/`
  - `POST /dev/chats {kind, title, memberIds}` → `{id}`
  - `GET /chats` → `ChatSummary[]`
  - `GET /chats/:id/messages?before=&limit=` → `{messages, hasMore}`
  - без сессии → `401 {code:"unauthorized"}`; `DomainError` → `403/404/400 {code}`

- [ ] **Step 1: Написать падающий тест**

`apps/server/test/http.test.ts`:
```ts
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

async function login(name: string) {
  const res = await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) });
  expect(res.status).toBe(200);
  expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  return (await res.json()) as { userId: number; token: string };
}
const authed = (token: string) => ({ headers: { cookie: `relay_session=${token}` } });

test('requests without a session are rejected', async () => {
  const res = await fetch(`${base}/chats`);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ code: 'unauthorized' });
});

test('login → create chat → list → history', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const created = await fetch(`${base}/dev/chats`, { method: 'POST', ...authed(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) });
  const { id } = (await created.json()) as { id: number };
  const list = await (await fetch(`${base}/chats`, authed(b.token))).json();
  expect(list).toEqual([expect.objectContaining({ id, unread: 0, last: null })]);
  const hist = await (await fetch(`${base}/chats/${id}/messages?limit=20`, authed(a.token))).json();
  expect(hist).toEqual({ messages: [], hasMore: false });
});

test('history of someone else`s chat is forbidden', async () => {
  const a = await login('a'), b = await login('b'), c = await login('c');
  const created = await fetch(`${base}/dev/chats`, { method: 'POST', ...authed(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) });
  const { id } = (await created.json()) as { id: number };
  const res = await fetch(`${base}/chats/${id}/messages`, authed(c.token));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ code: 'not_member' });
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `docker compose run --rm test bun test test/http.test.ts`
Expected: FAIL — `/dev/login` отвечает 404.

- [ ] **Step 3: Сессии**

`apps/server/src/auth.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import { sql } from './db';

const SESSION_DAYS = 30;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createUser(name: string): Promise<number> {
  const [row] = await sql`insert into users (name) values (${name.slice(0, 64) || 'user'}) returning id`;
  return row.id as number;
}

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (token_hash, user_id, expires_at) values (${hash(token)}, ${userId}, now() + ${SESSION_DAYS + ' days'}::interval)`;
  return token;
}

export async function userIdFromToken(token: string | null): Promise<number | null> {
  if (!token) return null;
  const [row] = await sql`select user_id from sessions where token_hash = ${hash(token)} and expires_at > now()`;
  return row ? (row.user_id as number) : null;
}

export function readSessionToken(req: Request): string | null {
  const cookie = req.headers.get('cookie') ?? '';
  const m = /(?:^|;\s*)relay_session=([^;]+)/.exec(cookie);
  if (m) return decodeURIComponent(m[1]);
  if (process.env.DEV_LOGIN === '1') return new URL(req.url).searchParams.get('token');
  return null;
}

export function sessionCookie(token: string): string {
  return `relay_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}
```

- [ ] **Step 4: HTTP-маршруты** — заменить `apps/server/src/http.ts` целиком:

```ts
import type { Server } from 'bun';
import { createSession, createUser, readSessionToken, sessionCookie, userIdFromToken } from './auth';
import { createChat, getHistory, listChats } from './domain/chats';
import { DomainError } from './domain/errors';

const STATUS: Record<string, number> = { bad_frame: 400, too_long: 400, unauthorized: 401, not_member: 403, not_found: 404 };
const fail = (code: string) => Response.json({ code }, { status: STATUS[code] ?? 500 });

export type WsData = { userId: number };

export function createServer(opts: { port: number }): Server {
  return Bun.serve<WsData>({
    port: opts.port,
    async fetch(req, server) {
      const url = new URL(req.url);
      try {
        if (url.pathname === '/health') return Response.json({ ok: true });

        if (process.env.DEV_LOGIN === '1' && req.method === 'POST' && url.pathname === '/dev/login') {
          const { name } = (await req.json()) as { name: string };
          const userId = await createUser(String(name ?? 'user'));
          const token = await createSession(userId);
          return Response.json({ userId, token }, { headers: { 'set-cookie': sessionCookie(token) } });
        }

        const userId = await userIdFromToken(readSessionToken(req));
        if (!userId) return fail('unauthorized');

        if (url.pathname === '/ws') {
          return server.upgrade(req, { data: { userId } }) ? undefined : fail('bad_frame');
        }
        if (process.env.DEV_LOGIN === '1' && req.method === 'POST' && url.pathname === '/dev/chats') {
          const { kind, title, memberIds } = (await req.json()) as { kind: 'direct' | 'group'; title: string | null; memberIds: number[] };
          const ids = memberIds.includes(userId) ? memberIds : [userId, ...memberIds];
          return Response.json({ id: await createChat(kind, title, ids) });
        }
        if (req.method === 'GET' && url.pathname === '/chats') {
          return Response.json(await listChats(userId));
        }
        const hist = /^\/chats\/(\d+)\/messages$/.exec(url.pathname);
        if (req.method === 'GET' && hist) {
          const before = url.searchParams.get('before');
          const limit = Number(url.searchParams.get('limit') ?? 50);
          return Response.json(await getHistory(userId, Number(hist[1]), before ? Number(before) : null, limit));
        }
        return new Response('Not found', { status: 404 });
      } catch (err) {
        if (err instanceof DomainError) return fail(err.code);
        console.error(err);
        return fail('internal');
      }
    },
    websocket: {
      message() {},
    },
  });
}
```

- [ ] **Step 5: Запустить все тесты**

Run: `docker compose run --rm test`
Expected: PASS — все файлы, включая `http.test.ts` (`3 pass`) и `health.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): sessions, dev login and chats/history HTTP API"
```

---

### Task 8: Обработчик кадров WebSocket

**Files:**
- Modify: `packages/protocol/src/index.ts` (добавить `parseClientFrame`)
- Create: `apps/server/src/ws.ts`
- Test: `apps/server/test/ws-frames.test.ts`

**Interfaces:**
- Consumes: `currentSeq`, `getUpdates` (Task 3), `sendMessage` (Task 4), `markRead` (Task 5), `DomainError`.
- Produces в `@relay/protocol`: `parseClientFrame(raw: string): ClientFrame | null`.
- Produces в `ws.ts`: `handleFrame(userId: number, frame: ClientFrame): Promise<ServerFrame[]>` — чистая функция без сокета; ошибки домена → `{op:'err', code, retry:false}`, прочие → `{op:'err', code:'internal', retry:true}`.

- [ ] **Step 1: Написать падающий тест**

`apps/server/test/ws-frames.test.ts`:
```ts
import { parseClientFrame } from '@relay/protocol';
import { beforeEach, expect, test } from 'bun:test';
import { handleFrame } from '../src/ws';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

test('parseClientFrame accepts valid frames and rejects junk', () => {
  expect(parseClientFrame('{"op":"sync","since":3}')).toEqual({ op: 'sync', since: 3 });
  expect(parseClientFrame('{"op":"sync","since":"3"}')).toBeNull();
  expect(parseClientFrame('{"op":"send","reqId":"r","clientId":"x","chatId":1,"body":"hi"}')).toBeNull(); // clientId не uuid
  expect(parseClientFrame('not json')).toBeNull();
  expect(parseClientFrame('{"op":"drop_tables"}')).toBeNull();
});

test('send → ack, then sync returns the newMessage and hello reports seq', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const clientId = crypto.randomUUID();
  const [ack] = await handleFrame(a, { op: 'send', reqId: 'r1', clientId, chatId: chat, body: 'привет' });
  expect(ack).toMatchObject({ op: 'ack', reqId: 'r1', result: { clientId, duplicate: false } });

  const [upd] = await handleFrame(b, { op: 'sync', since: 0 });
  expect(upd).toMatchObject({ op: 'updates', from: 0, to: 1, more: false });
  expect((upd as { items: { update: { type: string } }[] }).items[0].update.type).toBe('newMessage');

  expect(await handleFrame(b, { op: 'hello', lastSeq: 0 })).toEqual([{ op: 'hello', seq: 1 }]);
});

test('domain errors are not retryable, ping answers pong', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const chat = await makeChat([a, b]);
  const res = await handleFrame(c, { op: 'send', reqId: 'r', clientId: crypto.randomUUID(), chatId: chat, body: 'x' });
  expect(res).toEqual([{ op: 'err', reqId: 'r', code: 'not_member', retry: false }]);
  expect(await handleFrame(a, { op: 'ping' })).toEqual([{ op: 'pong' }]);
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `docker compose run --rm test bun test test/ws-frames.test.ts`
Expected: FAIL — `Export named 'parseClientFrame' not found`.

- [ ] **Step 3: Разбор кадров** — добавить в `packages/protocol/src/index.ts`:

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function parseClientFrame(raw: string): ClientFrame | null {
  let f: Record<string, unknown>;
  try { f = JSON.parse(raw); } catch { return null; }
  if (!f || typeof f !== 'object') return null;
  switch (f.op) {
    case 'hello': return int(f.lastSeq) ? { op: 'hello', lastSeq: f.lastSeq } : null;
    case 'sync': return int(f.since) ? { op: 'sync', since: f.since } : null;
    case 'ping': return { op: 'ping' };
    case 'send':
      if (!str(f.reqId, 64) || !str(f.clientId, 36) || !UUID.test(f.clientId) || !int(f.chatId) || typeof f.body !== 'string') return null;
      if (f.replyToId != null && !int(f.replyToId)) return null;
      return { op: 'send', reqId: f.reqId, clientId: f.clientId, chatId: f.chatId, body: f.body, replyToId: (f.replyToId as number | null) ?? null };
    case 'read':
      return str(f.reqId, 64) && int(f.chatId) && int(f.upToId) ? { op: 'read', reqId: f.reqId, chatId: f.chatId, upToId: f.upToId } : null;
    default: return null;
  }
}
```

- [ ] **Step 4: Обработчик**

`apps/server/src/ws.ts`:
```ts
import type { ClientFrame, ServerFrame } from '@relay/protocol';
import { DomainError } from './domain/errors';
import { currentSeq, getUpdates } from './domain/journal';
import { sendMessage } from './domain/messages';
import { markRead } from './domain/reads';

export async function handleFrame(userId: number, frame: ClientFrame): Promise<ServerFrame[]> {
  const reqId = 'reqId' in frame ? frame.reqId : undefined;
  try {
    switch (frame.op) {
      case 'hello':
        return [{ op: 'hello', seq: await currentSeq(userId) }];
      case 'sync': {
        const page = await getUpdates(userId, frame.since);
        if (page.tooLong) return [{ op: 'tooLong', seq: page.seq }];
        const to = page.items.length ? page.items[page.items.length - 1].seq : frame.since;
        return [{ op: 'updates', from: frame.since, to, items: page.items, more: page.more }];
      }
      case 'send': {
        const { message, duplicate } = await sendMessage(userId, frame);
        return [{ op: 'ack', reqId: frame.reqId, result: { clientId: message.clientId, id: message.id, createdAt: message.createdAt, duplicate } }];
      }
      case 'read': {
        const res = await markRead(userId, frame.chatId, frame.upToId);
        return [{ op: 'ack', reqId: frame.reqId, result: res }];
      }
      case 'ping':
        return [{ op: 'pong' }];
    }
  } catch (err) {
    if (err instanceof DomainError) return [{ op: 'err', reqId, code: err.code, retry: false }];
    console.error(err);
    return [{ op: 'err', reqId, code: 'internal', retry: true }];
  }
}
```

- [ ] **Step 5: Запустить и убедиться, что проходит**

Run: `docker compose run --rm test bun test test/ws-frames.test.ts`
Expected: PASS, `3 pass`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): websocket frame parsing and handler"
```

---

### Task 9: Транспорт WebSocket, poke через LISTEN/NOTIFY и сквозной сценарий

**Files:**
- Modify: `apps/server/src/http.ts` (обработчики `websocket`)
- Create: `apps/server/src/realtime.ts`, `apps/server/src/main.ts`
- Modify: `apps/server/test/helpers.ts` (`nextFrame`)
- Test: `apps/server/test/e2e.test.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: `handleFrame`, `parseClientFrame` (Task 8), `createServer`, `WsData` (Task 7).
- Produces: `startRealtime(server: Server): Promise<() => Promise<void>>` — подписка `LISTEN updates`, на каждого пользователя из уведомления `server.publish('user:' + id, '{"op":"poke"}')`; возвращает функцию отписки.
- Produces: сокет при открытии подписан на `user:{userId}`; невалидный кадр → `{op:'err', code:'bad_frame', retry:false}`.

- [ ] **Step 1: Написать падающий сквозной тест**

`apps/server/test/helpers.ts` — добавить:
```ts
import type { ServerFrame } from '@relay/protocol';

/** Ждёт первый кадр, удовлетворяющий условию; копит пропущенные, чтобы не терять порядок. */
export function nextFrame(ws: WebSocket, match: (f: ServerFrame) => boolean, timeoutMs = 3000): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', on); reject(new Error('timeout waiting for frame')); }, timeoutMs);
    function on(e: MessageEvent) {
      const f = JSON.parse(String(e.data)) as ServerFrame;
      if (match(f)) { clearTimeout(timer); ws.removeEventListener('message', on); resolve(f); }
    }
    ws.addEventListener('message', on);
  });
}
```

`apps/server/test/e2e.test.ts`:
```ts
import type { ServerFrame } from '@relay/protocol';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { startRealtime } from '../src/realtime';
import { nextFrame, resetDb } from './helpers';

const server = createServer({ port: 0 });
const stopRealtime = await startRealtime(server);
const base = `http://localhost:${server.port}`;
afterAll(async () => { await stopRealtime(); server.stop(true); });
beforeEach(resetDb);

async function login(name: string) {
  const res = await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) });
  return (await res.json()) as { userId: number; token: string };
}
async function connect(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?token=${token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}
const send = (ws: WebSocket, f: unknown) => ws.send(JSON.stringify(f));

test('A sends → B is poked → B syncs → B reads → A sees readBy', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const { id: chatId } = await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json() as { id: number };
  const wa = await connect(a.token), wb = await connect(b.token);

  const poked = nextFrame(wb, (f) => f.op === 'poke');
  const acked = nextFrame(wa, (f) => f.op === 'ack');
  send(wa, { op: 'send', reqId: 'r1', clientId: crypto.randomUUID(), chatId, body: 'привет' });
  const ack = (await acked) as Extract<ServerFrame, { op: 'ack' }>;
  await poked;

  const gotUpdates = nextFrame(wb, (f) => f.op === 'updates');
  send(wb, { op: 'sync', since: 0 });
  const upd = (await gotUpdates) as Extract<ServerFrame, { op: 'updates' }>;
  expect(upd.items.map((i) => i.update.type)).toEqual(['newMessage']);

  const aPoked = nextFrame(wa, (f) => f.op === 'poke');
  send(wb, { op: 'read', reqId: 'r2', chatId, upToId: ack.result.id });
  await aPoked;
  const aUpdates = nextFrame(wa, (f) => f.op === 'updates');
  send(wa, { op: 'sync', since: 1 });
  const readBy = ((await aUpdates) as Extract<ServerFrame, { op: 'updates' }>).items.map((i) => i.update);
  expect(readBy).toEqual([{ type: 'readBy', chatId, userId: b.userId, upToId: ack.result.id }]);

  wa.close(); wb.close();
});

test('junk frames get bad_frame and the socket stays open', async () => {
  const a = await login('a');
  const ws = await connect(a.token);
  const err = nextFrame(ws, (f) => f.op === 'err');
  ws.send('{"op":"drop_tables"}');
  expect(await err).toEqual({ op: 'err', code: 'bad_frame', retry: false });
  const pong = nextFrame(ws, (f) => f.op === 'pong');
  send(ws, { op: 'ping' });
  await pong;
  ws.close();
});

test('websocket without a session is refused', async () => {
  const res = await fetch(`${base}/ws`, { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `docker compose run --rm test bun test test/e2e.test.ts`
Expected: FAIL — `Cannot find module '../src/realtime'`.

- [ ] **Step 3: Обработчики сокета** — в `apps/server/src/http.ts` заменить блок `websocket: { message() {} }` на:

```ts
    websocket: {
      open(ws) {
        ws.subscribe(`user:${ws.data.userId}`);
      },
      async message(ws, raw) {
        const frame = parseClientFrame(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
        if (!frame) {
          ws.send(JSON.stringify({ op: 'err', code: 'bad_frame', retry: false }));
          return;
        }
        for (const out of await handleFrame(ws.data.userId, frame)) ws.send(JSON.stringify(out));
      },
    },
```

и добавить импорты в начало файла:
```ts
import { parseClientFrame } from '@relay/protocol';
import { handleFrame } from './ws';
```

- [ ] **Step 4: Realtime и точка входа**

`apps/server/src/realtime.ts`:
```ts
import type { Server } from 'bun';
import { sql } from './db';

const POKE = JSON.stringify({ op: 'poke' });

/** Будит сокеты пользователей, чьи журналы изменились в любом процессе сервера. */
export async function startRealtime(server: Server): Promise<() => Promise<void>> {
  const sub = await sql.listen('updates', (payload) => {
    let users: number[];
    try { users = JSON.parse(payload); } catch { return; }
    for (const id of users) server.publish(`user:${id}`, POKE);
  });
  return () => sub.unlisten();
}
```

`apps/server/src/main.ts`:
```ts
import { createServer } from './http';
import { startRealtime } from './realtime';

const server = createServer({ port: Number(process.env.PORT ?? 3000) });
await startRealtime(server);
console.log(`relay server on :${server.port}`);
```

- [ ] **Step 5: Запустить все тесты**

Run: `docker compose run --rm test`
Expected: PASS — все файлы, `e2e.test.ts` — `3 pass`.

- [ ] **Step 6: Проверить в живом окружении**

Run: `docker compose up -d --build server && curl -s localhost:3000/health`
Expected: `{"ok":true}`; в `docker compose logs migrate` — `applied: 001_init.sql`, в `docker compose logs server` — `relay server on :3000`.

- [ ] **Step 7: README с командами**

`README.md`:
````markdown
# Relay Chat

Всё запускается в Docker.

```bash
docker compose up --build          # postgres + миграции + сервер на :3000 (горячая перезагрузка)
docker compose run --rm test       # все серверные тесты на базе relay_test
docker compose run --rm test bun test test/e2e.test.ts   # один файл
docker compose down -v             # остановить и удалить данные
```

Dev-вход (`DEV_LOGIN=1`): `POST /dev/login {"name":"Анна"}` → cookie `relay_session`; `POST /dev/chats {"kind":"direct","title":null,"memberIds":[1,2]}`; WebSocket `/ws`.
````

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(server): websocket transport with LISTEN/NOTIFY pokes and e2e flow"
```
