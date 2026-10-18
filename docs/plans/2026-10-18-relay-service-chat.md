# Служебный чат Relay — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** системный пользователь «Relay» со служебным чатом, вход по одноразовому коду, который приходит в этот чат на другие устройства, сообщение «Новый вход» и плашка «Это вы?» с подтверждением или завершением нового сеанса.

**Architecture:** служебные сообщения — обычные строки `messages` от системного пользователя в личном чате «пользователь ↔ Relay». Они идут через тот же журнал `updates` (`fanOut`), поэтому синхронизация, офлайн, счётчики и Web Push работают без новых механизмов. У сообщения есть машинный тип `service_type`: клиент по нему прячет код в превью и пушах, а сервер склеивает повторы. Сеанс получает `confirmed_at`: неподтверждённый сеанс не может завершать другие. Об изменении списка сеансов клиенты узнают из журнала (`sessionsChanged`).

**Tech Stack:** Bun, Postgres (postgres.js), Preact, sync-engine в SharedWorker, `@relay/ui`. Тесты: `docker compose --profile test run --rm test` (сервер), `docker compose --profile test run --rm test-engine` (движок), `bunx tsc --noEmit -p apps/web`.

Основа — `docs/research/2026-10-18-telegram-service-notifications.md`, раздел 6.

## Global Constraints

- Никакого кода из telegram-tt и tweb (GPL): только поведение, своя реализация и свои формулировки текстов.
- Плавный интерфейс: никаких вспышек; новые состояния — с задержкой показа, минимальным временем и кроссфейдом (память relay-smooth-ui). Плашка «Это вы?» появляется как остальные плашки над вкладками.
- В тестах и проверках не трогать настоящие мессенджеры пользователя и ничего никуда не отправлять.
- Код входа: 5 цифр, живёт 5 минут, 5 попыток ввода на одну попытку входа, не больше 5 кодов в час на аккаунт.
- Сеанс считается подтверждённым, если `confirmed_at` задан или сеанс старше 7 дней (автоподтверждение).
- Неподтверждённый сеанс не может завершать другие сеансы и подтверждать чужие: ошибка `fresh_session`.
- Dev-вход по имени (`POST /dev/login`) остаётся. Его сеансы сразу подтверждены, а войти им под системным пользователем нельзя.
- Код в списке чатов, в локальных уведомлениях и в Web Push не показывается. Сам код виден только внутри служебного чата.
- Номер миграции — следующий свободный (сейчас `108`). Перед задачей проверить `ls apps/server/migrations`: в master параллельно работают другие сессии.

---

## File Structure

| Файл | Ответственность |
|---|---|
| `apps/server/migrations/108_service.sql` (создать) | `users.system`, строка системного пользователя, `service_chats`, `messages.service_type`, `login_attempts`, `sessions.confirmed_at` |
| `apps/server/src/domain/service.ts` (создать) | системный пользователь, служебный чат, `postService()`, тексты служебных сообщений |
| `apps/server/src/domain/login.ts` (создать) | коды входа: запрос, проверка, сжигание, лимиты |
| `apps/server/src/domain/sessions.ts` (изменить) | `unconfirmed` в списке, `confirmSession()`, правило `fresh_session`, `sessionsChanged` в журнал |
| `apps/server/src/auth.ts` (изменить) | `createSession(..., { confirmed })` |
| `apps/server/src/domain/messages.ts` (изменить) | запрет писать в служебный чат, сжигание кода в исходящем тексте |
| `apps/server/src/domain/messageOps.ts` (изменить) | запрет реакций и правок в служебном чате |
| `apps/server/src/domain/chats.ts` (изменить) | `peer.system`, `service` у сообщения |
| `apps/server/src/domain/push.ts` (изменить) | текст пуша для `login_code` без кода |
| `apps/server/src/http.ts` (изменить) | `POST /auth/code`, `POST /auth/signin`, `POST /sessions/:id/confirm` |
| `packages/protocol/src/index.ts` (изменить) | `ServiceType`, `Message.service`, `PublicUser.system`, `SessionInfo.unconfirmed`, `Update sessionsChanged`, коды ошибок |
| `packages/sync-engine/src/store.ts`, `engine.ts` (изменить) | `sessionsRev` в статусе по `sessionsChanged` |
| `apps/web/src/data.ts` (изменить) | перечитать сеансы при смене `sessionsRev` |
| `apps/web/src/ui/Login.tsx` (переписать) | вход по коду в два шага, dev-вход вторым вариантом |
| `apps/web/src/ui/Chat.tsx`, `Feed.tsx`, `preview.tsx`, `notify.ts` | служебный чат: подзаголовок, галочка, нет поля ввода, копирование кода, код скрыт в превью |
| `apps/web/src/banners.ts`, `apps/web/src/ui/Sidebar.tsx` | плашка «Это вы?» |
| `apps/web/src/ui/settings/Sessions.tsx` | пометка «не подтверждён» и кнопка «Это я» |
| `apps/server/test/service.test.ts`, `login.test.ts`, `sessions.test.ts` | тесты сервера |

---

### Task 1: Схема и системный пользователь

**Files:**
- Create: `apps/server/migrations/108_service.sql`
- Create: `apps/server/src/domain/service.ts`
- Modify: `apps/server/src/http.ts` (dev-логин не находит системного пользователя)
- Modify: `apps/server/test/helpers.ts` (сброс не удаляет системного пользователя)
- Test: `apps/server/test/service.test.ts`

**Interfaces:**
- Produces: `systemUserId(): Promise<number>`; `serviceChatId(db: Tx | typeof sql, userId: number): Promise<number>`; `isServiceChat(db, chatId: number): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/service.test.ts
import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { isServiceChat, serviceChatId, systemUserId } from '../src/domain/service';
import { makeUser, resetDb } from './helpers';

beforeEach(resetDb);

test('system user exists and survives a reset; the service chat is created once per user', async () => {
  const sys = await systemUserId();
  const [u] = await sql`select name, system from users where id = ${sys}`;
  expect(u).toMatchObject({ name: 'Relay', system: true });

  const a = await makeUser('Анна');
  const chat = await serviceChatId(sql, a);
  expect(await serviceChatId(sql, a)).toBe(chat);
  const members = (await sql`select user_id from chat_members where chat_id = ${chat} order by user_id`).map((r) => Number(r.user_id));
  expect(members.sort()).toEqual([a, sys].sort());
  expect(await isServiceChat(sql, chat)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose --profile test run --rm test bun test service`
Expected: FAIL, `Cannot find module '../src/domain/service'`.

- [ ] **Step 3: Migration**

```sql
-- apps/server/migrations/108_service.sql
-- Служебный чат: системный пользователь «Relay», личный чат с ним у каждого, коды входа, подтверждение сеансов.
alter table users add column if not exists system boolean not null default false;
insert into users (name, system) select 'Relay', true where not exists (select 1 from users where system);
create unique index if not exists users_one_system on users (system) where system;

create table if not exists service_chats (
  user_id bigint primary key references users on delete cascade,
  chat_id bigint not null unique references chats on delete cascade
);

-- машинный тип служебного сообщения: login_code, new_login; у обычных — null
alter table messages add column if not exists service_type text;

create table if not exists login_attempts (
  id uuid primary key,
  user_id bigint not null references users on delete cascade,
  code_hash text not null,
  tries int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists login_attempts_user on login_attempts (user_id, created_at desc);

-- null — сеанс ещё не подтверждён (вход по коду); старые сеансы считаем подтверждёнными
alter table sessions add column if not exists confirmed_at timestamptz;
update sessions set confirmed_at = created_at where confirmed_at is null;
```

- [ ] **Step 4: Domain module**

```ts
// apps/server/src/domain/service.ts
import { sql, type Tx } from '../db';

type Db = Tx | typeof sql;
let systemId: Promise<number> | null = null;

/** Системный пользователь «Relay» (строка из миграции 108). Кэшируется на процесс. */
export function systemUserId(): Promise<number> {
  return systemId ??= sql`select id from users where system limit 1`.then(([r]) => {
    if (!r) throw new Error('system user missing: run migrations');
    return Number(r.id);
  }).catch((e) => { systemId = null; throw e; });
}

/** Служебный чат пользователя: создаётся при первом служебном сообщении, дальше один и тот же. */
export async function serviceChatId(db: Db, userId: number): Promise<number> {
  const [found] = await db`select chat_id from service_chats where user_id = ${userId}`;
  if (found) return Number(found.chat_id);
  const sys = await systemUserId();
  const [chat] = await db`insert into chats (kind, title) values ('direct', null) returning id`;
  await db`insert into chat_members (chat_id, user_id) values (${chat.id}, ${userId}), (${chat.id}, ${sys})`;
  // гонка двух первых сообщений: побеждает первая вставка, лишний чат удаляем
  const [won] = await db`insert into service_chats (user_id, chat_id) values (${userId}, ${chat.id}) on conflict (user_id) do nothing returning chat_id`;
  if (won) return Number(won.chat_id);
  await db`delete from chats where id = ${chat.id}`;
  const [r] = await db`select chat_id from service_chats where user_id = ${userId}`;
  return Number(r.chat_id);
}

export async function isServiceChat(db: Db, chatId: number): Promise<boolean> {
  const [r] = await db`select 1 from service_chats where chat_id = ${chatId}`;
  return !!r;
}
```

- [ ] **Step 5: Reset keeps the system user; dev login skips it**

В `apps/server/test/helpers.ts` заменить тело `resetDb`: `truncate users ...` удалило бы системного пользователя.

```ts
export async function resetDb(): Promise<void> {
  await sql`truncate sessions, chats, chat_members, messages, user_seq, updates restart identity cascade`;
  await sql`delete from users where not system`;
}
```

В `apps/server/src/http.ts`, в обработчике `/dev/login`, поиск по имени не должен находить системного пользователя:

```ts
const [found] = await sql`select id from users where name = ${String(name ?? '')} and not system order by id limit 1`;
```

- [ ] **Step 6: Run tests**

Run: `docker compose --profile test run --rm test`
Expected: все тесты проходят, включая `service.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/migrations/108_service.sql apps/server/src/domain/service.ts apps/server/src/http.ts apps/server/test/helpers.ts apps/server/test/service.test.ts
git commit -m "feat(server): system user Relay and a per-user service chat"
```

---

### Task 2: Служебные сообщения и запреты в служебном чате

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/server/src/domain/service.ts`
- Modify: `apps/server/src/domain/chats.ts` (`toMessage`, `peer`)
- Modify: `apps/server/src/domain/messages.ts`, `apps/server/src/domain/messageOps.ts`
- Modify: `apps/server/src/domain/push.ts`
- Test: `apps/server/test/service.test.ts`

**Interfaces:**
- Consumes: `systemUserId`, `serviceChatId`, `isServiceChat` (Task 1).
- Produces:
  - `type ServiceType = 'login_code' | 'new_login'`;
  - `Message.service?: { type: ServiceType }`;
  - `ChatSummary.peer` gains `system?: true`;
  - `postService(tx: Tx, userId: number, msg: { type: ServiceType; body: string; entities?: Entity[] }): Promise<Message>`.

- [ ] **Step 1: Write the failing test**

```ts
// добавить в apps/server/test/service.test.ts
import { postService } from '../src/domain/service';
import { sendMessage } from '../src/domain/messages';
import { reactMessage } from '../src/domain/messageOps';

test('service message lands in the journal; the user cannot write or react there', async () => {
  const a = await makeUser('Анна');
  const m = await sql.begin((tx) => postService(tx, a, { type: 'new_login', body: 'Новый вход' }));
  expect(m).toMatchObject({ senderId: await systemUserId(), body: 'Новый вход', service: { type: 'new_login' } });
  const [u] = await sql`select type, payload from updates where user_id = ${a} order by seq desc limit 1`;
  expect(u.type).toBe('newMessage');
  expect(u.payload.message.service).toEqual({ type: 'new_login' });

  await expect(sendMessage(a, { chatId: m.chatId, clientId: crypto.randomUUID(), body: 'ответ' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(reactMessage(a, m.chatId, m.id, '👍')).rejects.toMatchObject({ code: 'forbidden' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose --profile test run --rm test bun test service`
Expected: FAIL, `postService` is not exported.

- [ ] **Step 3: Protocol types**

В `packages/protocol/src/index.ts`:

```ts
/** Служебное сообщение от системного пользователя: машинный тип для отрисовки и склейки повторов. */
export type ServiceType = 'login_code' | 'new_login';
```

В `interface Message` добавить поле:

```ts
  service?: { type: ServiceType };   // есть только у служебных сообщений
```

В `interface PublicUser` добавить поле:

```ts
  /** системный пользователь «Relay»: служебные уведомления, ответить нельзя */
  system?: true;
```

- [ ] **Step 4: Server mapping**

В `apps/server/src/domain/chats.ts`, в `toMessage`, добавить:

```ts
    ...(r.service_type ? { service: { type: r.service_type as ServiceType } } : {}),
```

В подзапросе `peer` в `listChats` и `listChatsPage` собрать флаг системного пользователя:

```sql
json_build_object('id', u.id, 'name', u.name, 'system', u.system)
```

В отображении убирать `false`:

```ts
peer: r.peer ? { id: r.peer.id, name: r.peer.name, ...(r.peer.system ? { system: true } : {}) } : null,
```

В тип `ChatSummary.peer` добавить `system?: true`.

- [ ] **Step 5: postService**

В `apps/server/src/domain/service.ts`:

```ts
import type { Entity, Message, ServiceType } from '@relay/protocol';
import { toMessage } from './chats';
import { fanOut } from './journal';

/** Служебное сообщение пользователю: обычная строка messages + newMessage в журнал (синхронизация и пуши как у всех). */
export async function postService(tx: Tx, userId: number, msg: { type: ServiceType; body: string; entities?: Entity[] }): Promise<Message> {
  const chatId = await serviceChatId(tx, userId);
  const sys = await systemUserId();
  const [row] = await tx`
    insert into messages (chat_id, sender_id, client_id, kind, body, entities, service_type)
    values (${chatId}, ${sys}, ${crypto.randomUUID()}, 'text', ${msg.body}, ${msg.entities?.length ? tx.json(msg.entities as never) : null}, ${msg.type})
    returning *`;
  const message = toMessage(row);
  await fanOut(tx, [userId], { type: 'newMessage', message });
  return message;
}
```

Если колонка `entities` в `messages` называется иначе, посмотреть миграцию `107_entities.sql` и использовать её имя и формат.

- [ ] **Step 6: Bans in the service chat**

В `apps/server/src/domain/messages.ts`, внутри `sql.begin`, сразу после `assertMember`:

```ts
    if (await isServiceChat(tx, input.chatId)) throw new DomainError('forbidden');   // служебный чат только для чтения
```

В `apps/server/src/domain/messageOps.ts`, в начале транзакций `editMessage` и `reactMessage`, после проверки членства:

```ts
    if (await isServiceChat(tx, chatId)) throw new DomainError('forbidden');
```

`deleteMessage` не трогаем: удаление служебных сообщений у себя разрешено.

- [ ] **Step 7: Push text without the code**

В `apps/server/src/domain/push.ts`, в `pushNewMessage`, перед формированием `preview`:

```ts
  // код входа не уходит в push-сервис и на экран блокировки
  if (m.service?.type === 'login_code') m = { ...m, body: 'Код для входа в Relay' };
```

Сигнатура `pushNewMessage` должна принимать `service?: { type: string }` — расширить тип параметра.

- [ ] **Step 8: Run tests**

Run: `docker compose --profile test run --rm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/protocol/src/index.ts apps/server/src/domain apps/server/test/service.test.ts
git commit -m "feat(server): service messages through the journal; the service chat is read-only"
```

---

### Task 3: Коды входа

**Files:**
- Create: `apps/server/src/domain/login.ts`
- Modify: `apps/server/src/auth.ts` (`createSession` с `confirmed`)
- Modify: `apps/server/src/domain/messages.ts` (сжигание кода)
- Modify: `apps/server/src/http.ts` (`/auth/code`, `/auth/signin`, `API`-регэксп)
- Modify: `packages/protocol/src/index.ts` (коды ошибок)
- Test: `apps/server/test/login.test.ts`

**Interfaces:**
- Consumes: `postService` (Task 2).
- Produces:
  - `requestCode(login: string): Promise<{ attemptId: string; via: 'app' | 'none'; length: 5; devCode?: string }>`;
  - `signIn(attemptId: string, code: string): Promise<{ userId: number }>`, which throws `code_invalid` | `code_expired` | `flood`;
  - `burnCodes(tx: Tx, userId: number, text: string): Promise<void>`;
  - `createSession(userId, from?, opts?: { confirmed?: boolean })`;
  - `ErrorCode` gains `'code_invalid' | 'code_expired' | 'flood' | 'fresh_session'`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/login.test.ts
import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createSession } from '../src/auth';
import { requestCode, signIn } from '../src/domain/login';
import { sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
process.env.DEV_LOGIN = '1';   // devCode в ответе: SMS нет, код читаем как «второе устройство»

async function userWithSession(name: string, username: string) {
  const id = await makeUser(name);
  await sql`update users set username = ${username} where id = ${id}`;
  await createSession(id);
  return id;
}

test('code goes to the service chat of a user with a session; right code signs in once', async () => {
  const a = await userWithSession('Анна', 'anna');
  const r = await requestCode('@anna');
  expect(r).toMatchObject({ via: 'app', length: 5 });
  const [msg] = await sql`select body, service_type from messages where service_type = 'login_code' order by id desc limit 1`;
  expect(msg.body).toContain(r.devCode!);
  expect(await signIn(r.attemptId, r.devCode!)).toEqual({ userId: a });
  await expect(signIn(r.attemptId, r.devCode!)).rejects.toMatchObject({ code: 'code_expired' });   // одноразовый
});

test('wrong codes: five tries, then the attempt is gone; unknown login looks the same', async () => {
  await userWithSession('Борис', 'boris');
  const r = await requestCode('@boris');
  for (let i = 0; i < 5; i++) await expect(signIn(r.attemptId, '00000')).rejects.toMatchObject({ code: 'code_invalid' });
  await expect(signIn(r.attemptId, r.devCode!)).rejects.toMatchObject({ code: 'code_expired' });
  const ghost = await requestCode('@nobody');
  expect(ghost).toMatchObject({ via: 'app', length: 5 });   // существование аккаунта не раскрываем
  expect(ghost.devCode).toBeUndefined();
  await expect(signIn(ghost.attemptId, '12345')).rejects.toMatchObject({ code: 'code_invalid' });
});

test('at most five codes an hour', async () => {
  await userWithSession('Вера', 'vera');
  for (let i = 0; i < 5; i++) await requestCode('@vera');
  await expect(requestCode('@vera')).rejects.toMatchObject({ code: 'flood' });
});

test('a code sent in a message is burned', async () => {
  const a = await userWithSession('Гена', 'gena');
  const b = await makeUser('Злоумышленник');
  const chat = await makeChat([a, b]);
  const r = await requestCode('@gena');
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: `вот код ${r.devCode}` });
  await expect(signIn(r.attemptId, r.devCode!)).rejects.toMatchObject({ code: 'code_expired' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose --profile test run --rm test bun test login`
Expected: FAIL, `Cannot find module '../src/domain/login'`.

- [ ] **Step 3: Error codes**

В `packages/protocol/src/index.ts` дописать в `ErrorCode`:

```ts
  | 'code_invalid' | 'code_expired' | 'flood' | 'fresh_session'
```

В `apps/server/src/http.ts`, в `STATUS`, добавить:

```ts
code_invalid: 400, code_expired: 400, flood: 429, fresh_session: 403
```

- [ ] **Step 4: Login domain**

```ts
// apps/server/src/domain/login.ts
import { createHash, randomInt } from 'node:crypto';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { postService, systemUserId } from './service';

export const CODE_LENGTH = 5;
const CODE_TTL_MIN = 5, MAX_TRIES = 5, MAX_PER_HOUR = 5;
const hash = (code: string) => createHash('sha256').update('relay-login:' + code).digest('hex');

/** Вход по телефону («+7…») или имени пользователя («@anna» / «anna»). Системного пользователя не найти. */
async function findUser(login: string): Promise<number | null> {
  const s = login.trim();
  const [r] = s.startsWith('+')
    ? await sql`select id from users where phone = ${s} and not system`
    : await sql`select id from users where lower(username) = ${s.replace(/^@/, '').toLowerCase()} and not system`;
  return r ? Number(r.id) : null;
}

/** Текст сообщения с кодом; entity code — моноширинный, клиент копирует его по клику. */
export function codeMessage(code: string): { body: string; entities: { type: 'code'; offset: number; length: number }[] } {
  const head = 'Код для входа в Relay: ';
  const body = `${head}${code}\n\nНикому не сообщайте этот код, даже если его просят от имени Relay. Он нужен только для входа в ваш аккаунт.\n\nЕсли вы не входили, ничего не делайте — без кода войти нельзя.`;
  return { body, entities: [{ type: 'code', offset: head.length, length: code.length }] };
}

/**
 * Попытка входа: код уходит в служебный чат на устройства, где аккаунт уже открыт.
 * Неизвестный логин отвечает так же: попытка записывается на системного пользователя со случайным хэшем,
 * её код не совпадёт никогда — по ответам нельзя понять, есть ли такой аккаунт.
 * via 'none' — открытых сеансов нет, код доставить некуда (SMS в Relay нет).
 */
export async function requestCode(login: string): Promise<{ attemptId: string; via: 'app' | 'none'; length: 5; devCode?: string }> {
  const attemptId = crypto.randomUUID();
  const expires = sql`now() + ${CODE_TTL_MIN + ' minutes'}::interval`;
  const userId = await findUser(login);
  if (userId == null) {
    await sql`insert into login_attempts (id, user_id, code_hash, expires_at) values (${attemptId}, ${await systemUserId()}, ${hash(crypto.randomUUID())}, ${expires})`;
    return { attemptId, via: 'app', length: CODE_LENGTH };
  }
  const [{ n }] = await sql`select count(*)::int as n from login_attempts where user_id = ${userId} and created_at > now() - interval '1 hour'`;
  if (n >= MAX_PER_HOUR) throw new DomainError('flood');
  const [{ live }] = await sql`select count(*)::int as live from sessions where user_id = ${userId} and expires_at > now()`;
  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
  await sql.begin(async (tx) => {
    await tx`insert into login_attempts (id, user_id, code_hash, expires_at) values (${attemptId}, ${userId}, ${hash(code)}, ${expires})`;
    if (live) await postService(tx, userId, { type: 'login_code', ...codeMessage(code) });
  });
  return { attemptId, via: live ? 'app' : 'none', length: CODE_LENGTH, ...(process.env.DEV_LOGIN === '1' ? { devCode: code } : {}) };
}

/**
 * Проверка кода. Попытки нет (использована, сожжена, истекла, кончились попытки) — code_expired.
 * Неверный код — code_invalid; пятая ошибка удаляет попытку. Верный — попытка удаляется (код одноразовый).
 */
export async function signIn(attemptId: string, code: string): Promise<{ userId: number }> {
  if (!/^[0-9a-f-]{36}$/.test(attemptId)) throw new DomainError('code_invalid');
  const sys = await systemUserId();
  return sql.begin(async (tx) => {
    const [a] = await tx`select user_id, code_hash, tries, expires_at < now() as expired from login_attempts where id = ${attemptId} for update`;
    if (!a) throw new DomainError('code_expired');
    if (a.expired) { await tx`delete from login_attempts where id = ${attemptId}`; throw new DomainError('code_expired'); }
    if (a.code_hash !== hash(code.trim()) || Number(a.user_id) === sys) {
      if (a.tries + 1 >= MAX_TRIES) await tx`delete from login_attempts where id = ${attemptId}`;
      else await tx`update login_attempts set tries = tries + 1 where id = ${attemptId}`;
      throw new DomainError('code_invalid');
    }
    await tx`delete from login_attempts where id = ${attemptId}`;
    return { userId: Number(a.user_id) };
  });
}

/** Код появился в исходящем тексте — сжигаем все такие попытки владельца (защита от «пришлите код из Relay»). */
export async function burnCodes(tx: Tx, userId: number, text: string): Promise<void> {
  const codes = [...new Set(text.replace(/-/g, '').match(/\d{5}/g) ?? [])];
  if (!codes.length) return;
  await tx`delete from login_attempts where user_id = ${userId} and code_hash = any(${codes.map(hash)})`;
}
```

- [ ] **Step 5: Burn codes on send**

В `apps/server/src/domain/messages.ts`, в транзакции `sendMessage`, сразу после вставки сообщения:

```ts
    await burnCodes(tx, userId, body);
```

- [ ] **Step 6: Confirmed flag on sessions**

В `apps/server/src/auth.ts`:

```ts
export async function createSession(userId: number, from?: { req: Request; server: IpSource }, opts: { confirmed?: boolean } = {}): Promise<string> {
  // ...прежнее тело; в insert добавить колонку:
  await sql`insert into sessions (token_hash, user_id, expires_at, device, ip, confirmed_at)
            values (${hash(token)}, ${userId}, now() + ${SESSION_DAYS + ' days'}::interval, ${device}, ${ip}, ${opts.confirmed === false ? null : sql`now()`})`;
```

- [ ] **Step 7: HTTP routes (before the auth check)**

В `apps/server/src/http.ts` расширить `API`-регэксп словом `auth`. Рядом с `/push/key`, до `sessionFromToken`:

```ts
        if (req.method === 'POST' && url.pathname === '/auth/code') {
          const { login } = (await req.json()) as { login?: unknown };
          if (typeof login !== 'string' || !login.trim() || login.length > 64) return fail('bad_frame');
          return Response.json(await requestCode(login));
        }
        if (req.method === 'POST' && url.pathname === '/auth/signin') {
          const { attemptId, code } = (await req.json()) as { attemptId?: unknown; code?: unknown };
          if (typeof attemptId !== 'string' || typeof code !== 'string') return fail('bad_frame');
          const { userId } = await signIn(attemptId, code);
          const token = await createSession(userId, { req, server }, { confirmed: false });
          await announceLogin(userId, token);   // Task 4
          return Response.json({ userId }, { headers: { 'set-cookie': sessionCookie(token) } });
        }
```

До Task 4 вызов `announceLogin` закомментировать или убрать. `DomainError` из этих обработчиков уходит в общий `catch` и превращается в `fail(code)` — проверить, что общий обработчик так и делает.

- [ ] **Step 8: Run tests**

Run: `docker compose --profile test run --rm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/protocol/src/index.ts apps/server/src/auth.ts apps/server/src/domain/login.ts apps/server/src/domain/messages.ts apps/server/src/http.ts apps/server/test/login.test.ts
git commit -m "feat(server): sign-in codes delivered to the service chat — one-time, 5 min, 5 tries, burned when shared"
```

---

### Task 4: «Новый вход», подтверждение сеанса, правило свежего сеанса

**Files:**
- Modify: `packages/protocol/src/index.ts` (`SessionInfo.unconfirmed`, `Update sessionsChanged`)
- Modify: `apps/server/src/domain/sessions.ts`
- Modify: `apps/server/src/domain/service.ts` (текст «Новый вход»)
- Modify: `apps/server/src/http.ts` (`POST /sessions/:id/confirm`, `announceLogin`)
- Test: `apps/server/test/sessions.test.ts`

**Interfaces:**
- Consumes: `postService` (Task 2), `createSession(..., { confirmed: false })` (Task 3).
- Produces:
  - `SessionInfo.unconfirmed: boolean`;
  - `Update { type: 'sessionsChanged' }`;
  - `announceLogin(userId: number, token: string): Promise<void>`;
  - `confirmSession(userId: number, currentId: number, id: number): Promise<{ ok: true }>`;
  - `terminateSession` / `terminateOthers` throw `fresh_session` from an unconfirmed current session.

- [ ] **Step 1: Write the failing test**

```ts
// добавить в apps/server/test/sessions.test.ts
import { announceLogin, confirmSession, listSessions, terminateSession } from '../src/domain/sessions';
import { createSession, sessionFromToken } from '../src/auth';

test('new code login: unconfirmed, announced in the service chat, cannot terminate others until confirmed', async () => {
  const a = await makeUser('Анна');
  const old = (await sessionFromToken(await createSession(a)))!.sessionId;
  const newToken = await createSession(a, undefined, { confirmed: false });
  const fresh = (await sessionFromToken(newToken))!.sessionId;
  await announceLogin(a, newToken);

  const list = await listSessions(a, old);
  expect(list.find((s) => s.id === fresh)).toMatchObject({ unconfirmed: true });
  const [msg] = await sql`select body from messages where service_type = 'new_login' order by id desc limit 1`;
  expect(msg.body).toContain('Новый вход');
  const types = (await sql`select type from updates where user_id = ${a} order by seq`).map((r) => r.type);
  expect(types).toContain('sessionsChanged');

  await expect(terminateSession(a, fresh, old)).rejects.toMatchObject({ code: 'fresh_session' });
  await expect(confirmSession(a, fresh, fresh)).rejects.toMatchObject({ code: 'bad_frame' });   // себя не подтверждают
  await confirmSession(a, old, fresh);
  expect((await listSessions(a, old)).find((s) => s.id === fresh)).toMatchObject({ unconfirmed: false });
});

test('a week-old unconfirmed session counts as confirmed', async () => {
  const a = await makeUser('Борис');
  const t = await createSession(a, undefined, { confirmed: false });
  const id = (await sessionFromToken(t))!.sessionId;
  await sql`update sessions set created_at = now() - interval '8 days' where id = ${id}`;
  expect((await listSessions(a, id))[0]).toMatchObject({ unconfirmed: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose --profile test run --rm test bun test sessions`
Expected: FAIL, `announceLogin` is not exported.

- [ ] **Step 3: Protocol**

```ts
export interface SessionInfo { id: Id; device: string; ip: string | null; createdAt: string; lastActiveAt: string; current: boolean; online: boolean; unconfirmed: boolean }
```

В `Update` добавить вариант:

```ts
  | { type: 'sessionsChanged' }   // список сеансов изменился: новый вход, подтверждение, завершение
```

- [ ] **Step 4: Sessions domain**

В `apps/server/src/domain/sessions.ts`:

```ts
import { appendUpdates } from './journal';
import { postService } from './service';

/** Сеанс не подтверждён: вход по коду без «Да, это я» и моложе недели. */
const UNCONFIRMED = sql`(confirmed_at is null and created_at > now() - interval '7 days')`;

async function assertConfirmed(db: Tx | typeof sql, sessionId: number): Promise<void> {
  const [r] = await db`select ${UNCONFIRMED} as u from sessions where id = ${sessionId}`;
  if (r?.u) throw new DomainError('fresh_session');
}

const changed = (db: Tx | typeof sql, userId: number) => appendUpdates(db as Tx, [{ userId, update: { type: 'sessionsChanged' } }]);
```

- `listSessions`: добавить `${UNCONFIRMED} as unconfirmed` в `select`, в результат — `unconfirmed: !!r.unconfirmed`, тип `Row` дополнить.
- `terminateSession` и `terminateOthers`: в начале транзакции вызвать `await assertConfirmed(tx, currentId);`, после удаления — `await changed(tx, userId);`.
- Новые функции:

```ts
/** «Да, это я» с другого устройства. Неподтверждённый сеанс подтверждать не может, себя — тоже. */
export async function confirmSession(userId: number, currentId: number, id: number): Promise<{ ok: true }> {
  if (id === currentId) throw new DomainError('bad_frame');
  await sql.begin(async (tx) => {
    await assertConfirmed(tx, currentId);
    const rows = await tx`update sessions set confirmed_at = now() where id = ${id} and user_id = ${userId} returning id`;
    if (!rows.length) throw new DomainError('not_found');
    await changed(tx, userId);
  });
  return { ok: true };
}

/** После входа по коду: служебное «Новый вход» и sessionsChanged — плашка «Это вы?» на остальных устройствах. */
export async function announceLogin(userId: number, token: string): Promise<void> {
  const [s] = await sql`select device, ip, created_at from sessions where token_hash = ${hashToken(token)}`;
  if (!s) return;
  await sql.begin(async (tx) => {
    await postService(tx, userId, { type: 'new_login', ...newLoginMessage(s.device || 'Браузер', s.ip, new Date(s.created_at)) });
    await changed(tx, userId);
  });
}
```

`hashToken` — экспортировать из `auth.ts` существующую функцию `hash` под этим именем.

- [ ] **Step 5: Message text**

В `apps/server/src/domain/service.ts`:

```ts
/** «Новый вход»: устройство, IP и время жирным, совет, что делать, если это не вы. */
export function newLoginMessage(device: string, ip: string | null, at: Date): { body: string; entities: Entity[] } {
  const when = at.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  const title = 'Новый вход в аккаунт';
  const body = `${title}\n\nУстройство: ${device}\nIP: ${ip ?? 'неизвестен'}\nВремя: ${when}\n\nЕсли это были не вы, откройте Настройки → Активные сеансы и завершите этот сеанс.`;
  return { body, entities: [{ type: 'bold', offset: 0, length: title.length }] };
}
```

- [ ] **Step 6: HTTP**

В `apps/server/src/http.ts`, рядом с `DELETE /sessions/:id`:

```ts
        const confirm = /^\/sessions\/(\d{1,15})\/confirm$/.exec(url.pathname);
        if (confirm && req.method === 'POST') return Response.json(await confirmSession(userId, sessionId, Number(confirm[1])));
```

В `/auth/signin` вернуть вызов `await announceLogin(userId, token);`.

- [ ] **Step 7: Run tests**

Run: `docker compose --profile test run --rm test`
Expected: PASS. Старые тесты сеансов, сравнивающие `SessionInfo` целиком, дополнить полем `unconfirmed: false`.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/index.ts apps/server/src apps/server/test/sessions.test.ts
git commit -m "feat(server): new-login notice, session confirmation, unconfirmed sessions cannot end others"
```

---

### Task 5: Движок — `sessionsChanged` и действие подтверждения

**Files:**
- Modify: `packages/sync-engine/src/store.ts`, `packages/sync-engine/src/engine.ts`
- Modify: `packages/sync-engine/src/types.ts` (действие `confirmSession`)
- Modify: `packages/sync-engine/src/sessions.ts` (или файл, где живут `terminateSession` / `listSessions`)
- Modify: `apps/web/src/data.ts`, `apps/web/src/settingsData.ts`, `apps/web/src/global.ts`
- Test: `packages/sync-engine/test/sessions.test.ts` (или текущий тест сеансов движка)

**Interfaces:**
- Consumes: `Update sessionsChanged`, `POST /sessions/:id/confirm` (Task 4).
- Produces:
  - `Status.sessionsRev: number`;
  - action `{ type: 'confirmSession'; id: number }`;
  - `confirmSession(id: number): Promise<unknown>` in `apps/web/src/settingsData.ts`.

- [ ] **Step 1: Write the failing test**

Найти тест, где движку отдают журнал с `blocksChanged` (`grep -rn blocksChanged packages/sync-engine/test`), и по тому же образцу:

```ts
test('sessionsChanged bumps sessionsRev in status', async () => {
  const before = engine.status().sessionsRev as number;
  await deliver([{ seq: next(), update: { type: 'sessionsChanged' } }]);   // тот же помощник, что у blocksChanged
  expect(engine.status().sessionsRev).toBe(before + 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose --profile test run --rm test-engine`
Expected: FAIL, `sessionsRev` is undefined.

- [ ] **Step 3: Store and status**

В `packages/sync-engine/src/store.ts` завести поле `sessionsRev = 0;` и в `switch` по типу обновления добавить ветку:

```ts
      case 'sessionsChanged': this.sessionsRev++; return;
```

В `engine.ts`, в `statusItem()`, добавить `sessionsRev: this.store.sessionsRev,`. Статус уходит в интерфейс через `pushStatus()` после применения журнала. Если после применения обновлений `changed()` не вызывается, вызвать его там же.

- [ ] **Step 4: Confirm action**

По образцу действия `terminateSession` (тот же файл, тот же HTTP-помощник и та же обработка офлайна) добавить действие `confirmSession`, которое делает `POST /sessions/${id}/confirm`. В `apps/web/src/settingsData.ts`:

```ts
export const confirmSession = (id: number): Promise<unknown> => call({ type: 'confirmSession', id });
```

- [ ] **Step 5: UI reloads sessions on change**

В `apps/web/src/global.ts`, в `Status`, добавить `sessionsRev?: number`. В `apps/web/src/data.ts`, в подписке на `status`:

```ts
let sessionsRev: number | undefined;
// внутри колбэка, после setGlobal({ status: s }):
if (s.sessionsRev !== sessionsRev) { const first = sessionsRev === undefined; sessionsRev = s.sessionsRev; if (!first) void loadSessions(true); }
```

Сразу после запуска данных один раз вызвать `loadSessions()`: плашке «Это вы?» нужен список с первого экрана, а не только после открытия настроек.

- [ ] **Step 6: Run tests**

Run: `docker compose --profile test run --rm test-engine && bunx tsc --noEmit -p apps/web`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/sync-engine apps/web/src/data.ts apps/web/src/settingsData.ts apps/web/src/global.ts
git commit -m "feat(engine): sessionsChanged from the journal reloads sessions; confirm-session action"
```

---

### Task 6: Экран входа по коду

**Files:**
- Modify: `apps/web/src/ui/Login.tsx`
- Modify: `apps/web/public/app.css`

**Interfaces:**
- Consumes: `POST /auth/code` → `{ attemptId, via, length, devCode? }`, `POST /auth/signin` → 200 or `{ code }` with 400/429 (Task 3).

- [ ] **Step 1: Two-step form**

```tsx
import { Button, Card } from '@relay/ui';
import { useState } from 'preact/hooks';

type Step = { kind: 'login' } | { kind: 'code'; attemptId: string; via: 'app' | 'none'; login: string; devCode?: string };

const ERR: Record<string, string> = {
  code_invalid: 'Неверный код.',
  code_expired: 'Код больше не действует. Запросите новый.',
  flood: 'Слишком много попыток. Попробуйте через час.',
};

/** Вход: телефон или @имя → код приходит в служебный чат Relay на устройство, где аккаунт уже открыт. */
export function Login() {
  const [step, setStep] = useState<Step>({ kind: 'login' });
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dev, setDev] = useState(false);

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async function submit(e: Event) {
    e.preventDefault();
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true); setError('');
    try {
      if (dev) {
        if (!(await post('/dev/login', { name: v })).ok) throw new Error('internal');
        location.reload(); return;
      }
      if (step.kind === 'login') {
        const res = await post('/auth/code', { login: v });
        const r = await res.json();
        if (!res.ok) throw new Error(r.code);
        setStep({ kind: 'code', login: v, ...r }); setValue('');
      } else {
        const res = await post('/auth/signin', { attemptId: step.attemptId, code: v });
        if (!res.ok) throw new Error((await res.json()).code);
        location.reload(); return;
      }
    } catch (err) {
      const code = (err as Error).message;
      setError(ERR[code] ?? 'Не удалось войти. Проверьте, что сервер запущен.');
      if (code === 'code_expired') { setStep({ kind: 'login' }); setValue(''); }
    }
    setBusy(false);
  }

  const codeStep = step.kind === 'code' && !dev;
  return (
    <div class="app-center rl-wallpaper" style={{ background: 'var(--canvas)' }}>
      <Card class="app-login">
        <form class="app-login" onSubmit={submit}>
          <h1>{codeStep ? 'Введите код' : 'Вход в Relay'}</h1>
          <p>
            {dev ? 'Режим разработки: введите имя, и сервер создаст пользователя.'
              : !codeStep ? 'Телефон в формате +7… или имя пользователя.'
              : step.via === 'app' ? 'Мы отправили код в служебный чат Relay на устройстве, где вы уже вошли.'
              : 'Аккаунт сейчас не открыт ни на одном устройстве — код доставить некуда.'}
          </p>
          {codeStep && step.devCode ? <p class="app-login-dev">Код (режим разработки): <b>{step.devCode}</b></p> : null}
          <label for="login-field" class="rl-sr">{codeStep ? 'Код' : dev ? 'Имя' : 'Телефон или имя пользователя'}</label>
          <input
            id="login-field" class="app-field" value={value} autocomplete={codeStep ? 'one-time-code' : 'username'}
            inputMode={codeStep ? 'numeric' : undefined} maxLength={codeStep ? 5 : 64}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            placeholder={codeStep ? '•••••' : dev ? 'Например, Анна' : '+7… или @anna'} autofocus
          />
          {error ? <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p> : null}
          <Button type="submit" size="lg" disabled={busy || !value.trim()}>{busy ? 'Проверяем…' : codeStep ? 'Войти' : dev ? 'Войти' : 'Получить код'}</Button>
          {codeStep ? <button type="button" class="app-link" onClick={() => { setStep({ kind: 'login' }); setError(''); }}>Другой аккаунт</button> : null}
          <button type="button" class="app-link" onClick={() => { setDev(!dev); setError(''); setValue(''); }}>{dev ? 'Вход по коду' : 'Вход по имени (разработка)'}</button>
        </form>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Styles**

В `apps/web/public/app.css`:

```css
.app-login .app-link { background: none; border: 0; color: var(--brand-text); font: inherit; cursor: pointer; padding: 4px; }
.app-login-dev { font: 400 13px/18px var(--font-sans); color: var(--ink-muted); }
```

- [ ] **Step 3: Verify in the browser**

`docker compose up -d --build server`. В Playwright, в двух изолированных контекстах:
1. Контекст A входит через dev-вход («Анна»), задаёт имя пользователя `anna` в профиле.
2. Контекст B вводит `@anna`. В A в списке чатов появляется «Relay» с непрочитанным.
3. B вводит неверный код — видит «Неверный код.». Затем вводит `devCode` — оказывается в приложении.

Проверить, что `window.__strictDom.report()` пуст и ошибок страницы нет.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/ui/Login.tsx apps/web/public/app.css
git commit -m "feat(web): sign in with a code from the Relay service chat; dev name login stays as an option"
```

---

### Task 7: Служебный чат в интерфейсе

**Files:**
- Modify: `apps/web/src/ui/Chat.tsx` (шапка, вместо композера — подпись)
- Modify: `apps/web/src/ui/Feed.tsx` (клик по коду копирует)
- Modify: `apps/web/src/ui/preview.tsx` (код скрыт в превью)
- Modify: `apps/web/src/notify.ts` (код скрыт в локальном уведомлении)
- Modify: `apps/web/src/ui/Info.tsx` (нет «Добавить в контакты», «Заблокировать»)
- Modify: `apps/web/public/app.css`

**Interfaces:**
- Consumes: `peer.system` in the chat list item; `last.service.type` / `message.service.type` (Task 2).
- Produces: `isSystemChat(chat: Item | undefined): boolean`; `hideCode(text: string): string` in `apps/web/src/ui/format.ts`.

- [ ] **Step 1: Helpers with a unit test**

В `apps/web/src/ui/format.ts`:

```ts
/** Личный чат с системным пользователем «Relay». */
export const isSystemChat = (chat: { peer?: unknown } | undefined): boolean => !!(chat?.peer as { system?: boolean } | null)?.system;

/** Код входа в превью и уведомлениях: цифры кода — точками. */
export const hideCode = (text: string): string => text.replace(/\d{5}/, '•••••');
```

В `apps/web/src/ui/format.test.ts`:

```ts
test('hideCode masks the first five-digit run only', () => {
  expect(hideCode('Код для входа в Relay: 48213\n\nНикому…')).toBe('Код для входа в Relay: •••••\n\nНикому…');
  expect(hideCode('без кода')).toBe('без кода');
});
```

Run: `cd apps/web && bun test format` — Expected: PASS.

- [ ] **Step 2: Header and footer**

В `Chat.tsx`:
- Если `isSystemChat(chat)`, подзаголовок шапки — «служебные уведомления» вместо статуса присутствия. Подписку на присутствие для такого собеседника не делать.
- Рядом с именем — галочка: `<Icon name="check" size={14} />` в круглом бейдже `.app-verified`.
- Вместо композера — плашка того же размера и места:

```tsx
{isSystemChat(chat)
  ? <div class="app-readonly-bar" role="note">Служебные уведомления Relay — ответить на них нельзя</div>
  : composer}
```

- В контекстном меню сообщения служебного чата оставить только «Копировать» и «Удалить у себя». Реакции, «Ответить» и «Изменить» скрыть.

В `apps/web/public/app.css`:

```css
.app-verified { display: inline-grid; place-items: center; width: 16px; height: 16px; margin-left: 4px; border-radius: 50%; background: var(--brand-strong); color: var(--bg); vertical-align: -2px; }
.app-readonly-bar { display: flex; align-items: center; justify-content: center; min-height: 56px; border-radius: var(--radius-panel); background: var(--glass); box-shadow: var(--shadow-panel); color: var(--ink-muted); font: 400 14px/20px var(--font-sans); }
```

- [ ] **Step 3: Copy the code on click**

В `Feed.tsx`, обработчик клика на контейнере ленты (делегирование, без слушателя на каждом пузыре):

```ts
const onFeedClick = (e: MouseEvent) => {
  const code = (e.target as HTMLElement).closest('.rl-bubble code:not([data-pre])');
  if (!code) return;
  void navigator.clipboard?.writeText(code.textContent ?? '');
  showToast('Код скопирован');   // существующий тост ленты; если его нет — Toast из @relay/ui
};
```

В CSS `.rl-bubble code { cursor: pointer; }`.

- [ ] **Step 4: Hide the code in previews and notifications**

В `preview.tsx`, в `previewBody`, когда у последнего сообщения `service?.type === 'login_code'`, текст сначала проходит через `hideCode`, а entities отбрасываются:

```ts
const text = m.service?.type === 'login_code' ? hideCode(m.body) : m.body;
const entities = m.service?.type === 'login_code' ? [] : m.entities;
```

В `notify.ts`, в `notifyIncoming`, принять `service?: { type: string }` и применить к телу тот же `hideCode`. В вызове из `data.ts` передавать `last.service`.

- [ ] **Step 5: Info panel**

В `Info.tsx`, для `isSystemChat(chat)`:
- скрыть «Добавить в контакты», «Заблокировать», телефон и username;
- подзаголовок — «служебные уведомления»;
- переключатель уведомлений оставить.

- [ ] **Step 6: Verify in the browser**

После входа по коду (Task 6) в контексте A:
- в строке «Relay» вместо кода — «•••••»;
- шапка — «служебные уведомления» с галочкой;
- поля ввода нет, есть плашка;
- клик по коду копирует его: проверить `await navigator.clipboard.readText()` в контексте с разрешением `clipboard-read`;
- реакций в меню нет.

Сделать покадровую выборку при открытии чата: плашка не мигает, переход плавный. Strict-DOM чистый.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src apps/web/public/app.css
git commit -m "feat(web): Relay service chat — verified header, read-only footer, tap-to-copy code, code hidden in previews and notifications"
```

---

### Task 8: Плашка «Это вы?» и пометка в «Активных сеансах»

**Files:**
- Modify: `apps/web/src/banners.ts`, `apps/web/src/banners.test.ts`
- Modify: `apps/web/src/ui/Sidebar.tsx` (отрисовка новой плашки)
- Modify: `apps/web/src/ui/settings/Sessions.tsx`

**Interfaces:**
- Consumes: `global.sessions: SessionInfo[] | null` with `unconfirmed` (Task 4/5), `confirmSession(id)` and `terminateSession(id)` from `settingsData.ts`.
- Produces: `Banner` variant `{ kind: 'unconfirmed'; session: SessionInfo }`; `BannerInput.sessions`.

- [ ] **Step 1: Write the failing test**

```ts
// добавить в apps/web/src/banners.test.ts
const s = (o: Partial<SessionInfo>): SessionInfo => ({ id: 1, device: 'Chrome, macOS', ip: '1.2.3.4', createdAt: '2026-10-18T10:00:00Z', lastActiveAt: '2026-10-18T10:00:00Z', current: false, online: true, unconfirmed: false, ...o });

test('unconfirmed login beats every other banner; not shown on the unconfirmed device itself', () => {
  const base = { notify: 'default' as const, dismissed: {}, me: null, contacts: [], today: new Date('2026-10-18') };
  const fresh = s({ id: 2, unconfirmed: true });
  expect(pickBanner({ ...base, sessions: [s({ id: 1, current: true }), fresh] })).toEqual({ kind: 'unconfirmed', session: fresh });
  expect(pickBanner({ ...base, sessions: [s({ id: 2, current: true, unconfirmed: true })] })).toEqual({ kind: 'notify' });
  expect(pickBanner({ ...base, sessions: null })).toEqual({ kind: 'notify' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test banners`
Expected: FAIL, the result is `{ kind: 'notify' }`.

- [ ] **Step 3: Banner logic**

В `banners.ts`:

```ts
import type { SessionInfo } from '@relay/protocol';

export type Banner =
  | { kind: 'unconfirmed'; session: SessionInfo }
  | { kind: 'notify' }
  | { kind: 'birthdays'; people: { userId: number; name: string }[] }
  | { kind: 'setBirthday' };
```

В `BannerInput` добавить поле `sessions?: SessionInfo[] | null;`. В начале `pickBanner`:

```ts
  // «Это вы?» важнее всего и не закрывается крестиком — только ответом.
  // На неподтверждённом устройстве её нет: оно само может быть чужим.
  const me = i.sessions?.find((x) => x.current);
  if (me && !me.unconfirmed) {
    const fresh = i.sessions!.find((x) => x.unconfirmed && !x.current);
    if (fresh) return { kind: 'unconfirmed', session: fresh };
  }
```

`dismiss` для `unconfirmed` не вызывается: у плашки нет крестика.

- [ ] **Step 4: Render**

В `Sidebar.tsx`, там же, где рисуются остальные плашки, передать `sessions: useGlobal((s) => s.sessions)` в `pickBanner` и отрисовать новый вид:

```tsx
{banner.kind === 'unconfirmed' ? (
  <div class="app-banner app-banner-alert" role="alert">
    <b>Кто-то вошёл в ваш аккаунт</b>
    <span>{banner.session.device}{banner.session.ip ? `, IP ${banner.session.ip}` : ''}. Это вы?</span>
    <div class="app-banner-actions">
      <Button size="sm" onClick={() => confirmSession(banner.session.id)}>Да, это я</Button>
      <Button size="sm" variant="danger" onClick={() => terminateSession(banner.session.id)}>Нет, завершить</Button>
    </div>
  </div>
) : null}
```

Классы `app-banner*` взять у существующих плашек. Если имена другие, использовать существующие и добавить только `.app-banner-alert { border-left: 3px solid var(--danger); }`. После ответа плашка уходит тем же исчезновением, что и остальные: список сеансов меняется сразу по ответу операции (`sessionsView`), без мигания.

- [ ] **Step 5: Sessions page**

В `Sessions.tsx`, у строки с `unconfirmed`:
- подпись «Новый вход — не подтверждён» цветом `var(--danger)`;
- в модалке деталей — кнопка «Это я» (`confirmSession`) рядом с «Завершить сеанс».

Если текущий сеанс сам `unconfirmed`, кнопки «Завершить» и «Завершить все другие» показать неактивными с подсказкой «Доступно после подтверждения входа на другом устройстве». Сервер всё равно ответит `fresh_session`, но интерфейс не должен предлагать то, что не сработает.

- [ ] **Step 6: Verify in the browser**

Те же два контекста:
1. В A после входа B сверху появляется «Кто-то вошёл в ваш аккаунт».
2. В B плашки нет; «Завершить все другие» неактивна.
3. «Да, это я» в A: плашка плавно уходит в A. В B кнопки завершения становятся активными, без перезагрузки — через `sessionsChanged`.
4. Повтор с новым входом и «Нет, завершить»: B получает `sessionTerminated` и уходит на экран входа.

Проверить покадрово, что плашка появляется и уходит без скачка списка. Strict-DOM чистый.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/banners.ts apps/web/src/banners.test.ts apps/web/src/ui/Sidebar.tsx apps/web/src/ui/settings/Sessions.tsx apps/web/public/app.css
git commit -m "feat(web): «Is it you?» banner for unconfirmed logins; confirm or end it; sessions page marks new logins"
```

---

## Чего не делаем

| Что | Почему |
|---|---|
| SMS, звонки, email-коды | Нет провайдера; доставка — только в служебный чат, `devCode` в режиме разработки |
| `popup`-уведомления без записи в историю | Пока нечего показывать; появится вместе с ограничениями вида «подождите 24 часа» |
| Принудительный выход по команде сервера | Уже есть: `sessionTerminated` + закрытие сокета 4001 |
| Двухэтапная проверка (пароль) | Отдельная задача; после неё — служебные «пароль изменён» и «вход без пароля» |
| Геолокация по IP | Нужна база GeoIP; пока показываем IP |
| Склейка повторов по `type` за 15 минут | Код входа приходит не чаще 5 раз в час; вернуться, если служебных типов станет больше |

## Приёмка

- Вход по `@имя` или `+телефону` работает. Код приходит в «Relay» на открытых устройствах, одноразовый, живёт 5 минут, даёт 5 попыток, сгорает, если его отправить в любой чат.
- В списке чатов, в уведомлениях и в Web Push кода не видно. В чате он моноширинный, клик копирует.
- В служебный чат нельзя писать и реагировать: сервер отвечает `forbidden`, поля ввода нет.
- После входа по коду на других устройствах появляются сообщение «Новый вход» и плашка «Это вы?». «Да» подтверждает сеанс, «Нет» завершает его.
- Неподтверждённый сеанс не может завершать другие (`fresh_session`). Через 7 дней сеанс подтверждается сам.
- Все тесты сервера и движка проходят, `tsc` чистый, strict-DOM чистый, переходы проверены покадрово.
