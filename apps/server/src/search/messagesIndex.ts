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
    if (doc) {
      // индекса может ещё не быть (перестройка впереди): Meilisearch создаст его сам, ключ — явно (id и chatId оба «*id»)
      await waitTask((await meili<{ taskUid: number }>(`/indexes/${uid}/documents?primaryKey=id`, { method: 'POST', body: [doc] })).taskUid);
      continue;
    }
    try {
      await waitTask((await meili<{ taskUid: number }>(`/indexes/${uid}/documents/${id}`, { method: 'DELETE' })).taskUid);
    } catch (e) {
      // индекса ещё нет — убирать нечего (его построит перестройка)
      if (!(e instanceof MeiliError && e.code === 'index_not_found')) throw e;
    }
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

/** Удалить индекс, если он есть: для несуществующего Meilisearch отвечает 202, а падает уже сама задача. */
async function dropIndex(uid: string): Promise<void> {
  try {
    await waitTask((await meili<{ taskUid: number }>(`/indexes/${uid}`, { method: 'DELETE' })).taskUid);
  } catch (e) {
    if (!(e instanceof MeiliError && e.code === 'index_not_found')) throw e;
  }
}

/**
 * Полная перестройка: новый индекс рядом с живым, пока старый отвечает на запросы. На время копирования
 * search.sync пишет в оба (server_meta.search_building), поэтому изменения во время копирования не теряются.
 * Затем swap и удаление старого. Редкий случай: правка, пришедшая между чтением страницы и её записью,
 * может быть перезаписана старым текстом — исправится следующим изменением сообщения или перестройкой.
 */
export async function reindexAll(batch = 1000): Promise<number> {
  const live = liveIndex(), next = live + '_next';
  await dropIndex(next);
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
      if (docs.length) await waitTask((await meili<{ taskUid: number }>(`/indexes/${next}/documents?primaryKey=id`, { method: 'POST', body: docs })).taskUid, 120_000);
      count += docs.length;
    }
    await waitTask((await meili<{ taskUid: number }>('/swap-indexes', { method: 'POST', body: [{ indexes: [live, next] }] })).taskUid);
    await dropIndex(next);
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
