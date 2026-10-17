import type { Message } from '@relay/protocol';
import { sql } from '../db';
import { nameForSql } from './profile';
import { assertMember, toMessage, withReactions } from './chats';
import { DomainError } from './errors';

export interface SearchHit { message: Message; chatTitle: string | null }

/**
 * Поиск сообщений: подстрока без учёта регистра (индекс pg_trgm), новые сверху, страницами по beforeId.
 * chatId — внутри одного чата; без него — по всем чатам пользователя. Удалённые не ищутся.
 */
export async function searchMessages(userId: number, q: string, opts: { chatId?: number; beforeId?: number; limit?: number } = {}): Promise<{ hits: SearchHit[]; hasMore: boolean }> {
  const text = q.trim();
  if (text.length < 2) throw new DomainError('bad_frame', 'query too short');
  if (text.length > 100) throw new DomainError('too_long');
  if (opts.chatId) await assertMember(sql, opts.chatId, userId);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const pattern = '%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = await sql`
    select m.*,
           coalesce(c.title, (select ${nameForSql(userId)}
                                from chat_members pm join users u on u.id = pm.user_id
                               where c.kind = 'direct' and pm.chat_id = c.id and pm.user_id <> ${userId} limit 1)) as chat_title
      from messages m
      join chat_members cm on cm.chat_id = m.chat_id and cm.user_id = ${userId}
      join chats c on c.id = m.chat_id
     where not m.deleted and m.body ilike ${pattern}
       ${opts.chatId ? sql`and m.chat_id = ${opts.chatId}` : sql``}
       ${opts.beforeId ? sql`and m.id < ${opts.beforeId}` : sql``}
     order by m.id desc
     limit ${limit + 1}`;
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const messages = await withReactions(page.map(toMessage));
  return { hits: messages.map((message, i) => ({ message, chatTitle: (page[i].chat_title as string | null) ?? null })), hasMore: more };
}
