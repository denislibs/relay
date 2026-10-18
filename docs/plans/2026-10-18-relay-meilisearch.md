# Поиск сообщений в Meilisearch (этап 4 бэкенда) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** поиск сообщений идёт по индексу Meilisearch (по словам и их началу, с опечатками, быстро на больших объёмах); индекс заполняется задачами из очереди этапа 1; при недоступном или ещё не построенном индексе поиск молча работает по Postgres, как сейчас.

**Architecture:** Meilisearch хранит только текст для поиска: id сообщения, id чата, тело, имя файла. Прав доступа в индексе нет — сервер при каждом запросе берёт из Postgres список чатов пользователя и передаёт его фильтром, а найденные id ещё раз проверяет и «оживляет» из Postgres (членство, `deleted`, реакции, название чата). Индекс обновляется задачей `search.sync {id}` в той же транзакции, что и отправка, правка или удаление: обработчик читает текущее состояние сообщения и делает upsert или удаление — повтор и порядок задач не важны. Полная перестройка (`search.reindex`) строит новый индекс рядом и меняет местами (swap), пока старый обслуживает запросы. Готовность индекса — версия в `server_meta`.

**Tech Stack:** Meilisearch 1.x (REST API через `fetch`), Bun 1.4, TypeScript, PostgreSQL 17, очередь задач этапа 1, Docker Compose, `bun test`.

## Global Constraints

- Новых npm-зависимостей нет: клиент Meilisearch — несколько функций поверх `fetch`.
- Образ Meilisearch — с зафиксированным тегом `getmeili/meilisearch:v1.x` (последний 1.x на момент работы; проверить, что тег существует). Лицензия Community Edition — MIT.
- Мастер-ключ Meilisearch знает только сервер и воркер (`MEILI_MASTER_KEY`); наружу порт не публикуется, клиенту ключ не отдаётся.
- Права проверяет только сервер: индекс без списков доступа, фильтр по чатам строится из Postgres на каждый запрос, найденное перепроверяется в Postgres.
- Сообщения со `service_type = 'login_code'` в индекс не попадают (коды входа не уходят во второе хранилище).
- Поиск без Meilisearch не ломается: ошибка или неготовый индекс → прежний поиск по Postgres.
- Имена индексов с префиксом `SEARCH_INDEX_PREFIX` (по умолчанию `relay`, в тестах `relay_test`).
- Без кода из telegram-tt и tweb (GPL).
- Тесты — только в Docker: `docker compose --profile test run --rm test` и `docker compose --profile test run --rm test-engine`.
- Комментарии в коде — по-русски.
- Миграций в этом этапе нет (состояние — строки `server_meta`).
- Работать в своей ветке; в master — только по слову пользователя.

## Поведение поиска: что меняется для пользователя

| | Сейчас (Postgres, `ILIKE`) | После (Meilisearch) |
|---|---|---|
| Совпадение | любая подстрока: «ес» находит «перенесли» | слово или его начало: «встр» находит «встреча», «ес» не находит «перенесли» |
| Опечатки | нет | прощает 1–2 опечатки в длинных словах («встерча» → «встреча») |
| Порядок | новые сверху | новые сверху (как в Telegram) |
| Имя файла | не ищется | ищется («отчёт» находит `отчёт.pdf`) |
| Скорость | падает с ростом базы | стабильная |

Это сознательное изменение: так ищут Telegram и почтовые клиенты. Прежнее поведение остаётся запасным путём.

## File Structure

| Файл | Ответственность |
|---|---|
| `docker-compose.yml` | сервис `search` (Meilisearch); переменные у `server`, `worker`, `test`, `test-engine` |
| `apps/server/src/search/meili.ts` | HTTP-клиент: `meili()`, `waitTask()`, `indexName()` |
| `apps/server/src/search/messagesIndex.ts` | настройки индекса, документ сообщения, `syncMessage`, `reindexAll`, `searchIds`, готовность |
| `apps/server/src/domain/search.ts` | `searchMessages`: Meilisearch → «оживление» из Postgres; иначе `searchPostgres` (прежний код) |
| `apps/server/src/jobs/kinds.ts` | задачи `search.sync`, `search.reindex` |
| `apps/server/src/worker.ts` | при старте: индекс не той версии → поставить `search.reindex` |
| `apps/server/src/domain/messages.ts`, `service.ts`, `messageOps.ts` | `search.sync` в транзакциях отправки, служебного сообщения, правки, удаления |
| `apps/server/src/dev/seed.ts` | после заливки — `search.reindex` |
| `apps/server/test/helpers.ts`, `packages/sync-engine/test/helpers.ts` | `resetDb` выключает Meilisearch-путь (удаляет строки готовности) |
| `apps/server/test/search.test.ts` | прежний тест — на `searchPostgres` |
| `apps/server/test/meili.test.ts` | индекс, синхронизация, поиск, права, перестройка, запасной путь |

---

### Task 1: Meilisearch в стеке и клиент

**Files:**
- Modify: `docker-compose.yml`
- Create: `apps/server/src/search/meili.ts`
- Test: `apps/server/test/meili.test.ts`

**Interfaces:**
- Produces:
  - `meili<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T>` — бросает `MeiliError` на не-2xx
  - `class MeiliError extends Error { status: number; code: string | undefined }`
  - `waitTask(taskUid: number, timeoutMs?: number): Promise<void>` — ждёт `succeeded`, бросает на `failed`/таймаут
  - `indexName(base: string): string` — `${SEARCH_INDEX_PREFIX ?? 'relay'}_${base}`

- [ ] **Step 1: Сервис**

В `docker-compose.yml`:

```yaml
  search:
    image: getmeili/meilisearch:v1.15   # заменить на последний существующий 1.x и зафиксировать
    environment:
      MEILI_MASTER_KEY: relay-dev-master-key-change-me
      MEILI_NO_ANALYTICS: "true"
      MEILI_ENV: development
    volumes:
      - meili:/meili_data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:7700/health"]
      interval: 2s
      timeout: 3s
      retries: 30
```

В `volumes:` внизу файла добавить `meili: {}`.
У `server` и `worker`: `MEILI_URL: http://search:7700`, `MEILI_MASTER_KEY: relay-dev-master-key-change-me`, `depends_on: search: { condition: service_healthy }`.
У `test` и `test-engine`: те же две переменные плюс `SEARCH_INDEX_PREFIX: relay_test` и тот же `depends_on`.

- [ ] **Step 2: Тест клиента**

`apps/server/test/meili.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { indexName, meili, MeiliError, waitTask } from '../src/search/meili';

test('client talks to Meilisearch with the master key; errors carry status and code', async () => {
  expect((await meili<{ status: string }>('/health')).status).toBe('available');
  const name = indexName('probe');
  expect(name).toBe('relay_test_probe');
  const t = await meili<{ taskUid: number }>('/indexes', { method: 'POST', body: { uid: name, primaryKey: 'id' } });
  await waitTask(t.taskUid);
  const err = await meili('/indexes/does_not_exist').catch((e) => e);
  expect(err).toBeInstanceOf(MeiliError);
  expect(err).toMatchObject({ status: 404, code: 'index_not_found' });
  await waitTask((await meili<{ taskUid: number }>(`/indexes/${name}`, { method: 'DELETE' })).taskUid);
});
```

- [ ] **Step 3: Убедиться, что падает**

Run: `docker compose --profile test run --rm test bun test meili`
Expected: FAIL — `Cannot find module '../src/search/meili'`.

- [ ] **Step 4: Клиент**

`apps/server/src/search/meili.ts`:

```ts
/**
 * Минимальный клиент Meilisearch поверх fetch. Мастер-ключ — только у сервера и воркера.
 * Изменения в Meilisearch асинхронные: ответ — taskUid, готовность — waitTask.
 */
export class MeiliError extends Error {
  constructor(public status: number, public code: string | undefined, message: string) { super(message); }
}

const base = () => { const u = process.env.MEILI_URL; if (!u) throw new Error('MEILI_URL is not set'); return u; };

export async function meili<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(base() + path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${process.env.MEILI_MASTER_KEY ?? ''}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new MeiliError(res.status, json?.code, json?.message ?? `meilisearch ${res.status}`);
  return json as T;
}

export async function waitTask(taskUid: number, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
    const t = await meili<{ status: string; error?: { message: string; code: string } }>(`/tasks/${taskUid}`);
    if (t.status === 'succeeded') return;
    if (t.status === 'failed' || t.status === 'canceled') throw new MeiliError(500, t.error?.code, t.error?.message ?? `task ${taskUid} ${t.status}`);
    if (Date.now() > until) throw new Error(`meilisearch task ${taskUid} timed out`);
    await Bun.sleep(delay);
  }
}

export const indexName = (base: string): string => `${process.env.SEARCH_INDEX_PREFIX ?? 'relay'}_${base}`;
```

- [ ] **Step 5: Тест проходит**

Run: `docker compose --profile test run --rm test bun test meili`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml apps/server/src/search/meili.ts apps/server/test/meili.test.ts
git commit -m "feat(server): Meilisearch in the stack and a fetch-based client"
```

---

### Task 2: Индекс сообщений: документ, синхронизация, поиск id

**Files:**
- Create: `apps/server/src/search/messagesIndex.ts`
- Test: `apps/server/test/meili.test.ts` (дописать)

**Interfaces:**
- Consumes: `meili`, `waitTask`, `indexName`, `MeiliError` (Task 1).
- Produces:
  - `SEARCH_INDEX_VERSION: number` — менять при изменении настроек или формы документа
  - `liveIndex(): string` — `indexName('messages')`
  - `ensureIndex(uid: string): Promise<void>` — создать (если нет) и применить настройки
  - `syncMessage(id: number): Promise<void>` — upsert или удаление по текущему состоянию в Postgres, в живой и (если идёт перестройка) строящийся индекс
  - `searchIds(q: string, chatIds: number[], opts: { beforeId?: number; limit: number }): Promise<number[]>` — id новые сверху, до `limit + 1`
  - `searchReady(): Promise<boolean>` — `server_meta.search_index = SEARCH_INDEX_VERSION`

- [ ] **Step 1: Тесты**

Дописать в `apps/server/test/meili.test.ts`:

```ts
import { beforeEach } from 'bun:test';
import { sql } from '../src/db';
import { sendMessage } from '../src/domain/messages';
import { deleteMessage, editMessage } from '../src/domain/messageOps';
import { ensureIndex, liveIndex, searchIds, syncMessage } from '../src/search/messagesIndex';
import { makeChat, makeUser, resetDb } from './helpers';

const say = (u: number, chatId: number, body: string) => sendMessage(u, { chatId, clientId: crypto.randomUUID(), body }).then((r) => r.message);

async function freshIndex() {
  await meili(`/indexes/${liveIndex()}`, { method: 'DELETE' }).then((t: any) => waitTask(t.taskUid), () => {});
  await ensureIndex(liveIndex());
}

beforeEach(async () => { await resetDb(); await freshIndex(); });

test('sync indexes the current state: edit replaces, delete removes; word prefix and typos match; newest first; chat filter', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  const m1 = await say(a, ab, 'Встреча в пятницу');
  const m2 = await say(b, ab, 'перенесли встречу');
  const m3 = await say(b, bc, 'встреча без a');
  for (const m of [m1, m2, m3]) await syncMessage(m.id);

  expect(await searchIds('встр', [ab], { limit: 10 })).toEqual([m2.id, m1.id]);
  // одна опечатка (перестановка) в слове из 7 букв прощается; «встречу» — уже две, не находится
  expect(await searchIds('встерча', [ab, bc], { limit: 10 })).toEqual([m3.id, m1.id]);
  expect(await searchIds('встреч', [ab], { limit: 1 })).toEqual([m2.id, m1.id]);               // limit + 1 — признак «есть ещё»
  expect(await searchIds('встреч', [ab], { beforeId: m2.id, limit: 10 })).toEqual([m1.id]);
  expect(await searchIds('встреч', [], { limit: 10 })).toEqual([]);

  await editMessage(a, ab, m1.id, 'совещание в пятницу');
  await syncMessage(m1.id);
  expect(await searchIds('встреч', [ab], { limit: 10 })).toEqual([m2.id]);
  expect(await searchIds('совещ', [ab], { limit: 10 })).toEqual([m1.id]);

  await deleteMessage(b, ab, m2.id);
  await syncMessage(m2.id);
  expect(await searchIds('встреч', [ab], { limit: 10 })).toEqual([]);
});

test('login codes are never indexed; file names are', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const [code] = await sql`insert into messages (chat_id, sender_id, client_id, kind, body, service_type) values (${ab}, ${a}, ${crypto.randomUUID()}, 'text', 'Код входа 482913', 'login_code') returning id`;
  const [file] = await sql`insert into messages (chat_id, sender_id, client_id, kind, body, attachment) values (${ab}, ${a}, ${crypto.randomUUID()}, 'file', '', ${sql.json({ id: 'x', kind: 'file', name: 'отчёт за май.pdf', mime: 'application/pdf', size: 1 } as never)}) returning id`;
  await syncMessage(Number(code.id));
  await syncMessage(Number(file.id));
  expect(await searchIds('482913', [ab], { limit: 10 })).toEqual([]);
  expect(await searchIds('отчёт', [ab], { limit: 10 })).toEqual([Number(file.id)]);
});
```

(Если у `messages` есть другие обязательные колонки без умолчаний — взять форму вставки из `service.ts:43` и `messages.ts:40`.)

- [ ] **Step 2: Убедиться, что падает**

Run: `docker compose --profile test run --rm test bun test meili`
Expected: FAIL — `Cannot find module '../src/search/messagesIndex'`.

- [ ] **Step 3: Индекс**

`apps/server/src/search/messagesIndex.ts`:

```ts
import { sql } from '../db';
import { indexName, meili, MeiliError, waitTask } from './meili';

/**
 * Индекс сообщений: только то, по чему ищем, и id чата для фильтра. Прав доступа здесь нет — их проверяет
 * сервер (фильтр по чатам пользователя и перепроверка найденного в Postgres). Документ строится из текущей
 * строки messages, поэтому синхронизация идемпотентна и не зависит от порядка задач.
 */
export const SEARCH_INDEX_VERSION = 1;
export const liveIndex = (): string => indexName('messages');

const SETTINGS = {
  searchableAttributes: ['body', 'attachmentName'],
  filterableAttributes: ['chatId', 'id'],
  sortableAttributes: ['id'],
  // новые сверху, как в Telegram: сортировка раньше релевантности; совпадение по словам и опечаткам остаётся
  rankingRules: ['sort', 'words', 'typo', 'proximity', 'attribute', 'exactness'],
};

type Doc = { id: number; chatId: number; body: string; attachmentName: string | null };

export async function ensureIndex(uid: string): Promise<void> {
  try {
    await waitTask((await meili<{ taskUid: number }>('/indexes', { method: 'POST', body: { uid, primaryKey: 'id' } })).taskUid);
  } catch (e) {
    if (!(e instanceof MeiliError && e.code === 'index_already_exists')) throw e;
  }
  await waitTask((await meili<{ taskUid: number }>(`/indexes/${uid}/settings`, { method: 'PATCH', body: SETTINGS })).taskUid);
}

function docOf(r: Record<string, unknown>): Doc | null {
  if (r.deleted || r.service_type === 'login_code') return null;   // удалённые и коды входа не ищутся
  const attachmentName = (r.attachment as { name?: string } | null)?.name ?? null;
  if (!r.body && !attachmentName) return null;
  return { id: Number(r.id), chatId: Number(r.chat_id), body: String(r.body ?? ''), attachmentName };
}

/** Индексы, в которые пишем: живой и, пока идёт перестройка, строящийся. */
async function targets(): Promise<string[]> {
  const [b] = await sql`select v from server_meta where k = 'search_building'`;
  return b ? [liveIndex(), b.v as string] : [liveIndex()];
}

export async function syncMessage(id: number): Promise<void> {
  const [row] = await sql`select id, chat_id, body, deleted, service_type, attachment from messages where id = ${id}`;
  const doc = row ? docOf(row) : null;
  for (const uid of await targets()) {
    const task = doc
      ? await meili<{ taskUid: number }>(`/indexes/${uid}/documents`, { method: 'POST', body: [doc] })
      : await meili<{ taskUid: number }>(`/indexes/${uid}/documents/${id}`, { method: 'DELETE' });
    await waitTask(task.taskUid);
  }
}

export async function searchIds(q: string, chatIds: number[], opts: { beforeId?: number; limit: number }): Promise<number[]> {
  if (!chatIds.length) return [];
  const filter = [`chatId IN [${chatIds.join(',')}]`];
  if (opts.beforeId) filter.push(`id < ${opts.beforeId}`);
  const res = await meili<{ hits: { id: number }[] }>(`/indexes/${liveIndex()}/search`, {
    method: 'POST',
    body: { q, filter, sort: ['id:desc'], limit: opts.limit + 1, attributesToRetrieve: ['id'], matchingStrategy: 'all' },
  });
  return res.hits.map((h) => Number(h.id));
}

export async function searchReady(): Promise<boolean> {
  const [r] = await sql`select v from server_meta where k = 'search_index'`;
  return r?.v === String(SEARCH_INDEX_VERSION);
}
```

- [ ] **Step 4: Тесты проходят**

Run: `docker compose --profile test run --rm test bun test meili`
Expected: PASS. Если порядок с опечаткой не совпал — проверить, что `rankingRules` применились (`GET /indexes/relay_test_messages/settings`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/search/messagesIndex.ts apps/server/test/meili.test.ts
git commit -m "feat(server): messages index in Meilisearch — idempotent sync from the current row, newest-first search by chat filter"
```

---

### Task 3: Перестройка индекса и готовность

**Files:**
- Modify: `apps/server/src/search/messagesIndex.ts`
- Modify: `apps/server/src/jobs/kinds.ts`
- Modify: `apps/server/src/worker.ts`
- Modify: `apps/server/src/dev/seed.ts`
- Modify: `apps/server/test/helpers.ts`, `packages/sync-engine/test/helpers.ts`
- Test: `apps/server/test/meili.test.ts` (дописать)

**Interfaces:**
- Consumes: Task 2; `enqueue`, `ensurePeriodic` не нужен; `register` (этап 1).
- Produces:
  - `reindexAll(batch?: number): Promise<number>` — строит `<live>_next`, копирует все сообщения, меняет местами с живым, удаляет старый, ставит `server_meta.search_index`; возвращает число документов
  - задача `search.reindex` (без payload, `dedupeKey: 'search.reindex'`)
  - задача `search.sync`, payload `{ id: number }`
  - `scheduleReindexIfStale(): Promise<void>` — для воркера

- [ ] **Step 1: Тест**

Дописать в `apps/server/test/meili.test.ts`:

```ts
import { reindexAll, searchReady } from '../src/search/messagesIndex';

test('reindex builds a fresh index beside the live one, swaps it in and marks the index ready', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const m1 = await say(a, ab, 'старая встреча');
  const gone = await say(a, ab, 'встреча удалена');
  await deleteMessage(a, ab, gone.id);
  expect(await searchReady()).toBe(false);
  expect(await reindexAll(1)).toBe(1);                 // батч из одного — проверяем постраничное копирование
  expect(await searchReady()).toBe(true);
  expect(await searchIds('встреч', [ab], { limit: 10 })).toEqual([m1.id]);
  const indexes = await meili<{ results: { uid: string }[] }>('/indexes?limit=100');
  expect(indexes.results.map((i) => i.uid).filter((u) => u.startsWith('relay_test_messages'))).toEqual(['relay_test_messages']);
  expect((await sql`select count(*)::int as n from server_meta where k = 'search_building'`)[0].n).toBe(0);
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `docker compose --profile test run --rm test bun test meili`
Expected: FAIL — `reindexAll is not exported`.

- [ ] **Step 3: Перестройка**

Дописать в `apps/server/src/search/messagesIndex.ts`:

```ts
/**
 * Полная перестройка: новый индекс рядом с живым, пока старый отвечает на запросы. На время копирования
 * search.sync пишет в оба (server_meta.search_building), поэтому изменения во время копирования не теряются.
 * Затем swap и удаление старого. Редкий случай: правка, пришедшая между чтением страницы и её записью,
 * может быть перезаписана старым текстом — исправится следующим изменением сообщения или перестройкой.
 */
export async function reindexAll(batch = 1000): Promise<number> {
  const live = liveIndex(), next = live + '_next';
  await meili(`/indexes/${next}`, { method: 'DELETE' }).then((t: any) => waitTask(t.taskUid), () => {});
  await ensureIndex(live);                       // для swap нужны оба
  await ensureIndex(next);
  await sql`insert into server_meta (k, v) values ('search_building', ${next}) on conflict (k) do update set v = excluded.v`;
  let count = 0;
  try {
    for (let after = 0; ;) {
      const rows = await sql`select id, chat_id, body, deleted, service_type, attachment from messages where id > ${after} order by id limit ${batch}`;
      if (!rows.length) break;
      after = Number(rows[rows.length - 1].id);
      const docs = rows.map(docOf).filter((d): d is Doc => d !== null);
      if (docs.length) await waitTask((await meili<{ taskUid: number }>(`/indexes/${next}/documents`, { method: 'POST', body: docs })).taskUid, 120_000);
      count += docs.length;
    }
    await waitTask((await meili<{ taskUid: number }>('/swap-indexes', { method: 'POST', body: [{ indexes: [live, next] }] })).taskUid);
    await waitTask((await meili<{ taskUid: number }>(`/indexes/${next}`, { method: 'DELETE' })).taskUid);
    await sql`insert into server_meta (k, v) values ('search_index', ${String(SEARCH_INDEX_VERSION)}) on conflict (k) do update set v = excluded.v`;
  } finally {
    await sql`delete from server_meta where k = 'search_building'`;
  }
  return count;
}

/** Воркер при старте: индекс не той версии (или его нет) — одна задача перестройки на систему. */
export async function scheduleReindexIfStale(): Promise<void> {
  if (await searchReady()) return;
  const { enqueue } = await import('../jobs/queue');
  await enqueue(sql, 'search.reindex', {}, { dedupeKey: 'search.reindex', maxAttempts: 5 });
}
```

- [ ] **Step 4: Задачи и запуск**

`apps/server/src/jobs/kinds.ts`:

```ts
import { reindexAll, syncMessage } from '../search/messagesIndex';

// сообщение создано, изменено или удалено: привести индекс к текущей строке (идемпотентно)
register('search.sync', async (p: { id: number }) => {
  await syncMessage(p.id);
});

register('search.reindex', async () => {
  const n = await reindexAll();
  console.log(`search: reindexed ${n} messages`);
});
```

`apps/server/src/worker.ts`, перед `startWorker`:

```ts
import { scheduleReindexIfStale } from './search/messagesIndex';

await scheduleReindexIfStale().catch((e) => console.error('search: cannot schedule reindex:', e));
```

`apps/server/src/dev/seed.ts`: после массовой вставки сообщений (строка с `insert into messages ${sql(batch, …)}` и цикла вокруг неё) поставить перестройку и сбросить готовность, чтобы поиск до её окончания шёл по Postgres:

```ts
  await sql`delete from server_meta where k = 'search_index'`;
  await enqueue(sql, 'search.reindex', {}, { dedupeKey: 'search.reindex' });
```

(импорт `enqueue` из `'../jobs/queue'`).

- [ ] **Step 5: Тесты не включают Meilisearch случайно**

В `apps/server/test/helpers.ts` и `packages/sync-engine/test/helpers.ts`, в `resetDb` после `truncate`:

```ts
  // поиск — по Postgres, пока тест сам не построит индекс (meili.test.ts)
  await sql`delete from server_meta where k in ('search_index', 'search_building')`;
```

- [ ] **Step 6: Тесты проходят**

Run: `docker compose --profile test run --rm test bun test meili`
Expected: PASS, 4 теста.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/search/messagesIndex.ts apps/server/src/jobs/kinds.ts apps/server/src/worker.ts apps/server/src/dev/seed.ts apps/server/test packages/sync-engine/test/helpers.ts
git commit -m "feat(server): full search reindex beside the live index with swap; worker schedules it when the index is stale"
```

---

### Task 4: Индексация из транзакций и поиск через Meilisearch с запасным путём

**Files:**
- Modify: `apps/server/src/domain/messages.ts` (транзакция `sendMessage`)
- Modify: `apps/server/src/domain/service.ts` (`postService`)
- Modify: `apps/server/src/domain/messageOps.ts` (`editMessage`, `deleteMessage`)
- Modify: `apps/server/src/domain/search.ts`
- Modify: `apps/server/test/search.test.ts`
- Test: `apps/server/test/meili.test.ts` (дописать)

**Interfaces:**
- Consumes: Task 2–3; `enqueue` (этап 1), `drainJobs` (этап 1).
- Produces:
  - `searchMessages(userId, q, opts)` — прежняя сигнатура и форма ответа
  - `searchPostgres(userId, q, opts)` — прежняя реализация под новым именем (экспорт для тестов)

- [ ] **Step 1: Тесты**

`apps/server/test/search.test.ts`: заменить импорт и вызовы `searchMessages` на `searchPostgres` (это тест прежнего поведения — подстрока; он остаётся как тест запасного пути).

Дописать в `apps/server/test/meili.test.ts`:

```ts
import '../src/jobs/kinds';
import { drainJobs } from '../src/jobs/worker';
import { searchMessages } from '../src/domain/search';

test('end to end: send/edit/delete enqueue sync jobs; search goes to Meilisearch once ready, rechecks access in Postgres', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  await reindexAll();                                        // пустой индекс, готов
  const m1 = await say(a, ab, 'встреча в пятницу');
  await say(b, bc, 'встреча без a');
  const m3 = await say(b, ab, 'перенесли встречу');
  expect((await sql`select count(*)::int as n from jobs where kind = 'search.sync'`)[0].n).toBe(3);
  await drainJobs();

  const res = await searchMessages(a, 'встреч');
  expect(res.hits.map((h) => h.message.id)).toEqual([m3.id, m1.id]);   // чужой чат не виден
  expect(res.hits[0].chatTitle).toBe('b');

  await deleteMessage(b, ab, m3.id);
  await drainJobs();
  expect((await searchMessages(a, 'встреч')).hits.map((h) => h.message.id)).toEqual([m1.id]);

  // вышла из чата — даже если индекс отстал, перепроверка в Postgres не отдаст чужое
  await sql`delete from chat_members where chat_id = ${ab} and user_id = ${a}`;
  expect((await searchMessages(a, 'встреч')).hits).toEqual([]);
});

test('Meilisearch down or index not ready: search falls back to Postgres substring search', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const m = await say(a, ab, 'перенесли');
  expect((await searchMessages(a, 'ес')).hits.map((h) => h.message.id)).toEqual([m.id]);   // не готов — подстрока
  await reindexAll();
  const url = process.env.MEILI_URL;
  process.env.MEILI_URL = 'http://127.0.0.1:1';            // «упал»
  try {
    expect((await searchMessages(a, 'ес')).hits.map((h) => h.message.id)).toEqual([m.id]);
  } finally {
    process.env.MEILI_URL = url;
  }
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `docker compose --profile test run --rm test bun test meili search`
Expected: FAIL — `searchPostgres is not exported` и счётчик задач `search.sync` = 0.

- [ ] **Step 3: Задачи в транзакциях**

Импорт во всех трёх файлах: `import { enqueue } from '../jobs/queue';` (если ещё нет).

- `messages.ts`, внутри `sql.begin` после `enqueue(tx, 'push.message', …)`: `await enqueue(tx, 'search.sync', { id: message.id });`
- `service.ts`, в `postService` после постановки `push.message`: `await enqueue(tx, 'search.sync', { id: message.id });` (код входа обработчик сам не проиндексирует).
- `messageOps.ts`, `editMessage`: после `fanOut` — `await enqueue(tx, 'search.sync', { id });`
- `messageOps.ts`, `deleteMessage`: после `fanOut` — `await enqueue(tx, 'search.sync', { id });`

Run: `grep -rn "update messages set body\|insert into messages" apps/server/src`
Expected: у каждого места, меняющего `body`, `deleted` или создающего сообщение (кроме `dev/seed.ts`, где перестройка), рядом стоит `search.sync`.

- [ ] **Step 4: Поиск**

`apps/server/src/domain/search.ts`:
1. Переименовать нынешнюю функцию `searchMessages` в `searchPostgres` (тело без изменений).
2. Добавить новую `searchMessages`:

```ts
import { searchIds, searchReady } from '../search/messagesIndex';

/**
 * Поиск сообщений: по индексу Meilisearch (слова и их начало, опечатки), новые сверху. Индекс не знает прав:
 * фильтр — чаты пользователя из Postgres, найденное перепроверяется в Postgres (членство, не удалено).
 * Индекс не готов или недоступен — прежний поиск подстроки по Postgres.
 */
export async function searchMessages(userId: number, q: string, opts: { chatId?: number; beforeId?: number; limit?: number } = {}): Promise<{ hits: SearchHit[]; hasMore: boolean }> {
  const text = q.trim();
  if (text.length < 2) throw new DomainError('bad_frame', 'query too short');
  if (text.length > 100) throw new DomainError('too_long');
  if (opts.chatId) await assertMember(sql, opts.chatId, userId);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  let ids: number[];
  try {
    if (!(await searchReady())) return searchPostgres(userId, q, opts);
    const chatIds = opts.chatId ? [opts.chatId] : (await sql`select chat_id from chat_members where user_id = ${userId}`).map((r) => Number(r.chat_id));
    ids = await searchIds(text, chatIds, { beforeId: opts.beforeId, limit });
  } catch (e) {
    console.warn('search: meilisearch unavailable, using postgres:', String(e));
    return searchPostgres(userId, q, opts);
  }
  const more = ids.length > limit;
  const page = ids.slice(0, limit);
  if (!page.length) return { hits: [], hasMore: false };
  // те же поля и название чата, что у searchPostgres; права и «не удалено» — заново
  const rows = await sql`
    select m.*,
           coalesce(c.title, (select ${nameForSql(userId)}
                                from chat_members pm join users u on u.id = pm.user_id
                               where c.kind = 'direct' and pm.chat_id = c.id and pm.user_id <> ${userId} limit 1)) as chat_title
      from messages m
      join chat_members cm on cm.chat_id = m.chat_id and cm.user_id = ${userId}
      join chats c on c.id = m.chat_id
     where m.id = any(${page}::bigint[]) and not m.deleted`;
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const ordered = page.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
  const messages = await withReactions(ordered.map(toMessage));
  return { hits: messages.map((message, i) => ({ message, chatTitle: (ordered[i].chat_title as string | null) ?? null })), hasMore: more };
}
```

Если в пользователе тысячи чатов, фильтр `chatId IN [...]` длинный, но Meilisearch его принимает; при заметном замедлении — отдельная задача (фильтр по «тенантам»), в этот этап не входит.

- [ ] **Step 5: Тесты проходят**

Run: `docker compose --profile test run --rm test && docker compose --profile test run --rm test-engine`
Expected: 0 fail. Тесты движка ищут через `/search` при неготовом индексе (resetDb снимает готовность) — по Postgres, как раньше.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/domain/messages.ts apps/server/src/domain/service.ts apps/server/src/domain/messageOps.ts apps/server/src/domain/search.ts apps/server/test/search.test.ts apps/server/test/meili.test.ts
git commit -m "feat(server): message search through Meilisearch, kept in sync by jobs, access rechecked in Postgres, Postgres fallback"
```

---

### Task 5: Проверка целиком

- [ ] **Step 1: Оба набора**

Run: `docker compose --profile test run --rm test && docker compose --profile test run --rm test-engine`
Expected: 0 fail.

- [ ] **Step 2: Стенд**

Run: `docker compose up -d --build && sleep 8 && docker compose logs worker --tail 10`
Expected: `relay worker started` и `search: reindexed N messages` (N — сообщений в dev-базе без удалённых и кодов входа).

Run: `docker compose exec -T postgres psql -U relay -d relay -tAc "select v from server_meta where k = 'search_index'"`
Expected: `1`.

- [ ] **Step 3: В браузере**

Playwright или chrome-devtools, изолированный контекст, вход через `POST /dev/login` пользователем с историей. Проверить:
- глобальный поиск по слову и по началу слова находит сообщения, новые сверху;
- поиск с опечаткой («встерча») находит «встреча»;
- поиск внутри чата ограничен этим чатом;
- новое сообщение находится поиском через секунду-две (задача `search.sync` выполнена воркером);
- удалённое сообщение больше не находится;
- `docker compose stop search` → поиск продолжает работать (по Postgres, подстрока), в логах сервера `search: meilisearch unavailable`; `docker compose start search` → снова Meilisearch.

- [ ] **Step 4: Итог для пользователя**

Коммиты, числа тестов, что проверено, что нет, и отдельной строкой — изменение поведения (слова и их начало вместо любой подстроки). В master не сливать без слова пользователя.

---

## Что не входит в этап

- Подсветка найденного силами Meilisearch (`_formatted`) — клиент подсвечивает сам, как сейчас.
- Поиск по людям и чатам (имена, @username) — отдельный индекс, отдельная задача.
- Фильтры в интерфейсе (по отправителю, датам, типам вложений).
- Перенос локального офлайн-поиска клиента — он не меняется.
- Тенантные токены Meilisearch и прямые запросы клиента в Meilisearch — запросы идут только через сервер.

## Риски

- **Индекс отстал** (воркер стоит, Meilisearch был недоступен): новое сообщение какое-то время не находится; задачи `search.sync` копятся и выполнятся позже. Чужое или удалённое не покажется никогда — перепроверка в Postgres.
- **Перестройка большой базы** занимает минуты; всё это время поиск идёт по старому индексу (или по Postgres, если индекса ещё нет).
- **Гонка правки с копированием при перестройке** может оставить старый текст в индексе до следующей правки сообщения — записано в комментарии к `reindexAll`.
- **Изменилось поведение поиска** (см. таблицу выше): если пользователю нужна именно подстрока, вернуть её можно запасным путём Postgres по флагу — в этот этап не входит.
