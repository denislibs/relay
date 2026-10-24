import { sql } from '../db';
import { key, valkey } from '../valkey';
import { DomainError } from './errors';
import { groupCtx } from './groupRights';

/**
 * Просмотры постов канала: POST /chats/:id/views {ids}. Один подписчик — один просмотр поста за сутки: Valkey-набор
 * seen:<user>:<chat> (TTL 24 ч с создания) говорит, какие id новые, и только они прибавляются — одним запросом в
 * узкую message_views. Лимит — запрос в секунду на пользователя (клиент шлёт батч раз в секунду). Событий в журнал
 * нет: число приходит с историей и ответом на этот запрос (клиент держит только рост).
 */
export const VIEWS = { max: 100, perSec: 1, seenTtlSec: 86_400 };

// добавить ids в набор и вернуть только новые; TTL — при создании набора (сутки с первого просмотра в этом чате)
const SEEN = `
local added = {}
for i = 1, #ARGV - 1 do
  if redis.call('SADD', KEYS[1], ARGV[i]) == 1 then added[#added + 1] = ARGV[i] end
end
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[#ARGV]) end
return added`;
const RATE = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], 1) end
return n`;

export async function countViews(userId: number, chatId: number, raw: unknown): Promise<{ views: [number, number][] }> {
  if (!Array.isArray(raw)) throw new DomainError('bad_frame', 'ids');
  if (raw.length > VIEWS.max) throw new DomainError('too_long', 'ids');
  const asked = [...new Set(raw.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const ctx = await groupCtx(sql, chatId, userId);
  if (ctx.kind !== 'channel') throw new DomainError('bad_frame', 'not a channel');
  let n = 0;
  try { n = Number(await valkey().send('EVAL', [RATE, '1', key(`views:rate:${userId}`)])); }
  catch (e) { console.error('views: valkey unavailable:', (e as Error).message); }
  if (n > VIEWS.perSec) throw new DomainError('flood', 'views', 1);
  if (!asked.length) return { views: [] };
  // только посты этого канала, видимые подписчику; служебные и удалённые не считаются
  const posts = (await sql`
    select id from messages where chat_id = ${chatId} and id = any(${asked}::bigint[]) and id >= ${ctx.historyFrom}
       and post and not deleted and service_type is null`).map((r) => Number(r.id));
  if (!posts.length) return { views: [] };
  let fresh: number[] = [];
  try {
    const added = (await valkey().send('EVAL', [SEEN, '1', key(`seen:${userId}:${chatId}`), ...posts.map(String), String(VIEWS.seenTtlSec)])) as string[] | null;
    fresh = (added ?? []).map(Number);
  } catch (e) {
    // без Valkey не отличить повтор от нового — не считаем вовсе (лучше недосчитать, чем накрутить)
    console.error('views: valkey unavailable, not counting:', (e as Error).message);
  }
  if (fresh.length) {
    await sql`
      insert into message_views (chat_id, message_id, views)
      select ${chatId}, unnest(${fresh}::bigint[]), 1
      on conflict (chat_id, message_id) do update set views = message_views.views + 1`;
  }
  const rows = await sql`
    select p.id, coalesce(v.views, 0) as views from unnest(${posts}::bigint[]) as p(id)
      left join message_views v on v.chat_id = ${chatId} and v.message_id = p.id
     order by p.id`;
  return { views: rows.map((r) => [Number(r.id), Number(r.views)]) };
}
