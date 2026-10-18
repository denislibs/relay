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
