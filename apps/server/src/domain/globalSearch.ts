// Глобальный поиск (левая колонка, как в Telegram Web): медиа/ссылки/файлы/музыка/голосовые по всем чатам,
// люди по имени и «частые собеседники». Права — только чаты, где пользователь состоит; удалённое не отдаём.
import type { MediaTab, Message } from '@relay/protocol';
import { sql } from '../db';
import { tabWhere, toMessage, withAllReactions } from './chats';
import { DomainError } from './errors';
import { nameForSql } from './profile';
import { openRows, rowMatches, scanMatching, SCAN_BATCH } from './messageContent';

export interface GlobalHit { message: Message; chatTitle: string | null; chatKind: 'direct' | 'group' | 'channel' }

const like = (q: string) => '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';

/** Текстовый фильтр вкладки: у вложений — имя файла, название, исполнитель и подпись; у ссылок — текст сообщения.
 *  Зашифрованные строки проходят в кандидаты — их фильтрует rowMatches после расшифровки. */
function textWhere(tab: MediaTab, q: string) {
  const p = like(q);
  if (tab === 'link') return sql`and (content is not null or body ilike ${p})`;
  return sql`and (content is not null or body ilike ${p} or attachment->>'name' ilike ${p} or attachment->>'title' ilike ${p} or attachment->>'performer' ilike ${p})`;
}

/**
 * Вкладка медиа по всем чатам: новые сверху, страницами по id (before — id последнего показанного).
 * q — необязательный фильтр (как в Telegram: запрос сужает и медиа-вкладки).
 */
export async function searchMedia(userId: number, tab: MediaTab, opts: { q?: string; before?: number; limit?: number } = {}): Promise<{ hits: GlobalHit[]; hasMore: boolean }> {
  const q = (opts.q ?? '').trim();
  if (q.length > 100) throw new DomainError('too_long');
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const take = q ? SCAN_BATCH : limit + 1;
  const batch = (before: number | null) => sql`
    select m.*, c.kind as chat_kind,
           coalesce(c.title, (select ${nameForSql(userId)}
                                from chat_members pm join users u on u.id = pm.user_id
                               where c.kind = 'direct' and pm.chat_id = c.id and pm.user_id <> ${userId} limit 1)) as chat_title
      from (select * from messages
             where chat_id in (select cm.chat_id from chat_members cm join chats dc on dc.id = cm.chat_id and dc.deleted_at is null where cm.user_id = ${userId})
               and not deleted and ${tabWhere(tab)}
               ${q ? textWhere(tab, q) : sql``}
               ${before ? sql`and id < ${before}` : sql``}
             order by id desc limit ${take}) m
      join chats c on c.id = m.chat_id
     order by m.id desc`;
  let page: Record<string, unknown>[], hasMore: boolean;
  if (q) ({ rows: page, more: hasMore } = await scanMatching(batch, (r) => rowMatches(r, q, tab === 'link'), limit, opts.before ?? null));
  else { const rows = await batch(opts.before ?? null); page = await openRows(rows.slice(0, limit)); hasMore = rows.length > limit; }
  const messages = await withAllReactions(page.map(toMessage), userId);
  return {
    hits: messages.map((message, i) => ({ message, chatTitle: (page[i].chat_title as string | null) ?? null, chatKind: page[i].chat_kind as GlobalHit['chatKind'] })),
    hasMore,
  };
}

export interface PersonHit { id: number; name: string; username: string | null; photo: unknown; chatId: number | null }

/**
 * Люди по имени и @имени среди тех, кого пользователь уже видит (контакты и общие чаты), плюс точное @имя
 * среди всех — как «Глобальный поиск» в Telegram. Имя — глазами зрителя (контактное, если задано);
 * заблокировавшим зрителя фото не отдаём. chatId — личный чат с человеком, если он есть.
 */
export async function searchPeople(userId: number, raw: string, limit = 20): Promise<{ people: PersonHit[] }> {
  const q = raw.trim().replace(/^@/, '');
  if (q.length < 1) return { people: [] };
  if (q.length > 64) throw new DomainError('too_long');
  const p = like(q), exact = q.toLowerCase();
  const rows = await sql`
    with seen as (
      select b.user_id as id from chat_members a join chats c on c.id = a.chat_id and c.kind <> 'channel' join chat_members b on b.chat_id = a.chat_id where a.user_id = ${userId} and b.user_id <> ${userId}
      union select user_id from contacts where owner_id = ${userId}
    )
    select u.id, ${nameForSql(userId)} as name, u.username,
           case when exists (select 1 from blocks bl where bl.owner_id = u.id and bl.user_id = ${userId}) then null else u.photo end as photo,
           (select c.id from chats c join chat_members x on x.chat_id = c.id and x.user_id = ${userId}
                                     join chat_members y on y.chat_id = c.id and y.user_id = u.id
             where c.kind = 'direct' limit 1) as chat_id,
           (lower(u.username) = ${exact}) as exact
      from users u
     where u.id <> ${userId} and not coalesce(u.system, false)
       and ((u.id in (select id from seen) and (${nameForSql(userId)} ilike ${p} or u.name ilike ${p} or u.username ilike ${p}))   -- и контактное имя, и своё
            or lower(u.username) = ${exact})
     order by exact desc, (${nameForSql(userId)} ilike ${q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'}) desc, name
     limit ${Math.min(Math.max(limit, 1), 50)}`;
  return { people: rows.map((r) => ({ id: Number(r.id), name: r.name as string, username: (r.username as string | null) ?? null, photo: r.photo ?? null, chatId: r.chat_id != null ? Number(r.chat_id) : null })) };
}

/** «Частые собеседники»: личные чаты с наибольшим числом сообщений за 30 дней (как Top people в Telegram). */
export async function topPeers(userId: number, limit = 10): Promise<{ chatIds: number[] }> {
  const rows = await sql`
    select m.chat_id, count(*) as n
      from messages m
      join chat_members cm on cm.chat_id = m.chat_id and cm.user_id = ${userId}
      join chats c on c.id = m.chat_id and c.kind = 'direct'
     where m.created_at > now() - interval '30 days' and not m.deleted
       and not exists (select 1 from service_chats s where s.chat_id = m.chat_id)
     group by m.chat_id order by n desc limit ${limit}`;
  return { chatIds: rows.map((r) => Number(r.chat_id)) };
}
