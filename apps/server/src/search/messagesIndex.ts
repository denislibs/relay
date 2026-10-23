import { openRows } from '../domain/messageContent';
import { sql } from '../db';
import { indexName, meili, MeiliError, waitTask } from './meili';
import { indexTokens, queryTokens } from './tokens';

/**
 * Индекс сообщений: только то, по чему ищем, и id чата для фильтра. Прав доступа здесь нет — их проверяет
 * сервер (фильтр по чатам пользователя и перепроверка найденного в Postgres). Документ строится из текущей
 * строки messages, поэтому синхронизация идемпотентна и не зависит от порядка задач.
 */
// 2: вложения ищутся и по тегам трека (название, исполнитель) — смена версии перестраивает индекс
// 3: в индексе не текст, а HMAC-токены слов (search/tokens.ts) — перестройка убирает из Meilisearch открытый текст
export const SEARCH_INDEX_VERSION = 3;
export const liveIndex = (): string => indexName('messages');

const SETTINGS = {
  // b — токены текста, a — токены имени файла и тегов трека (search/tokens.ts)
  searchableAttributes: ['b', 'a'],
  filterableAttributes: ['chatId', 'id'],
  sortableAttributes: ['id'],
  // новые сверху, как в Telegram. Токены — случайные строки: опечаток и «начала токена» у них нет (начало слова —
  // отдельные токены префиксов), порядок токенов ничего не значит — без typo и proximity
  rankingRules: ['sort', 'words', 'attribute', 'exactness'],
  typoTolerance: { enabled: false },
  prefixSearch: 'disabled',
};

type Doc = { id: number; chatId: number; b: string; a: string };

export async function ensureIndex(uid: string): Promise<void> {
  try {
    await waitTask((await meili<{ taskUid: number }>('/indexes', { method: 'POST', body: { uid, primaryKey: 'id' } })).taskUid);
  } catch (e) {
    if (!(e instanceof MeiliError && e.code === 'index_already_exists')) throw e;
  }
  await waitTask((await meili<{ taskUid: number }>(`/indexes/${uid}/settings`, { method: 'PATCH', body: SETTINGS })).taskUid);
}

async function docOf(r: Record<string, unknown>): Promise<Doc | null> {
  if (r.deleted || r.service_type === 'login_code') return null;   // удалённые и коды входа не ищутся
  const a = r.attachment as { name?: string; title?: string; performer?: string } | null;
  const b = await indexTokens(r.body as string | null), att = await indexTokens(a?.name, a?.title, a?.performer);
  if (!b && !att) return null;
  return { id: Number(r.id), chatId: Number(r.chat_id), b, a: att };
}

/** Индексы, в которые пишем: живой и, пока идёт перестройка, строящийся. */
async function targets(): Promise<string[]> {
  const [b] = await sql`select v from server_meta where k = 'search_building'`;
  return b ? [liveIndex(), b.v as string] : [liveIndex()];
}

export function syncMessage(id: number): Promise<void> {
  return syncMessages([id]);
}

/**
 * Пачка сообщений (задачи search.sync): одно чтение строк, на каждый целевой индекс — один POST документов
 * и одно удаление пачкой, ожидание задач Meilisearch — разом. Задачи одного индекса Meilisearch выполняет
 * по порядку, поэтому удаление после upsert видит уже созданный индекс.
 */
export async function syncMessages(ids: number[]): Promise<void> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return;
  const rows = await sql`select id, chat_id, client_id, body, deleted, service_type, attachment, content from messages where id = any(${uniq}::bigint[])`;
  if (rows.length) await openRows(rows);   // текст открываем только чтобы посчитать токены: в индекс уходят токены
  const docs = (await Promise.all(rows.map(docOf))).filter((d): d is Doc => d !== null);
  const indexed = new Set(docs.map((d) => d.id));
  const gone = uniq.filter((id) => !indexed.has(id));
  const tasks: Promise<void>[] = [];
  for (const uid of await targets()) {
    // индекса может ещё не быть (перестройка впереди): Meilisearch создаст его сам, ключ — явно (id и chatId оба «*id»)
    if (docs.length) tasks.push(meili<{ taskUid: number }>(`/indexes/${uid}/documents?primaryKey=id`, { method: 'POST', body: docs }).then((t) => waitTask(t.taskUid)));
    if (gone.length) {
      tasks.push(meili<{ taskUid: number }>(`/indexes/${uid}/documents/delete-batch`, { method: 'POST', body: gone }).then((t) => waitTask(t.taskUid)).catch((e) => {
        // индекса ещё нет — убирать нечего (его построит перестройка)
        if (!(e instanceof MeiliError && e.code === 'index_not_found')) throw e;
      }));
    }
  }
  await Promise.all(tasks);
}

export async function searchIds(q: string, chatIds: number[], opts: { beforeId?: number; limit: number }): Promise<number[]> {
  if (!chatIds.length) return [];
  const tokens = await queryTokens(q);
  if (!tokens) return [];
  const filter = [`chatId IN [${chatIds.join(',')}]`];
  if (opts.beforeId) filter.push(`id < ${opts.beforeId}`);
  const res = await meili<{ hits: { id: number }[] }>(`/indexes/${liveIndex()}/search`, {
    method: 'POST',
    body: { q: tokens, filter, sort: ['id:desc'], limit: opts.limit + 1, attributesToRetrieve: ['id'], matchingStrategy: 'all' },
  });
  return res.hits.map((h) => Number(h.id));
}

export async function searchReady(): Promise<boolean> {
  const [r] = await sql`select v from server_meta where k = 'search_index'`;
  return r?.v === String(SEARCH_INDEX_VERSION);
}

/** Удалить индекс, если он есть: для несуществующего Meilisearch отвечает 202, а падает уже сама задача. */
async function dropIndex(uid: string): Promise<void> {
  try {
    await waitTask((await meili<{ taskUid: number }>(`/indexes/${uid}`, { method: 'DELETE' })).taskUid);
  } catch (e) {
    if (!(e instanceof MeiliError && e.code === 'index_not_found')) throw e;
  }
}

const setMeta = (k: string, v: string) => sql`insert into server_meta (k, v) values (${k}, ${v}) on conflict (k) do update set v = excluded.v`;

async function indexExists(uid: string): Promise<boolean> {
  try {
    await meili(`/indexes/${uid}`);
    return true;
  } catch (e) {
    if (e instanceof MeiliError && e.code === 'index_not_found') return false;
    throw e;
  }
}

/**
 * Полная перестройка, по шагам: новый индекс рядом с живым, пока старый отвечает на запросы.
 * Состояние — в server_meta: search_building (строящийся индекс) и search_reindex_after (курсор: id последнего
 * скопированного сообщения). Шаг копирует не больше maxBatches пачек и не дольше maxMs, поэтому укладывается
 * в аренду задачи; обрыв (перезапуск воркера) теряет только недописанную пачку — следующий шаг продолжит
 * с курсора, а повторно записанная пачка — тот же upsert по id, без дублей.
 * Всё время перестройки search.sync пишет в оба индекса, поэтому изменения уже скопированных сообщений не теряются.
 * Когда копировать больше нечего — swap, удаление старого, готовность (search_index).
 * Редкий случай: правка, пришедшая между чтением пачки и её записью, может быть перезаписана старым текстом —
 * исправится следующим изменением сообщения или перестройкой.
 */
export async function reindexStep(opts: { batch?: number; maxBatches?: number; maxMs?: number } = {}): Promise<{ done: boolean; copied: number }> {
  const batch = opts.batch ?? 1000, maxBatches = opts.maxBatches ?? 50, until = Date.now() + (opts.maxMs ?? 30_000);
  const live = liveIndex(), next = live + '_next';
  const [building] = await sql`select v from server_meta where k = 'search_building'`;
  const [cursor] = await sql`select v from server_meta where k = 'search_reindex_after'`;
  let after: number;
  if (building?.v === next && cursor && (await indexExists(next))) {
    after = Number(cursor.v);                    // продолжение: построенное не трогаем
    await ensureIndex(next);                     // настройки могли смениться вместе с версией
  } else {
    // начало (или обрыв прежней версии без курсора, или курсор без индекса): с нуля
    await sql`delete from server_meta where k = 'search_reindex_after'`;
    await dropIndex(next);
    await ensureIndex(live);                     // для swap нужны оба
    await ensureIndex(next);
    await setMeta('search_building', next);      // с этого момента search.sync пишет и в next
    await setMeta('search_reindex_after', '0');
    after = 0;
  }
  let copied = 0;
  for (let n = 0; n < maxBatches && Date.now() < until; n++) {
    const rows = await openRows(await sql`select id, chat_id, client_id, body, deleted, service_type, attachment, content from messages where id > ${after} order by id limit ${batch}`);
    if (!rows.length) {
      await waitTask((await meili<{ taskUid: number }>('/swap-indexes', { method: 'POST', body: [{ indexes: [live, next] }] })).taskUid);
      await dropIndex(next);
      await sql.begin(async (tx) => {
        await tx`insert into server_meta (k, v) values ('search_index', ${String(SEARCH_INDEX_VERSION)}) on conflict (k) do update set v = excluded.v`;
        await tx`delete from server_meta where k in ('search_building', 'search_reindex_after')`;
      });
      return { done: true, copied };
    }
    const docs = (await Promise.all(rows.map(docOf))).filter((d): d is Doc => d !== null);
    if (docs.length) await waitTask((await meili<{ taskUid: number }>(`/indexes/${next}/documents?primaryKey=id`, { method: 'POST', body: docs })).taskUid, 120_000);
    after = Number(rows[rows.length - 1].id);
    await setMeta('search_reindex_after', String(after));   // курсор — только после того, как пачка записана
    copied += docs.length;
  }
  return { done: false, copied };
}

/** Перестройка целиком, в этом процессе (тесты, скрипты); возвращает число документов, скопированных этим вызовом. */
export async function reindexAll(batch = 1000): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await reindexStep({ batch });
    total += r.copied;
    if (r.done) return total;
  }
}

/** Воркер при старте: индекс не той версии (или его нет) — одна задача перестройки на систему. */
export async function scheduleReindexIfStale(): Promise<void> {
  if (await searchReady()) return;
  const { enqueue } = await import('../jobs/queue');
  await enqueue(sql, 'search.reindex', {}, { dedupeKey: 'search.reindex', maxAttempts: 5 });
}
