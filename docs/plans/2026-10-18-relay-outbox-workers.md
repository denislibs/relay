# Outbox и воркеры (этап 1 бэкенда) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** побочные эффекты сервера (Web Push, письмо восстановления пароля, чистка сеансов) выполняются из транзакционной очереди задач в Postgres отдельным процессом-воркером, с повторами и без потерь при падении.

**Architecture:** задача (`jobs`) пишется в той же транзакции, что и изменение данных (transactional outbox), и после коммита будит воркеры через `pg_notify('jobs')`. Воркер забирает задачи пачкой через `for update skip locked` с арендой (`locked_until`), выполняет обработчик вне транзакции, удаляет задачу при успехе или откладывает с нарастающей паузой; после лимита попыток задача уходит в `jobs_dead`. Доставка «как минимум один раз»: обработчики идемпотентны или терпят повтор. Проверка «пользователь онлайн» для push переезжает из памяти процесса сервера в таблицу `live_conns`, иначе воркер её не видит.

**Tech Stack:** Bun 1.4, TypeScript, postgres.js 3.4.9, PostgreSQL 17, Docker Compose, `bun test`.

## Global Constraints

- Postgres — единственное хранилище: никаких Kafka, RabbitMQ, Redis/Valkey в этом этапе.
- Без новых npm-зависимостей.
- Без кода из telegram-tt и tweb (GPL): только своя реализация.
- Тесты запускаются только в Docker: `docker compose --profile test run --rm test` (сервер) и `docker compose --profile test run --rm test-engine` (движок).
- Комментарии в коде — по-русски, как во всём `apps/server`.
- Номер миграции: на master последняя `112_folders.sql`, ветка `feat/s3-storage` (MinIO) уже заняла `113_s3_uploads.sql`. Этот план берёт **`114_jobs.sql`**; если к началу работы номер занят — следующий свободный, а в тексте плана заменить везде.
- Секреты в payload задачи кладутся только под ключ `secret`; в `jobs_dead` он не копируется.
- Работать в своей ветке (`feat/outbox-workers`), в master сливать только по слову пользователя.

## Что сейчас и что меняется

| Эффект | Сейчас | После |
|---|---|---|
| Push нового сообщения | `pushInBackground()` после коммита (`domain/messages.ts:56`), в памяти, без повторов; падение процесса — push потерян | задача `push.message` в транзакции отправки → по задаче `push.deliver` на каждую подписку, с повторами |
| Push служебного сообщения | `pushService()` после коммита (`login.ts:84`, `sessions.ts:174`) | `postService` сам ставит `push.message` в своей транзакции |
| «Онлайн» для push | `isOnline()` — счётчик в памяти процесса (`presence.ts`) | `onlineUsers()` — таблица `live_conns`, видна любому процессу |
| Письмо восстановления | `deliver()` в памяти (`devOutbox.ts`), `/dev/codes` читает массив | задача `mail.recovery`; dev-почта — таблица `dev_mail` |
| Чистка сеансов | `setInterval` в `main.ts` | периодическая задача `sessions.sweep` раз в час |

Остаются как есть: `sweepInactive(userId)` при входе (`auth.ts:19`) и при смене срока (`http.ts:146`) — это часть запроса, а не фон.

## File Structure

| Файл | Ответственность |
|---|---|
| `apps/server/migrations/114_jobs.sql` | таблицы `jobs`, `jobs_dead`, `live_conns`, `dev_mail` |
| `apps/server/src/jobs/queue.ts` | `enqueue`, `ensurePeriodic`, `claim`, `complete`, `fail`, `backoffMs` — только SQL очереди |
| `apps/server/src/jobs/handlers.ts` | реестр обработчиков по `kind`, `PermanentError` |
| `apps/server/src/jobs/worker.ts` | `runJob`, `drainJobs` (тесты), `startWorker` (цикл с LISTEN) |
| `apps/server/src/worker.ts` | точка входа процесса-воркера |
| `apps/server/src/domain/liveRegistry.ts` | `markOnline`, `markOffline`, `heartbeat`, `onlineUsers`, `PROCESS_ID` |
| `apps/server/src/domain/presence.ts` | вызывает реестр на переходах 0↔1 соединений |
| `apps/server/src/realtime.ts` | ежеминутный `heartbeat()` рядом с `touchLive()` |
| `apps/server/src/domain/push.ts` | `planPush`, `deliverPush`, обработчики `push.message`/`push.deliver`; убрать `pushInBackground`/`settlePushes` |
| `apps/server/src/domain/messages.ts`, `service.ts`, `login.ts`, `sessions.ts` | ставят `push.message` в своих транзакциях |
| `apps/server/src/domain/devOutbox.ts` | dev-почта в таблице `dev_mail` (функции становятся async) |
| `apps/server/src/domain/password.ts` | `startRecovery` ставит `mail.recovery` в транзакции |
| `apps/server/src/authRoutes.ts` | `/dev/codes` ждёт `devOutbox()` |
| `apps/server/src/main.ts` | убрать `setInterval` чистки |
| `docker-compose.yml` | сервис `worker` |
| `apps/server/test/helpers.ts` | `resetDb` чистит новые таблицы, без `settlePushes` |
| `apps/server/test/jobs.test.ts` | очередь и воркер |
| `apps/server/test/liveRegistry.test.ts` | реестр онлайна |
| `apps/server/test/push.test.ts`, `auth.test.ts`, `sessions.test.ts` | перевод на `drainJobs()` и новые сценарии |

---

### Task 1: Таблицы и очередь задач

**Files:**
- Create: `apps/server/migrations/114_jobs.sql`
- Create: `apps/server/src/jobs/queue.ts`
- Modify: `apps/server/test/helpers.ts` (функция `resetDb`)
- Test: `apps/server/test/jobs.test.ts`

**Interfaces:**
- Produces:
  - `type Db = Tx | typeof sql`
  - `interface Job { id: number; kind: string; payload: Record<string, unknown>; attempts: number; maxAttempts: number }`
  - `enqueue(db: Db, kind: string, payload: object, opts?: { runAt?: Date; dedupeKey?: string; maxAttempts?: number }): Promise<void>`
  - `ensurePeriodic(kind: string): Promise<void>` — одна задача с `dedupe_key = kind`, если её ещё нет
  - `claim(limit: number, leaseSec?: number): Promise<Job[]>`
  - `complete(job: Job, again?: { inSec: number }): Promise<void>` — удалить, или (периодическая) перенести на `inSec` вперёд со сбросом попыток
  - `fail(job: Job, err: unknown, opts?: { retry: boolean }): Promise<void>`
  - `backoffMs(attempts: number): number`

- [ ] **Step 1: Миграция**

`apps/server/migrations/114_jobs.sql`:

```sql
-- Очередь задач (transactional outbox): задача пишется в транзакции изменения, воркер забирает её после коммита.
create table if not exists jobs (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null default '{}',
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 8,
  locked_until timestamptz,          -- аренда воркера; истекла — задачу может забрать другой
  last_error text,
  dedupe_key text,                   -- периодические задачи: не больше одной на ключ
  created_at timestamptz not null default now()
);
create index if not exists jobs_due on jobs (run_at, id);
create unique index if not exists jobs_dedupe on jobs (dedupe_key) where dedupe_key is not null;

-- Задачи, исчерпавшие попытки или с постоянной ошибкой. Секрет из payload сюда не копируется.
create table if not exists jobs_dead (
  id bigint primary key,
  kind text not null,
  payload jsonb not null,
  attempts int not null,
  last_error text,
  created_at timestamptz not null,
  failed_at timestamptz not null default now()
);

-- Кто онлайн, для всех процессов: строка на (процесс, пользователь). Протухшие строки упавших процессов
-- отсекаются по seen_at, закрытые — по left_at с паузой RELAY_PRESENCE_GRACE_MS.
create table if not exists live_conns (
  process_id uuid not null,
  user_id bigint not null references users(id) on delete cascade,
  conns int not null,
  left_at timestamptz,
  seen_at timestamptz not null default now(),
  primary key (process_id, user_id)
);
create index if not exists live_conns_user on live_conns (user_id);

-- Dev-почта (DEV_LOGIN=1): письма, которые в проде ушли бы через почтовый шлюз. Читает /dev/codes.
create table if not exists dev_mail (
  id bigserial primary key,
  at timestamptz not null default now(),
  to_addr text not null,
  kind text not null,
  code text not null
);
```

- [ ] **Step 2: Тесты очереди**

`apps/server/test/jobs.test.ts`:

```ts
import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { backoffMs, claim, complete, enqueue, ensurePeriodic, fail } from '../src/jobs/queue';
import { resetDb } from './helpers';

beforeEach(resetDb);

const count = async (table: 'jobs' | 'jobs_dead') => (await sql`select count(*)::int as n from ${sql(table)}`)[0].n as number;

test('a job enqueued in a rolled-back transaction never exists', async () => {
  await sql.begin(async (tx) => {
    await enqueue(tx, 'test.noop', { a: 1 });
    throw new Error('rollback');
  }).catch(() => {});
  expect(await count('jobs')).toBe(0);
  await sql.begin((tx) => enqueue(tx, 'test.noop', { a: 2 }));
  expect(await count('jobs')).toBe(1);
});

test('claim leases a job: a second claim does not get it until the lease expires', async () => {
  await enqueue(sql, 'test.noop', {});
  const [job] = await claim(10, 1);
  expect(job).toMatchObject({ kind: 'test.noop', attempts: 1 });
  expect(await claim(10, 1)).toEqual([]);
  await Bun.sleep(1100);
  const [again] = await claim(10, 1);
  expect(again).toMatchObject({ id: job.id, attempts: 2 });
});

test('future run_at is not claimed', async () => {
  await enqueue(sql, 'test.noop', {}, { runAt: new Date(Date.now() + 60_000) });
  expect(await claim(10)).toEqual([]);
});

test('complete deletes; a stale worker (lease taken over) cannot complete', async () => {
  await enqueue(sql, 'test.noop', {});
  const [first] = await claim(10, 1);
  await Bun.sleep(1100);
  const [second] = await claim(10, 60);
  await complete(first);                 // попытка уже не его — ничего не удалит
  expect(await count('jobs')).toBe(1);
  await complete(second);
  expect(await count('jobs')).toBe(0);
});

test('fail reschedules with backoff, then moves to jobs_dead without the secret', async () => {
  await enqueue(sql, 'test.noop', { to: 'x', secret: { code: '123456' } }, { maxAttempts: 2 });
  const [j1] = await claim(10);
  await fail(j1, new Error('boom'));
  const [row] = await sql`select run_at > now() as later, locked_until, last_error from jobs`;
  expect(row).toMatchObject({ later: true, locked_until: null, last_error: 'boom' });
  await sql`update jobs set run_at = now()`;
  const [j2] = await claim(10);
  await fail(j2, new Error('boom again'));
  expect(await count('jobs')).toBe(0);
  const [dead] = await sql`select kind, payload, attempts, last_error from jobs_dead`;
  expect(dead).toMatchObject({ kind: 'test.noop', payload: { to: 'x' }, attempts: 2, last_error: 'boom again' });
});

test('fail without retry goes straight to jobs_dead', async () => {
  await enqueue(sql, 'test.noop', {});
  const [j] = await claim(10);
  await fail(j, new Error('bad request'), { retry: false });
  expect(await count('jobs')).toBe(0);
  expect(await count('jobs_dead')).toBe(1);
});

test('periodic: ensurePeriodic keeps one job; complete with again reschedules and resets attempts', async () => {
  await ensurePeriodic('test.tick');
  await ensurePeriodic('test.tick');
  expect(await count('jobs')).toBe(1);
  const [j] = await claim(10);
  await complete(j, { inSec: 3600 });
  const [row] = await sql`select attempts, locked_until, run_at > now() + interval '59 minutes' as later from jobs`;
  expect(row).toEqual({ attempts: 0, locked_until: null, later: true });
});

test('backoff grows and is capped at 10 minutes', () => {
  expect(backoffMs(1)).toBeLessThan(1300);
  expect(backoffMs(5)).toBeGreaterThan(12_000);
  expect(backoffMs(30)).toBeLessThanOrEqual(720_000);
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `docker compose --profile test run --rm test bun test jobs`
Expected: FAIL — `Cannot find module '../src/jobs/queue'`.

- [ ] **Step 4: Реализация очереди**

`apps/server/src/jobs/queue.ts`:

```ts
import { sql, type Tx } from '../db';

/**
 * Очередь задач в Postgres (transactional outbox). Задача ставится в транзакции изменения данных;
 * pg_notify('jobs') уходит только после коммита и будит воркеры. Доставка «как минимум один раз»:
 * обработчик может выполниться повторно (истекла аренда, процесс упал до complete).
 */
export type Db = Tx | typeof sql;
export interface Job { id: number; kind: string; payload: Record<string, unknown>; attempts: number; maxAttempts: number }

export const LEASE_SEC = 300;
const BACKOFF_CAP_MS = 600_000;

export async function enqueue(db: Db, kind: string, payload: object, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}): Promise<void> {
  await db`
    insert into jobs (kind, payload, run_at, dedupe_key, max_attempts)
    values (${kind}, ${db.json(payload as never)}, coalesce(${opts.runAt ?? null}::timestamptz, now()), ${opts.dedupeKey ?? null}, ${opts.maxAttempts ?? 8})
    on conflict (dedupe_key) where dedupe_key is not null do nothing`;
  await db`select pg_notify('jobs', ${kind})`;
}

/** Периодическая задача: ровно одна строка на kind; после выполнения обработчик переносит её вперёд (complete с again). */
export function ensurePeriodic(kind: string): Promise<void> {
  return enqueue(sql, kind, {}, { dedupeKey: kind });
}

/** Забрать до limit готовых задач: аренда на leaseSec, attempts + 1. Параллельные воркеры не берут одно и то же. */
export async function claim(limit: number, leaseSec = LEASE_SEC): Promise<Job[]> {
  const rows = await sql`
    with next as (
      select id from jobs
       where run_at <= now() and (locked_until is null or locked_until < now())
       order by run_at, id
       limit ${limit}
       for update skip locked)
    update jobs j set locked_until = now() + make_interval(secs => ${leaseSec}), attempts = j.attempts + 1
      from next where j.id = next.id
    returning j.id, j.kind, j.payload, j.attempts, j.max_attempts`;
  return rows.map((r) => ({ id: Number(r.id), kind: r.kind as string, payload: r.payload as Record<string, unknown>, attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts) }));
}

/** Готово: удалить (или перенести периодическую). Условие на attempts — аренду мог перехватить другой воркер. */
export async function complete(job: Job, again?: { inSec: number }): Promise<void> {
  if (again) {
    await sql`update jobs set run_at = now() + make_interval(secs => ${again.inSec}), attempts = 0, locked_until = null, last_error = null
              where id = ${job.id} and attempts = ${job.attempts}`;
    return;
  }
  await sql`delete from jobs where id = ${job.id} and attempts = ${job.attempts}`;
}

/** Пауза перед попыткой N+1: 1 с, 2 с, 4 с… не больше 10 минут, ±20 % чтобы повторы не шли стаей. */
export function backoffMs(attempts: number): number {
  const base = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** Ошибка обработчика: повтор позже, а без повтора или после лимита — в jobs_dead (без payload.secret). */
export async function fail(job: Job, err: unknown, opts: { retry: boolean } = { retry: true }): Promise<void> {
  const message = String(err instanceof Error ? err.message : err).slice(0, 2000);
  if (opts.retry && job.attempts < job.maxAttempts) {
    await sql`update jobs set run_at = now() + make_interval(secs => ${backoffMs(job.attempts) / 1000}), locked_until = null, last_error = ${message}
              where id = ${job.id} and attempts = ${job.attempts}`;
    return;
  }
  await sql.begin(async (tx) => {
    const moved = await tx`
      insert into jobs_dead (id, kind, payload, attempts, last_error, created_at)
      select id, kind, payload - 'secret', attempts, ${message}, created_at from jobs where id = ${job.id} and attempts = ${job.attempts}
      on conflict (id) do nothing
      returning id`;
    if (moved.length) await tx`delete from jobs where id = ${job.id}`;
  });
}
```

- [ ] **Step 5: Чистка новых таблиц в тестах**

В `apps/server/test/helpers.ts`, в `resetDb`, добавить новые таблицы в `truncate` (строку `settlePushes` пока не трогать — её уберёт Task 4):

```ts
  await sql`truncate login_attempts, login_pending, srp_challenges, qr_logins, webauthn_challenges, sessions, chats, chat_members, messages, user_seq, updates,
                     jobs, jobs_dead, live_conns, dev_mail restart identity cascade`;
```

- [ ] **Step 6: Тесты проходят**

Run: `docker compose --profile test run --rm test bun test jobs`
Expected: PASS, 8 тестов.

- [ ] **Step 7: Весь набор сервера не сломан**

Run: `docker compose --profile test run --rm test`
Expected: 0 fail.

- [ ] **Step 8: Commit**

```bash
git add apps/server/migrations/114_jobs.sql apps/server/src/jobs/queue.ts apps/server/test/jobs.test.ts apps/server/test/helpers.ts
git commit -m "feat(server): transactional job queue in Postgres — enqueue in tx, skip-locked claim with lease, backoff, dead letters"
```

---

### Task 2: Воркер: обработчики, цикл, отдельный процесс

**Files:**
- Create: `apps/server/src/jobs/handlers.ts`
- Create: `apps/server/src/jobs/worker.ts`
- Create: `apps/server/src/worker.ts`
- Modify: `docker-compose.yml` (новый сервис `worker`)
- Test: `apps/server/test/jobs.test.ts` (дописать)

**Interfaces:**
- Consumes: `claim`, `complete`, `fail`, `enqueue`, `Job` из Task 1.
- Produces:
  - `class PermanentError extends Error` — обработчик бросает её, когда повтор бессмыслен
  - `type HandlerResult = void | { again: { inSec: number } }`
  - `type Handler = (payload: any, job: Job) => Promise<HandlerResult>`
  - `handlers: Record<string, Handler>` и `register(kind: string, h: Handler): void`
  - `runJob(job: Job): Promise<void>`
  - `drainJobs(maxRounds?: number): Promise<number>` — для тестов: выполнить всё готовое, включая задачи, поставленные обработчиками
  - `startWorker(opts?: { concurrency?: number; pollMs?: number }): { stop(): Promise<void> }`

- [ ] **Step 1: Тесты воркера**

Дописать в `apps/server/test/jobs.test.ts`:

```ts
import { PermanentError, register } from '../src/jobs/handlers';
import { drainJobs, startWorker } from '../src/jobs/worker';

test('drainJobs runs handlers, including jobs they enqueue', async () => {
  const seen: number[] = [];
  register('test.chain', async (p: { n: number }) => {
    seen.push(p.n);
    if (p.n < 3) await enqueue(sql, 'test.chain', { n: p.n + 1 });
  });
  await enqueue(sql, 'test.chain', { n: 1 });
  expect(await drainJobs()).toBe(3);
  expect(seen).toEqual([1, 2, 3]);
  expect(await count('jobs')).toBe(0);
});

test('a throwing handler is retried later; PermanentError and unknown kinds are dead at once', async () => {
  let calls = 0;
  register('test.flaky', async () => { calls++; if (calls === 1) throw new Error('503'); });
  register('test.bad', async () => { throw new PermanentError('400'); });
  await enqueue(sql, 'test.flaky', {});
  await enqueue(sql, 'test.bad', {});
  await enqueue(sql, 'test.nobody', {});
  await drainJobs();
  expect(calls).toBe(1);
  expect((await sql`select kind from jobs_dead order by kind`).map((r) => r.kind)).toEqual(['test.bad', 'test.nobody']);
  await sql`update jobs set run_at = now()`;
  await drainJobs();
  expect(calls).toBe(2);
  expect(await count('jobs')).toBe(0);
});

test('a handler returning again reschedules a periodic job', async () => {
  register('test.tick', async () => ({ again: { inSec: 3600 } }));
  await ensurePeriodic('test.tick');
  await drainJobs();
  expect(await count('jobs')).toBe(1);
});

test('two workers take every job exactly once and wake on NOTIFY', async () => {
  const done: number[] = [];
  register('test.count', async (p: { i: number }) => { await Bun.sleep(5); done.push(p.i); });
  const w1 = startWorker({ concurrency: 5, pollMs: 60_000 });
  const w2 = startWorker({ concurrency: 5, pollMs: 60_000 });
  await Bun.sleep(100);                                  // оба успели подписаться на LISTEN
  await sql.begin(async (tx) => { for (let i = 0; i < 40; i++) await enqueue(tx, 'test.count', { i }); });
  for (let t = 0; t < 100 && done.length < 40; t++) await Bun.sleep(20);
  await Promise.all([w1.stop(), w2.stop()]);
  expect(done.length).toBe(40);
  expect(new Set(done).size).toBe(40);
});
```

(Импорты `PermanentError`, `register`, `drainJobs`, `startWorker` — в шапку файла к остальным; `ensurePeriodic` уже импортирован.)

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `docker compose --profile test run --rm test bun test jobs`
Expected: FAIL — `Cannot find module '../src/jobs/handlers'`.

- [ ] **Step 3: Реестр обработчиков**

`apps/server/src/jobs/handlers.ts`:

```ts
import type { Job } from './queue';

/** Повтор бессмыслен (неверный запрос, адресат отвечает 4xx): задача сразу уходит в jobs_dead. */
export class PermanentError extends Error {}

/** again — периодическая задача: перенести на inSec вперёд вместо удаления. */
export type HandlerResult = void | { again: { inSec: number } };
// payload — JSON из базы; каждый обработчик сам знает свою форму
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (payload: any, job: Job) => Promise<HandlerResult>;

/** Обработчики по kind. Доменные модули регистрируются в jobs/kinds.ts (Task 4–6), тесты — через register. */
export const handlers: Record<string, Handler> = {};

export function register(kind: string, h: Handler): void {
  handlers[kind] = h;
}
```

- [ ] **Step 4: Цикл воркера**

`apps/server/src/jobs/worker.ts`:

```ts
import { sql } from '../db';
import { handlers, PermanentError } from './handlers';
import { claim, complete, fail, type Job } from './queue';

/** Выполнить одну задачу: успех — complete, ошибка — fail (PermanentError и неизвестный kind — без повтора). */
export async function runJob(job: Job): Promise<void> {
  const h = handlers[job.kind];
  if (!h) { await fail(job, new Error(`no handler for ${job.kind}`), { retry: false }); return; }
  try {
    const res = await h(job.payload, job);
    await complete(job, res ? res.again : undefined);
  } catch (e) {
    await fail(job, e, { retry: !(e instanceof PermanentError) });
  }
}

/** Тесты и скрипты: выполнять готовые задачи, пока они есть (обработчики могут ставить новые). Возвращает число выполненных. */
export async function drainJobs(maxRounds = 50): Promise<number> {
  let n = 0;
  for (let i = 0; i < maxRounds; i++) {
    const jobs = await claim(50);
    if (!jobs.length) break;
    await Promise.all(jobs.map(runJob));
    n += jobs.length;
  }
  return n;
}

/**
 * Цикл процесса-воркера: забирает пачку, выполняет, повторяет; пусто — спит до NOTIFY jobs или pollMs
 * (poll нужен для отложенных задач: повторов и периодических, о них NOTIFY не приходит).
 */
export function startWorker(opts: { concurrency?: number; pollMs?: number } = {}): { stop(): Promise<void> } {
  const concurrency = opts.concurrency ?? 10;
  const pollMs = opts.pollMs ?? 5000;
  let stopped = false;
  let poked = false;                 // NOTIFY пришёл, пока воркер был занят: не засыпать
  let wake: (() => void) | null = null;
  const nap = () => new Promise<void>((resolve) => {
    if (poked || stopped) { resolve(); return; }
    const t = setTimeout(() => { wake = null; resolve(); }, pollMs);
    wake = () => { clearTimeout(t); wake = null; resolve(); };
  });
  const listening = sql.listen('jobs', () => { poked = true; wake?.(); });
  const loop = (async () => {
    await listening;
    while (!stopped) {
      poked = false;
      const jobs = await claim(concurrency).catch((e) => { console.error('jobs claim:', e); return [] as Job[]; });
      if (jobs.length) { await Promise.all(jobs.map(runJob)); continue; }
      await nap();
    }
  })();
  return {
    async stop() {
      stopped = true;
      wake?.();
      await loop;                                  // текущая пачка доделывается
      await (await listening).unlisten();
    },
  };
}
```

- [ ] **Step 5: Точка входа процесса**

`apps/server/src/worker.ts`:

```ts
import { sql } from './db';
import './jobs/kinds';
import { startWorker } from './jobs/worker';

// Процесс-воркер: выполняет задачи из jobs. Можно запускать несколько — skip locked делит работу.
const worker = startWorker({ concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10) });
console.log('relay worker started');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    await worker.stop();
    await sql.end();
    process.exit(0);
  });
}
```

И пустой пока реестр доменных задач `apps/server/src/jobs/kinds.ts` (его наполнят Task 4–6):

```ts
// Регистрация доменных обработчиков задач. Импортируется процессом-воркером и тестами.
export {};
```

- [ ] **Step 6: Сервис в docker-compose**

В `docker-compose.yml` после сервиса `server` добавить:

```yaml
  worker:
    build: { context: ., dockerfile: apps/server/Dockerfile }
    command: ["bun", "--watch", "apps/server/src/worker.ts"]
    environment:
      DATABASE_URL: postgres://relay:relay@postgres:5432/relay
      DEV_LOGIN: "1"
    volumes:
      - ./apps:/app/apps
      - ./packages:/app/packages
    depends_on:
      migrate: { condition: service_completed_successfully }
```

- [ ] **Step 7: Тесты проходят**

Run: `docker compose --profile test run --rm test bun test jobs`
Expected: PASS, 12 тестов.

- [ ] **Step 8: Процесс поднимается**

Run: `docker compose up -d --build worker && sleep 3 && docker compose logs worker --tail 5`
Expected: строка `relay worker started`, без ошибок.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/jobs apps/server/src/worker.ts apps/server/test/jobs.test.ts docker-compose.yml
git commit -m "feat(server): worker process — handler registry, LISTEN-woken loop, drainJobs for tests"
```

---

### Task 3: Реестр «кто онлайн» для всех процессов

**Зачем:** push уходит только тем, у кого нет живого соединения. Сейчас это `isOnline()` — счётчик в памяти процесса сервера; воркер в другом процессе его не видит и слал бы push всем подряд.

**Files:**
- Create: `apps/server/src/domain/liveRegistry.ts`
- Modify: `apps/server/src/domain/presence.ts` (`connected`, `disconnected`, `resetPresence`)
- Modify: `apps/server/src/realtime.ts` (ежеминутный таймер)
- Test: `apps/server/test/liveRegistry.test.ts`

**Interfaces:**
- Consumes: таблица `live_conns` из Task 1.
- Produces:
  - `PROCESS_ID: string` — uuid этого процесса
  - `markOnline(userId: number, conns: number): Promise<void>`
  - `markOffline(userId: number): Promise<void>`
  - `heartbeat(): Promise<void>`
  - `onlineUsers(userIds: number[]): Promise<Set<number>>`

- [ ] **Step 1: Тесты реестра**

`apps/server/test/liveRegistry.test.ts`:

```ts
import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { heartbeat, markOffline, markOnline, onlineUsers } from '../src/domain/liveRegistry';
import { makeUser, resetDb } from './helpers';

process.env.RELAY_PRESENCE_GRACE_MS = '300';
beforeEach(resetDb);

test('online while connected, still online during the grace pause, offline after it', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  await markOnline(a, 1);
  expect(await onlineUsers([a, b])).toEqual(new Set([a]));
  await markOffline(a);
  expect(await onlineUsers([a])).toEqual(new Set([a]));     // перезагрузка вкладки — не «ушёл»
  await Bun.sleep(400);
  expect(await onlineUsers([a])).toEqual(new Set());
});

test('another process counts too; a crashed process expires by seen_at', async () => {
  const a = await makeUser('Анна');
  await sql`insert into live_conns (process_id, user_id, conns, seen_at) values (${crypto.randomUUID()}, ${a}, 1, now())`;
  expect(await onlineUsers([a])).toEqual(new Set([a]));
  await sql`update live_conns set seen_at = now() - interval '4 minutes'`;
  expect(await onlineUsers([a])).toEqual(new Set());
});

test('heartbeat refreshes own rows and removes stale ones', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  await markOnline(a, 1);
  await sql`update live_conns set seen_at = now() - interval '2 minutes'`;
  await sql`insert into live_conns (process_id, user_id, conns, seen_at) values (${crypto.randomUUID()}, ${b}, 1, now() - interval '10 minutes')`;
  await heartbeat();
  expect(await onlineUsers([a, b])).toEqual(new Set([a]));
  expect((await sql`select count(*)::int as n from live_conns`)[0].n).toBe(1);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `docker compose --profile test run --rm test bun test liveRegistry`
Expected: FAIL — `Cannot find module '../src/domain/liveRegistry'`.

- [ ] **Step 3: Реализация реестра**

`apps/server/src/domain/liveRegistry.ts`:

```ts
import { sql } from '../db';

/**
 * Кто онлайн — для любого процесса (воркер решает, слать ли push). Строка на (процесс, пользователь);
 * пишется только на переходах 0↔1 соединений, не на каждый сокет. Упавший процесс: его строки
 * отсекаются по seen_at (heartbeat раз в минуту). Закрытие: left_at + пауза — перезагрузка вкладки не «уход».
 */
export const PROCESS_ID = crypto.randomUUID();
// строка без heartbeat дольше 3 минут — процесс упал
const graceSec = () => Number(process.env.RELAY_PRESENCE_GRACE_MS ?? 4000) / 1000;

export async function markOnline(userId: number, conns: number): Promise<void> {
  await sql`
    insert into live_conns (process_id, user_id, conns, left_at, seen_at) values (${PROCESS_ID}, ${userId}, ${conns}, null, now())
    on conflict (process_id, user_id) do update set conns = excluded.conns, left_at = null, seen_at = now()`;
}

export async function markOffline(userId: number): Promise<void> {
  await sql`update live_conns set conns = 0, left_at = now(), seen_at = now() where process_id = ${PROCESS_ID} and user_id = ${userId}`;
}

/** Раз в минуту (realtime.ts): свои строки живы; чужие протухшие и давно закрытые — удалить. */
export async function heartbeat(): Promise<void> {
  await sql`update live_conns set seen_at = now() where process_id = ${PROCESS_ID}`;
  await sql`delete from live_conns where seen_at < now() - interval '3 minutes' or (conns = 0 and left_at < now() - interval '1 minute')`;
}

export async function onlineUsers(userIds: number[]): Promise<Set<number>> {
  if (!userIds.length) return new Set();
  const rows = await sql`
    select distinct user_id from live_conns
     where user_id = any(${userIds}::bigint[])
       and seen_at > now() - interval '3 minutes'
       and (conns > 0 or left_at > now() - make_interval(secs => ${graceSec()}))`;
  return new Set(rows.map((r) => Number(r.user_id)));
}
```

- [ ] **Step 4: Presence пишет в реестр**

В `apps/server/src/domain/presence.ts` добавить импорт и вызовы. `connected` — запись до раннего `return` (иначе вернувшийся в паузе останется `conns = 0`):

```ts
import { markOffline, markOnline } from './liveRegistry';
```

```ts
export async function connected(publish: Publish, userId: number): Promise<void> {
  const n = (conns.get(userId) ?? 0) + 1;
  conns.set(userId, n);
  if (n === 1) await markOnline(userId, n).catch((e) => console.error('live registry:', e));
  const pending = leaving.get(userId);
  if (pending) { clearTimeout(pending); leaving.delete(userId); return; } // вернулся до конца паузы — для собеседников он и не уходил
  if (n === 1) await announce(publish, { userId, online: true, lastSeen: null });
}

export function disconnected(publish: Publish, userId: number): void {
  const n = Math.max(0, (conns.get(userId) ?? 0) - 1);
  if (n > 0) { conns.set(userId, n); return; }
  conns.delete(userId);
  markOffline(userId).catch((e) => console.error('live registry:', e));   // пауза — в onlineUsers по left_at
  leaving.set(userId, setTimeout(async () => {
    leaving.delete(userId);
    if ((conns.get(userId) ?? 0) > 0) return;
    const [row] = await sql`update users set last_seen_at = now() where id = ${userId} returning last_seen_at`;
    await announce(publish, { userId, online: false, lastSeen: row ? iso(row.last_seen_at) : null });
  }, graceMs()));
}
```

Комментарий в шапке `presence.ts` («Один процесс сервера; для нескольких понадобится общий реестр…») заменить на: «Счётчик в памяти — для рассылки собеседникам из этого процесса; общий для процессов вид “кто онлайн” — liveRegistry.ts».

- [ ] **Step 5: Heartbeat в realtime**

В `apps/server/src/realtime.ts` импортировать `heartbeat` и вызывать в том же ежеминутном таймере:

```ts
import { heartbeat } from './domain/liveRegistry';
```

```ts
  const timer = setInterval(() => {
    touchLive().catch((e) => console.error('sessions touch:', e));
    heartbeat().catch((e) => console.error('live registry:', e));
  }, 60_000);
```

- [ ] **Step 6: Тесты проходят**

Run: `docker compose --profile test run --rm test bun test liveRegistry presence`
Expected: PASS (реестр — 3 теста; presence — без изменений в поведении).

- [ ] **Step 7: Весь набор**

Run: `docker compose --profile test run --rm test`
Expected: 0 fail.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/domain/liveRegistry.ts apps/server/src/domain/presence.ts apps/server/src/realtime.ts apps/server/test/liveRegistry.test.ts
git commit -m "feat(server): cross-process online registry in Postgres for the worker's push decision"
```

---

### Task 4: Push через очередь

**Files:**
- Modify: `apps/server/src/domain/push.ts` (разделить `pushNewMessage` на `planPush` + `deliverPush`, убрать `pending`/`pushInBackground`/`settlePushes`)
- Modify: `apps/server/src/jobs/kinds.ts`
- Modify: `apps/server/src/domain/messages.ts:44-57`, `apps/server/src/domain/service.ts:38-55`, `apps/server/src/domain/login.ts:82-84`, `apps/server/src/domain/sessions.ts:166-175`
- Modify: `apps/server/test/helpers.ts`, `apps/server/test/push.test.ts`

**Interfaces:**
- Consumes: `enqueue` (Task 1), `register`, `PermanentError` (Task 2), `drainJobs` (Task 2), `onlineUsers` (Task 3).
- Produces:
  - задача `push.message`, payload `{ message: PushMessage }`
  - задача `push.deliver`, payload `{ endpoint: string; push: PushPayload }`
  - `type PushMessage` — прежний параметр `pushNewMessage`
  - `planPush(m: PushMessage): Promise<{ endpoint: string; push: PushPayload }[]>`
  - `deliverPush(endpoint: string, push: PushPayload): Promise<void>` — бросает `Error` (повтор) или `PermanentError`

- [ ] **Step 1: Новые сценарии в тестах push**

В `apps/server/test/push.test.ts`:

1. Заменить каждое ожидание доставки на явное выполнение очереди: строки вида `await waitFor(N); await Bun.sleep(…);` и `await settlePushes();` → `await drainJobs();`. Пример было/стало:

```ts
// было
await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'привет' });
await waitFor(1); await Bun.sleep(50);
// стало
await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'привет' });
await drainJobs();
```

Удалить объявления `waitFor` и `const { settlePushes } = await import('../src/domain/push');`, добавить `import { drainJobs } from '../src/jobs/worker';` и `import '../src/jobs/kinds';`.

2. Онлайн теперь из реестра: если в файле есть тесты «онлайн-пользователь не получает push», в них заменить подключение сокета/`connected()` на `await markOnline(userId, 1)` (импорт из `../src/domain/liveRegistry`).

3. Дописать сценарии в конец файла:

```ts
test('no worker yet: the push waits in jobs and is delivered once a worker runs', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const br = await browser();
  const { subscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(20), keys: br.keys }, await sessionFor(b));
  got.length = 0;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'дождись' });
  await Bun.sleep(100);
  expect(got.length).toBe(0);                                         // в процессе сервера ничего не уходит
  expect((await sql`select kind from jobs`).map((r) => r.kind)).toEqual(['push.message']);
  await drainJobs();
  expect(got.length).toBe(1);
  expect(await br.decrypt(got[0].body)).toMatchObject({ body: 'дождись' });
});

test('push service 503 is retried; 400 is dropped to jobs_dead; 410 forgets the subscription', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const { subscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(21), keys: (await browser()).keys }, await sessionFor(b));
  got.length = 0;

  status = 503;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'раз' });
  await drainJobs();
  expect(got.length).toBe(1);
  expect((await sql`select kind from jobs`).map((r) => r.kind)).toEqual(['push.deliver']);   // ждёт повтора
  status = 201;
  await sql`update jobs set run_at = now()`;
  await drainJobs();
  expect(got.length).toBe(2);
  expect((await sql`select count(*)::int as n from jobs`)[0].n).toBe(0);

  status = 400;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'два' });
  await drainJobs();
  expect((await sql`select kind from jobs_dead`).map((r) => r.kind)).toEqual(['push.deliver']);

  status = 410;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'три' });
  await drainJobs();
  expect((await sql`select count(*)::int as n from push_subscriptions`)[0].n).toBe(0);
  status = 201;
});

test('a subscription removed before delivery is skipped quietly', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const { subscribe, unsubscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(22), keys: (await browser()).keys }, await sessionFor(b));
  got.length = 0;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'x' });
  const [job] = await (await import('../src/jobs/queue')).claim(1);   // push.message
  await (await import('../src/jobs/worker')).runJob(job);             // поставил push.deliver
  await unsubscribe(b, endpoint(22));
  await drainJobs();
  expect(got.length).toBe(0);
  expect((await sql`select count(*)::int as n from jobs_dead`)[0].n).toBe(0);
});

test('an online recipient (any process) gets no push', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const { subscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(23), keys: (await browser()).keys }, await sessionFor(b));
  await sql`insert into live_conns (process_id, user_id, conns, seen_at) values (${crypto.randomUUID()}, ${b}, 1, now())`;
  got.length = 0;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'вижу сам' });
  await drainJobs();
  expect(got.length).toBe(0);
});
```

(Если в файле нет импортов `sql`, `makeUser`, `makeChat`, `sendMessage` — добавить из `../src/db`, `./helpers`, `../src/domain/messages`.)

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `docker compose --profile test run --rm test bun test push`
Expected: FAIL — задачи `push.message` нет (`expect(...).toEqual(['push.message'])` получает `[]`), push уходит сразу из процесса.

- [ ] **Step 3: Разделить отправку на план и доставку**

В `apps/server/src/domain/push.ts`:

1. Удалить блок «отправка в фоне» целиком: `const pending`, `pushInBackground`, `settlePushes`.
2. Заменить импорт `isOnline` на `onlineUsers`:

```ts
import { onlineUsers } from './liveRegistry';
import { PermanentError } from '../jobs/handlers';
```

3. Вынести тип сообщения и заменить `pushNewMessage` двумя функциями. Логика выборки подписок, умолчаний и текста — прежняя, меняются только «онлайн» и то, что вместо `fetch` возвращается список:

```ts
export type PushMessage = { chatId: number; id: number; senderId: number; body: string; entities?: { type: string; offset: number; length: number }[]; kind?: string; attachment?: { name?: string } | null; service?: { type: string } };

/** Кому и что слать: подписки живых сеансов участников без соединения, кроме отправителя, заглушивших и заблокировавших. */
export async function planPush(m: PushMessage): Promise<{ endpoint: string; push: PushPayload }[]> {
  m = { ...m, body: hideSpoilers(m.body, m.entities) };   // скрытый текст в уведомление не уходит
  // код входа не уходит в push-сервис и на экран блокировки
  if (m.service?.type === 'login_code') m = { ...m, body: 'Код для входа в Relay' };
  // имя отправителя — глазами получателя (контактное, если он его задал)
  const subs = await sql`
    select s.endpoint, s.user_id, s.hide_text,
           (select ${nameForSql(sql`s.user_id`)} from users u where u.id = ${m.senderId}) as sender_name
      from push_subscriptions s
    join chat_members cm on cm.user_id = s.user_id and cm.chat_id = ${m.chatId}
    join sessions se on se.id = s.session_id
    left join user_settings us on us.user_id = s.user_id
    where s.user_id <> ${m.senderId} and not (${m.chatId} = any(s.muted))
      and se.expires_at > now()
      and se.last_active_at > now() - make_interval(days => coalesce(us.sessions_ttl_days, ${DEFAULT_TTL_DAYS}))
      and not exists (select 1 from blocks b where b.owner_id = s.user_id and b.user_id = ${m.senderId})   -- от заблокированного — никогда`;
  const online = await onlineUsers([...new Set(subs.map((s) => Number(s.user_id)))]);
  const offline = subs.filter((s) => !online.has(Number(s.user_id)));
  if (!offline.length) return [];
  const [info] = await sql`select kind, title from chats where id = ${m.chatId}`;
  // умолчания получателя для этого вида чата: выключено — не шлём; без предпросмотра — текст не отдаём
  const defaults = await notifyDefaults(sql, [...new Set(offline.map((s) => s.user_id as number))]);
  const kind = info.kind === 'group' ? 'group' : 'direct';
  const prefOf = (userId: number) => defaults.get(userId)?.[kind] ?? { muted: false, preview: true };
  const preview = m.kind === 'voice' ? '🎤 Голосовое сообщение' : m.kind === 'round' ? 'Видеосообщение' : m.kind === 'photo' ? (m.body ? '🖼 ' + m.body : 'Фотография') : m.kind === 'file' ? '📎 ' + (m.body || m.attachment?.name || 'Файл') : m.body;
  return offline.filter((s) => !prefOf(s.user_id as number).muted).map((s) => {
    const name = s.sender_name as string;
    const shown = prefOf(s.user_id as number).preview;
    // «Скрывать текст в уведомлениях» на этом устройстве — ни имени, ни текста (как и локальное уведомление)
    const push: PushPayload = s.hide_text === true
      ? { chatId: m.chatId, id: m.id, title: 'Relay', body: NO_PREVIEW }
      : kind === 'group'
      ? { chatId: m.chatId, id: m.id, title: (info.title as string) ?? 'Группа', body: shown ? `${name}: ${preview}` : NO_PREVIEW }
      : { chatId: m.chatId, id: m.id, title: name, body: shown ? preview : NO_PREVIEW };
    if (m.service) push.system = true;
    return { endpoint: s.endpoint as string, push };
  });
}

const PUSH_TIMEOUT_MS = 10_000;

/**
 * Одна доставка. Ключи подписки читаются сейчас: подписку могли удалить или обновить после постановки.
 * 404/410 — подписка отозвана, забываем; 429/5xx/сеть — Error (повтор); прочие 4xx — PermanentError.
 */
export async function deliverPush(endpoint: string, push: PushPayload): Promise<void> {
  const [s] = await sql`select p256dh, auth from push_subscriptions where endpoint = ${endpoint}`;
  if (!s) return;
  const plain = enc.encode(JSON.stringify(push).slice(0, 3000));
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: await vapidHeader(endpoint), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high' },
    body: await encryptPayload(s.p256dh as string, s.auth as string, plain),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 410) { await sql`delete from push_subscriptions where endpoint = ${endpoint}`; return; }
  if (res.status === 429 || res.status >= 500) throw new Error(`push service ${res.status}`);
  if (!res.ok) throw new PermanentError(`push service ${res.status}`);
}
```

- [ ] **Step 4: Обработчики задач**

`apps/server/src/jobs/kinds.ts`:

```ts
// Регистрация доменных обработчиков задач. Импортируется процессом-воркером и тестами.
import { sql } from '../db';
import { deliverPush, planPush, type PushMessage, type PushPayload } from '../domain/push';
import { register } from './handlers';
import { enqueue } from './queue';

// новое сообщение → по задаче на подписку: повтор одной не шлёт остальным второй раз
register('push.message', async (p: { message: PushMessage }) => {
  const targets = await planPush(p.message);
  if (!targets.length) return;
  await sql.begin(async (tx) => {
    for (const t of targets) await enqueue(tx, 'push.deliver', t);
  });
});

register('push.deliver', async (p: { endpoint: string; push: PushPayload }) => {
  await deliverPush(p.endpoint, p.push);
});
```

- [ ] **Step 5: Ставить задачу в транзакции отправки**

`apps/server/src/domain/messages.ts`: убрать импорт `pushInBackground`, добавить `import { enqueue } from '../jobs/queue';`. Внутри `sql.begin`, после `clearDraftInTx`:

```ts
    await clearDraftInTx(tx, userId, input.chatId); // отправили — черновик на всех устройствах больше не нужен
    await enqueue(tx, 'push.message', { message });  // уйдёт после коммита, воркером
    return { message, duplicate: false };
  });
  return res;
}
```

(Строки `// после коммита и не дожидаясь…` и `if (!res.duplicate) pushInBackground(res.message);` удалить.)

`apps/server/src/domain/service.ts`: в `postService` после `fanOut` добавить `await enqueue(tx, 'push.message', { message });`; удалить функцию `pushService` и импорт `pushInBackground`; комментарий над `postService` заменить на «Служебное сообщение пользователю: строка messages, newMessage в журнал и задача push — всё в транзакции вызывающего.» Добавить `import { enqueue } from '../jobs/queue';`.

`apps/server/src/domain/login.ts`: убрать `pushService` из импорта и строку `if (posted) pushService(posted);   // push только после коммита`. Если переменная `posted` больше ни для чего не нужна — заменить `posted = await postService(...)` на `await postService(...)` и удалить её объявление.

`apps/server/src/domain/sessions.ts` (`announceLogin`): убрать `pushService` из импорта и вызов `pushService(message);`; транзакция больше не должна возвращать сообщение:

```ts
export async function announceLogin(userId: number, token: string): Promise<void> {
  const [s] = await sql`select device, ip, created_at from sessions where token_hash = ${hashToken(token)}`;
  if (!s) return;
  await sql.begin(async (tx) => {
    await postService(tx, userId, { type: 'new_login', ...newLoginMessage(s.device || 'Браузер', s.ip, new Date(s.created_at)) });
    await changed(tx, userId);
  });
}
```

- [ ] **Step 6: Тестовые хелперы**

`apps/server/test/helpers.ts`: удалить `import { settlePushes } …`, строку `await settlePushes();` и комментарий над ней (фоновых отправок больше нет — гонки с truncate тоже).

`packages/sync-engine/test/helpers.ts:11`: тесты движка отправляют сообщения на общей базе `relay_test` и теперь оставляют задачи `push.message` — добавить `jobs, jobs_dead` в их `truncate`:

```ts
  await sql`truncate login_attempts, sessions, chats, chat_members, messages, user_seq, updates, jobs, jobs_dead restart identity cascade`;
```

- [ ] **Step 7: Найти оставшиеся ссылки**

Run: `grep -rn "pushInBackground\|settlePushes\|pushService\|pushNewMessage\|isOnline" apps/server/src apps/server/test`
Expected: только `isOnline` внутри `presence.ts` (он нужен `presenceFor`). Остальное — исправить: тесты, ожидающие push после `sendMessage`, переводятся на `await drainJobs()` так же, как в Step 1.

- [ ] **Step 8: Тесты проходят**

Run: `docker compose --profile test run --rm test && docker compose --profile test run --rm test-engine`
Expected: 0 fail в обоих, в том числе 4 новых теста push.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/domain/push.ts apps/server/src/jobs/kinds.ts apps/server/src/domain/messages.ts apps/server/src/domain/service.ts apps/server/src/domain/login.ts apps/server/src/domain/sessions.ts apps/server/test packages/sync-engine/test/helpers.ts
git commit -m "feat(server): Web Push through the job queue — enqueued in the send transaction, one retried delivery per subscription"
```

---

### Task 5: Письмо восстановления через очередь, dev-почта в базе

**Зачем:** код в `deliver()` сейчас кладётся в массив процесса сервера. Воркер — другой процесс, поэтому dev-почта переезжает в таблицу `dev_mail`, и `/dev/codes` читает её.

**Files:**
- Modify: `apps/server/src/domain/devOutbox.ts`
- Modify: `apps/server/src/domain/password.ts` (`startRecovery`)
- Modify: `apps/server/src/authRoutes.ts:51`
- Modify: `apps/server/src/jobs/kinds.ts`
- Modify: `apps/server/test/auth.test.ts`

**Interfaces:**
- Consumes: `enqueue` (Task 1), `register` (Task 2), `drainJobs` (Task 2).
- Produces:
  - задача `mail.recovery`, payload `{ to: string; secret: { code: string } }`
  - `deliver(item: { to: string; kind: 'recovery'; code: string }): Promise<void>`
  - `devOutbox(): Promise<OutboxItem[]>` (новые сверху, до 50)
  - `clearOutbox(): Promise<void>`

- [ ] **Step 1: Тест**

В `apps/server/test/auth.test.ts`:
- `beforeEach(async () => { await resetDb(); clearOutbox(); });` → `beforeEach(async () => { await resetDb(); await clearOutbox(); });`
- в тесте «forgot password» строку `const mail = devOutbox()[0];` заменить на:

```ts
  expect(await devOutbox()).toEqual([]);              // в запросе письмо не отправляется — только задача
  await drainJobs();
  const mail = (await devOutbox())[0];
```

- в конец этого же теста дописать:

```ts
  // код не остаётся в очереди: выполненная задача удалена, а в jobs_dead секрет не копируется
  expect((await sql`select count(*)::int as n from jobs where kind = 'mail.recovery'`)[0].n).toBe(0);
```

- добавить импорты `import { drainJobs } from '../src/jobs/worker';` и `import '../src/jobs/kinds';`.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `docker compose --profile test run --rm test bun test auth`
Expected: FAIL — `devOutbox()` возвращает массив сразу после запроса, а не `[]`.

- [ ] **Step 3: Dev-почта в таблице**

`apps/server/src/domain/devOutbox.ts` целиком:

```ts
import { sql } from '../db';

/**
 * Исходящие коды без настоящей доставки (почта восстановления пароля). Отправляет воркер (задача mail.recovery),
 * поэтому в dev письма лежат в таблице dev_mail и видны на /dev/codes из любого процесса;
 * в проде — только строка в логе без самого кода: почтового шлюза в Relay пока нет.
 */
export interface OutboxItem { at: string; to: string; kind: 'recovery'; code: string }

const MAX = 50;

export async function deliver(item: Omit<OutboxItem, 'at'>): Promise<void> {
  if (process.env.DEV_LOGIN === '1') {
    await sql`insert into dev_mail (to_addr, kind, code) values (${item.to}, ${item.kind}, ${item.code})`;
    await sql`delete from dev_mail where id not in (select id from dev_mail order by id desc limit ${MAX})`;
  } else {
    console.warn(`outbox: ${item.kind} code for ${item.to.replace(/(.).*@/, '$1…@')} — no mail gateway configured`);
  }
}

export async function devOutbox(): Promise<OutboxItem[]> {
  const rows = await sql`select at, to_addr, kind, code from dev_mail order by id desc limit ${MAX}`;
  return rows.map((r) => ({ at: new Date(r.at as string).toISOString(), to: r.to_addr as string, kind: r.kind as 'recovery', code: r.code as string }));
}

export async function clearOutbox(): Promise<void> {
  await sql`delete from dev_mail`;
}
```

- [ ] **Step 4: Задача в транзакции**

`apps/server/src/domain/password.ts`, `startRecovery`: запись кода и постановка письма — одной транзакцией; убрать импорт `deliver`, добавить `import { enqueue } from '../jobs/queue';`:

```ts
  const code = String(randomInt(0, 1e6)).padStart(6, '0');
  await sql.begin(async (tx) => {
    await tx`insert into password_recovery (pending_id, code_hash, expires_at) values (${p.id}, ${hashCode(code)}, now() + ${RECOVERY_MIN + ' minutes'}::interval)
              on conflict (pending_id) do update set code_hash = excluded.code_hash, tries = 0, expires_at = excluded.expires_at`;
    // код — под secret: в jobs_dead не копируется; письмо, не ушедшее за срок жизни кода, бесполезно
    await enqueue(tx, 'mail.recovery', { to: pw.email as string, secret: { code } }, { maxAttempts: 5 });
  });
  return { emailPattern: maskEmail(pw.email as string) };
```

- [ ] **Step 5: Обработчик и маршрут**

В `apps/server/src/jobs/kinds.ts` добавить:

```ts
import { deliver } from '../domain/devOutbox';

register('mail.recovery', async (p: { to: string; secret: { code: string } }) => {
  await deliver({ to: p.to, kind: 'recovery', code: p.secret.code });
});
```

`apps/server/src/authRoutes.ts:51`: `Response.json({ items: devOutbox() })` → `Response.json({ items: await devOutbox() })`.

- [ ] **Step 6: Остальные места**

Run: `grep -rn "devOutbox()\|clearOutbox()\|deliver(" apps packages --include=*.ts | grep -v node_modules`
Expected: все вызовы `devOutbox()`/`clearOutbox()` стоят под `await`. Тесты движка или e2e, читающие `/dev/codes` по HTTP, менять не нужно — формат ответа тот же; если они ждут код сразу после запроса, перед чтением добавить `await drainJobs()`.

- [ ] **Step 7: Тесты проходят**

Run: `docker compose --profile test run --rm test`
Expected: 0 fail.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/domain/devOutbox.ts apps/server/src/domain/password.ts apps/server/src/authRoutes.ts apps/server/src/jobs/kinds.ts apps/server/test/auth.test.ts
git commit -m "feat(server): recovery mail through the job queue; dev mailbox in a table visible to every process"
```

---

### Task 6: Чистка сеансов — периодическая задача

**Files:**
- Modify: `apps/server/src/jobs/kinds.ts`
- Modify: `apps/server/src/worker.ts`
- Modify: `apps/server/src/main.ts`
- Test: `apps/server/test/sessions.test.ts` (дописать)

**Interfaces:**
- Consumes: `ensurePeriodic` (Task 1), `register`, `drainJobs` (Task 2), `sweepInactive(userId?: number): Promise<number[]>` из `domain/sessions.ts`.
- Produces: периодическая задача `sessions.sweep` (раз в `SWEEP_EVERY_SEC = 3600`).

- [ ] **Step 1: Тест**

Дописать в `apps/server/test/sessions.test.ts` (импорты `sql`, `ensurePeriodic`, `drainJobs`, `'../src/jobs/kinds'` — в шапку, если их нет):

```ts
test('the periodic sweep job ends expired sessions and reschedules itself in an hour', async () => {
  const u = await makeUser('Анна');
  const token = crypto.randomUUID();
  await sql`insert into sessions (user_id, token_hash, expires_at) values (${u}, ${token}, now() - interval '1 minute')`;
  await ensurePeriodic('sessions.sweep');
  await drainJobs();
  expect((await sql`select count(*)::int as n from sessions where user_id = ${u}`)[0].n).toBe(0);
  const [job] = await sql`select attempts, run_at > now() + interval '59 minutes' as later from jobs where kind = 'sessions.sweep'`;
  expect(job).toEqual({ attempts: 0, later: true });
});
```

Если в `sessions` есть другие обязательные колонки без умолчаний — взять вставку сеанса из соседних тестов этого файла (там есть готовый способ создать сеанс), но с `expires_at` в прошлом.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `docker compose --profile test run --rm test bun test sessions`
Expected: FAIL — задача ушла в `jobs_dead` с `no handler for sessions.sweep`, сеанс на месте.

- [ ] **Step 3: Обработчик**

В `apps/server/src/jobs/kinds.ts`:

```ts
import { sweepInactive } from '../domain/sessions';

export const SWEEP_EVERY_SEC = 3600;

// автозавершение истёкших и неактивных сеансов; NOTIFY sessions закроет их сокеты в процессах сервера
register('sessions.sweep', async () => {
  await sweepInactive();
  return { again: { inSec: SWEEP_EVERY_SEC } };
});
```

- [ ] **Step 4: Воркер заводит задачу, сервер больше не чистит по таймеру**

`apps/server/src/worker.ts` — перед `startWorker`:

```ts
import { ensurePeriodic } from './jobs/queue';

await ensurePeriodic('sessions.sweep');   // одна на всю систему, сколько бы воркеров ни было
```

`apps/server/src/main.ts` — удалить импорт `sweepInactive`, функцию `sweep`, вызов `sweep()` и `setInterval(sweep, …)` вместе с комментарием над ними.

- [ ] **Step 5: Тесты проходят**

Run: `docker compose --profile test run --rm test`
Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/jobs/kinds.ts apps/server/src/worker.ts apps/server/src/main.ts apps/server/test/sessions.test.ts
git commit -m "feat(server): hourly session sweep as a periodic job instead of a timer in the server process"
```

---

### Task 7: Проверка целиком

**Files:** без изменений кода (только если проверка найдёт ошибку — тогда исправление с тестом и отдельный коммит).

- [ ] **Step 1: Оба набора тестов**

Run: `docker compose --profile test run --rm test && docker compose --profile test run --rm test-engine`
Expected: 0 fail в обоих.

- [ ] **Step 2: Живой стенд**

Run: `docker compose up -d --build migrate server worker && sleep 5 && docker compose logs worker --tail 5`
Expected: `relay worker started`; в базе одна периодическая задача:

Run: `docker compose exec -T postgres psql -U relay -d relay -c "select kind, run_at > now() as later from jobs"`
Expected: строка `sessions.sweep | t`.

- [ ] **Step 3: Воркер остановлен — задачи копятся, запущен — уходят**

1. `docker compose stop worker`
2. В браузере (Chrome DevTools или Playwright, две изолированные сессии, вход через `POST /dev/login`) отправить сообщение от одного тестового пользователя другому, у которого нет открытой вкладки и есть push-подписка (или просто любое сообщение: задача `push.message` ставится всегда).
3. `docker compose exec -T postgres psql -U relay -d relay -c "select kind from jobs where kind like 'push.%'"` — есть `push.message`.
4. `docker compose start worker && sleep 3` — повторить запрос: строк `push.%` нет; `select count(*) from jobs_dead` — 0 (либо записи `push.deliver` с понятной ошибкой push-сервиса, если подписка ненастоящая).

Expected: сообщение в ленте у получателя появляется сразу, независимо от воркера (журнал не зависит от очереди); push-задачи выполняются после старта воркера.

- [ ] **Step 4: Dev-почта**

На странице входа пройти «Забыли пароль?» для тестового аккаунта с почтой восстановления, затем открыть `http://localhost:3000/dev/codes`.
Expected: письмо с кодом появляется через ~1 с (выполнил воркер), код подходит.

- [ ] **Step 5: Итог для пользователя**

Сообщить: что переехало в очередь, результаты тестов (числа), что проверено на стенде, что не проверено (настоящий push-сервис браузера в автоматических тестах недоступен — проверяется поддельным сервером в `push.test.ts`). Ветку в master не сливать без слова пользователя.

---

## Что не входит в этап

- Valkey/Redis, отдельный Gateway — этап 2.
- Превью ссылок и обработка медиа — появятся как новые `kind` поверх этой очереди, когда до них дойдёт.
- Страница наблюдения за очередью (`/dev/jobs`) и метрики — по необходимости; сейчас хватает SQL по `jobs` и `jobs_dead`.
- Повторная отправка задач из `jobs_dead` — вручную SQL-ом, если понадобится.

## Риски и решения

- **Повтор обработчика.** Аренда истекла или процесс упал между `fetch` и `complete` — push уйдёт ещё раз. Для уведомлений это допустимо: SW показывает их с `tag: chat-<id>`, дубль заменяет прежнее. Новые обработчики обязаны терпеть повтор.
- **Задержка push.** Добавляется путь «коммит → NOTIFY → воркер», обычно единицы миллисекунд; при остановленном воркере push ждёт, а сообщения доставляются как раньше — журнал от очереди не зависит.
- **Секрет в очереди.** Код восстановления лежит в `jobs.payload.secret` до выполнения (секунды); выполненная задача удаляется, в `jobs_dead` секрет не копируется. Хэш кода, как и раньше, — в `password_recovery`.
- **Онлайн из реестра.** Решение «слать ли push» принимается при выполнении задачи, а не при отправке: вернувшийся за эти миллисекунды пользователь push не получит — так и задумано.
