import { mentionsIn, type Block, type Entity } from '@relay/protocol';
import type { Tx } from '../db';
import { enqueue } from '../jobs/queue';
import { toMessage } from './chats';
import type { GroupCtx } from './groupRights';
import { appendUpdates } from './journal';

/**
 * Упоминания (как в Telegram): @имя в тексте вне кода и ссылок (MENTION_RE в protocol) и автор сообщения, на которое
 * ответили. Адресат — участник чата, не автор, не заблокировавший автора, ещё не прочитавший это место (основную ленту
 * или тред); в канале — только админы с правом post. Не больше MAX_MENTIONS на сообщение, лишние молча отбрасываются.
 * Строка message_mentions держит счётчик «@» в списке (unreadMentions) до прочтения; личная запись mention — ссылка
 * на сообщение (journal.ts stored/hydrate), push.mention — уведомление сквозь mute.
 * Личные чаты, служебные сообщения и копии постов в группе обсуждения упоминаний не создают.
 */
export const MAX_MENTIONS = 20;

/** row — открытая строка messages (после вставки или правки). Новые адресаты — их id (повтор правкой — без записи). */
export async function collectMentions(tx: Tx, ctx: GroupCtx, row: Record<string, unknown>): Promise<number[]> {
  if (ctx.kind === 'direct' || row.origin != null || row.service_type != null || row.deleted) return [];
  const chatId = Number(row.chat_id), id = Number(row.id), sender = Number(row.sender_id);
  const threadId = row.thread_id == null ? null : Number(row.thread_id);
  const names = mentionsIn(row.body as string, row.entities as Entity[] | null, row.blocks as Block[] | null).slice(0, MAX_MENTIONS);
  // ответ: автор исходного (пост и его копия — от имени канала, автора-админа не упоминаем)
  const replyTo = row.reply_to_id == null ? null : Number(row.reply_to_id);
  if (!names.length && replyTo == null) return [];
  // прочитанность — того места, где сообщение: тред (thread_reads) или основная лента (last_read_id)
  const rows = await tx`
    with cand as (
      select u.id, array_position(${names}::text[], lower(u.username)) as ord from users u where lower(u.username) = any(${names}::text[])
      union all
      select r.sender_id, 0 from messages r where ${replyTo}::bigint is not null and r.chat_id = ${chatId} and r.id = ${replyTo} and not r.post and r.service_type is null),
    who as (
      select c.id, min(c.ord) as ord from cand c
        join chat_members cm on cm.chat_id = ${chatId} and cm.user_id = c.id
       where c.id <> ${sender} and ${id} >= cm.history_from
         and not exists (select 1 from blocks b where b.owner_id = c.id and b.user_id = ${sender})
         and ${ctx.kind === 'channel'
           ? tx`(cm.role = 'owner' or (cm.role = 'admin' and coalesce(cm.admin_rights->>'post', '') = 'true'))`
           : tx`true`}
         and ${threadId == null
           ? tx`cm.last_read_id < ${id}`
           : tx`coalesce((select tr.read_max_id from thread_reads tr where tr.user_id = c.id and tr.chat_id = ${chatId} and tr.thread_id = ${threadId}), 0) < ${id}`}
       group by c.id
       order by min(c.ord), c.id
       limit greatest(0, ${MAX_MENTIONS} - (select count(*) from message_mentions mm where mm.chat_id = ${chatId} and mm.message_id = ${id})))   -- правка добавляет до общего предела
    insert into message_mentions (user_id, chat_id, message_id, thread_id)
    select id, ${chatId}, ${id}, ${threadId} from who
    on conflict do nothing
    returning user_id`;
  const ids = rows.map((r) => Number(r.user_id));
  if (!ids.length) return [];
  const message = toMessage(row);
  await appendUpdates(tx, ids.map((userId) => ({ userId, update: { type: 'mention' as const, message, ...(threadId != null ? { threadId } : {}) } })));
  for (const userId of ids) await enqueue(tx, 'push.mention', { chatId, id, userId });
  return ids;
}
