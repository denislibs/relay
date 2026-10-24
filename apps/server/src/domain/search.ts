import type { Message } from '@relay/protocol';
import { sql } from '../db';
import { nameForSql } from './profile';
import { assertMember, toMessage, withAllReactions } from './chats';
import { DomainError } from './errors';
import { searchIds, searchReady } from '../search/messagesIndex';
import { openRows, rowMatches, scanMatching, SCAN_BATCH } from './messageContent';

export interface SearchHit { message: Message; chatTitle: string | null }

/**
 * Поиск сообщений: по индексу Meilisearch (слова и их начало, опечатки), новые сверху, страницами по beforeId.
 * Индекс не знает прав: фильтр — чаты пользователя из Postgres, найденное перепроверяется в Postgres
 * (членство, не удалено). Индекс не готов или недоступен — прежний поиск подстроки по Postgres.
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
    const chatIds = opts.chatId ? [opts.chatId] : (await sql`select cm.chat_id from chat_members cm join chats c on c.id = cm.chat_id and c.deleted_at is null where cm.user_id = ${userId}`).map((r) => Number(r.chat_id));
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
      join chats c on c.id = m.chat_id and c.deleted_at is null   -- удалённый (мягко) чат не ищется
     where m.id = any(${page}::bigint[]) and not m.deleted`;
  await openRows(rows);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const ordered = page.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
  const messages = await withAllReactions(ordered.map(toMessage), userId);
  return { hits: messages.map((message, i) => ({ message, chatTitle: (ordered[i].chat_title as string | null) ?? null })), hasMore: more };
}

/**
 * Запасной поиск: подстрока без учёта регистра (индекс pg_trgm), новые сверху, страницами по beforeId.
 * Ищет в тексте и во вложении: имя файла, название и исполнитель трека (как индекс Meilisearch).
 * chatId — внутри одного чата; без него — по всем чатам пользователя. Удалённые не ищутся.
 */
export async function searchPostgres(userId: number, q: string, opts: { chatId?: number; beforeId?: number; limit?: number } = {}): Promise<{ hits: SearchHit[]; hasMore: boolean }> {
  const text = q.trim();
  if (text.length < 2) throw new DomainError('bad_frame', 'query too short');
  if (text.length > 100) throw new DomainError('too_long');
  if (opts.chatId) await assertMember(sql, opts.chatId, userId);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const pattern = '%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  // текст в шифре: зашифрованные строки — кандидаты, фильтр после расшифровки; старые открытые — подстрокой в SQL
  const { rows: page, more } = await scanMatching((before) => sql`
    select m.*,
           coalesce(c.title, (select ${nameForSql(userId)}
                                from chat_members pm join users u on u.id = pm.user_id
                               where c.kind = 'direct' and pm.chat_id = c.id and pm.user_id <> ${userId} limit 1)) as chat_title
      from messages m
      join chat_members cm on cm.chat_id = m.chat_id and cm.user_id = ${userId}
      join chats c on c.id = m.chat_id and c.deleted_at is null   -- удалённый (мягко) чат не ищется
     where not m.deleted
       and (m.content is not null or m.body ilike ${pattern}
            or (m.attachment is not null   -- то же выражение, что в индексе messages_attachment_trgm
                and (coalesce(m.attachment->>'name', '') || E'\n' || coalesce(m.attachment->>'title', '') || E'\n' || coalesce(m.attachment->>'performer', '')) ilike ${pattern}))
       ${opts.chatId ? sql`and m.chat_id = ${opts.chatId}` : sql``}
       ${before ? sql`and m.id < ${before}` : sql``}
     order by m.id desc
     limit ${SCAN_BATCH}`, (r) => rowMatches(r, text), limit, opts.beforeId ?? null);
  const messages = await withAllReactions(page.map(toMessage), userId);
  return { hits: messages.map((message, i) => ({ message, chatTitle: (page[i].chat_title as string | null) ?? null })), hasMore: more };
}
