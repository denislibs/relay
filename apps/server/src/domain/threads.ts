import type { Message } from '@relay/protocol';
import { beforeCommit, sql, type Tx } from '../db';
import { enqueue } from '../jobs/queue';
import { readOwnPost, toMessage, withAllReactions } from './chats';
import { DomainError } from './errors';
import { appendUpdates, chatEvent } from './journal';
import { contentColumns, openRows } from './messageContent';
import { groupCtx } from './groupRights';

/**
 * Комментарии к постам канала (как в Telegram): корень треда — копия поста в группе обсуждения (linked_chat_id).
 * Копия — обычное сообщение группы (её лента, unread, журнал), но с origin = {chatId: канал, id: пост} и post = true:
 * из группы её не правят, не удаляют и не отмечают чек-лист — всё идёт через пост (withCopy в той же транзакции).
 * Комментарий — сообщение группы с thread_id = id копии. Счётчики треда — message_threads (chat_id — канал) под
 * замком строки; событие replies в журнал канала — задачей replies.flush раз в секундное окно (как reactions.flush).
 */

/** Копия поста в группе обсуждения — в транзакции поста. post — вставленная строка, уже открытая (openRows). */
export async function copyPost(tx: Tx, channelId: number, post: Record<string, unknown>, authorId: number): Promise<void> {
  const [g] = await tx`select l.id from chats c join chats l on l.id = c.linked_chat_id and l.deleted_at is null and l.kind = 'group' where c.id = ${channelId}`;
  if (!g) return;
  const groupId = Number(g.id), clientId = crypto.randomUUID();
  const attachment = (post.attachment as Record<string, unknown> | null) ?? null;
  // вложение — тот же объект (fileFor отдаёт его участнику группы через копию); строка — for share, как у пересылки
  if (attachment && !(await tx`select 1 from attachments where id = ${attachment.id as string} for share`).length) return;
  // содержимое — заново шифром ключа группы: блоб канала в группе не откроется (AAD — чат и client_id)
  const c = await contentColumns(groupId, clientId, {
    body: post.body as string, entities: (post.entities as unknown[] | null) ?? null, todo: post.todo ?? null,
    blocks: (post.blocks as unknown[] | null) ?? null, link: post.link ?? null, attachment,
  }, tx);
  const [row] = await tx`
    insert into messages (chat_id, sender_id, client_id, kind, body, entities, attachment, group_id, fwd_from, link, blocks, todo, sticker, content, has_link, post, post_author, origin)
    values (${groupId}, ${authorId}, ${clientId}, ${post.kind as string}, ${c.body}, ${c.entities?.length ? sql.json(c.entities as never) : null}, ${c.attachment ? sql.json(c.attachment as never) : null},
            ${(post.group_id as string | null) ?? null}, ${post.fwd_from ? sql.json(post.fwd_from as never) : null}, ${c.link ? sql.json(c.link as never) : null}, ${c.blocks ? sql.json(c.blocks as never) : null},
            ${c.todo ? sql.json(c.todo as never) : null}, ${post.sticker ? sql.json(post.sticker as never) : null}, ${c.content}, ${c.hasLink}, true, ${(post.post_author as string | null) ?? null},
            ${sql.json({ chatId: channelId, id: Number(post.id) } as never)})
    returning *`;
  const copy = toMessage((await openRows([row], '', tx))[0]);
  await chatEvent(tx, groupId, { type: 'newMessage', message: copy }, 'group');
  // альбом (общий group_id): тред один — у копии первого поста альбома; копии остальных — части того же пузыря в
  // группе, но не корни (send {threadId} их не примет), строки их постов указывают на ту же копию
  const [first] = post.group_id ? await tx`
    select t.copy_id from messages p join message_threads t on t.chat_id = p.chat_id and t.post_id = p.id
     where p.chat_id = ${channelId} and p.group_id = ${post.group_id as string} and p.id < ${Number(post.id)}
       and (select cp.chat_id from messages cp where cp.id = t.copy_id) = ${groupId}
     order by p.id limit 1` : [];
  const root = first ? Number(first.copy_id) : copy.id;
  const [cur] = root !== copy.id ? await tx`select count, last_id, recent from message_threads where chat_id = ${channelId} and copy_id = ${root} limit 1` : [];
  await tx`insert into message_threads (chat_id, post_id, copy_id, count, last_id, recent)
           values (${channelId}, ${Number(post.id)}, ${root}, ${cur ? Number(cur.count) : 0}, ${cur?.last_id ?? null}, ${(cur?.recent as unknown[] | undefined)?.map(Number) ?? []}::bigint[])
           on conflict (chat_id, post_id) do update set copy_id = excluded.copy_id`;
  // автору своя копия — не непрочитанная (senderId у неё 0, как у поста): last_read_id и readOwn своим устройствам.
  // Только если до копии в группе всё прочитано: иначе прыжок last_read_id «прочитал» бы чужие сообщения перед ней
  const [caught] = await tx`
    select 1 from chat_members cm where cm.chat_id = ${groupId} and cm.user_id = ${authorId}
       and cm.last_read_id >= coalesce((select max(m.id) from messages m where m.chat_id = ${groupId} and m.id < ${copy.id} and (m.sender_id <> ${authorId} or m.post)), 0)`;
  if (caught) await readOwnPost(tx, groupId, authorId, copy.id);
  // push группы для копии пропускает подписчиков канала (kinds.ts → planPush excludeChatId): одно уведомление на пост
  await enqueue(tx, 'push.message', { chatId: groupId, id: copy.id });
  await enqueue(tx, 'search.sync', { id: copy.id });   // индекс копию пропускает (её находят как пост канала)
  // упоминаний копия не создаёт (mentions.ts: origin) — их создаёт только пост
}

/**
 * Копия поста (если пост ушёл в группу обсуждения и она жива): fn(группа, id копии). Правки, удаление, превью ссылки и
 * чек-листы поста делают то же с копией в своей транзакции — копия не расходится с постом. Замок строки поста уже
 * взят вызывающим; строку копии запирает fn (updateContent) — порядок всегда «пост → копия».
 */
export async function withCopy(tx: Tx, channelId: number, postId: number, fn: (groupId: number, copyId: number) => Promise<void>): Promise<void> {
  // копия — по origin (индекс messages_origin), не по message_threads: у постов альбома тред общий (копия первого),
  // а своя копия у каждого
  const [t] = await tx`
    select m.chat_id, m.id from messages m
      join chats c on c.id = m.chat_id and c.deleted_at is null
     where m.origin->>'chatId' = ${String(channelId)} and m.origin->>'id' = ${String(postId)} and not m.deleted
     order by m.id limit 1`;
  if (t) await fn(Number(t.chat_id), Number(t.id));
}

/** Тред копии: канал и пост по origin копии (ключ message_threads). null — это не копия. */
async function threadKey(tx: Tx, groupId: number, copyId: number): Promise<{ channelId: number; postId: number } | null> {
  const [r] = await tx`select origin from messages where chat_id = ${groupId} and id = ${copyId}`;
  const o = r?.origin as { chatId?: unknown; id?: unknown } | null | undefined;
  return o ? { channelId: Number(o.chatId), postId: Number(o.id) } : null;
}

/** Корень ли треда эта копия: строка message_threads её поста указывает на неё (копия не первого поста альбома — нет). */
export async function isThreadRoot(db: Tx | typeof sql, origin: unknown, copyId: number): Promise<boolean> {
  const o = origin as { chatId?: unknown; id?: unknown } | null;
  if (!o) return false;
  return (await db`select 1 from message_threads where chat_id = ${Number(o.chatId)} and post_id = ${Number(o.id)} and copy_id = ${copyId}`).length > 0;
}

/** Тред в текущей группе обсуждения канала: после перепривязки комментарии старой группы событий replies не шлют. */
async function linkedNow(tx: Tx, channelId: number, copyId: number): Promise<boolean> {
  const [r] = await tx`select 1 from chats c join messages m on m.id = ${copyId} and m.chat_id = c.linked_chat_id where c.id = ${channelId}`;
  return !!r;
}

/** replies.flush на секундное окно: w — по часам базы ПОСЛЕ замка строки message_threads (см. reactionCounts.ts). */
async function scheduleReplies(tx: Tx, channelId: number, postId: number): Promise<void> {
  const [{ w }] = await tx`select floor(extract(epoch from clock_timestamp()))::bigint as w`;
  const sec = Number(w);
  await enqueue(tx, 'replies.flush', { chatId: channelId, postId }, { dedupeKey: `replies:${channelId}:${postId}:${sec}`, runAt: new Date((sec + 1) * 1000) });
}

/** Новый комментарий (в транзакции sendMessage): счётчики треда, моя прочитанность треда, replies.flush. */
export async function noteComment(tx: Tx, groupId: number, copyId: number, senderId: number, id: number): Promise<void> {
  const key = await threadKey(tx, groupId, copyId);
  // счётчики — перед коммитом, раньше журналов: строка треда одна на все комментарии поста, и её замок живёт от
  // update до коммита, а не с середины sendMessage (упоминания, черновик, задачи) — иначе комментарии в один тред
  // стоят в очереди за этим замком. Порядок замков прежний: строка треда → журналы
  if (key) beforeCommit(tx, async () => {
    // update запирает строку; recent — комментатор впереди, без повторов, не больше трёх
    // все посты треда (альбом — несколько строк с одной копией): строки по порядку post_id — один порядок замков
    const up = await tx`
      update message_threads set count = count + 1, last_id = greatest(coalesce(last_id, 0), ${id}),
             recent = (array[${senderId}::bigint] || array_remove(recent, ${senderId}::bigint))[1:3]
       where chat_id = ${key.channelId} and post_id in (select post_id from message_threads where chat_id = ${key.channelId} and copy_id = ${copyId} order by post_id for update)
       returning 1`;
    if (up.length && await linkedNow(tx, key.channelId, copyId)) await scheduleReplies(tx, key.channelId, key.postId);
  }, { first: true });
  // свой комментарий — тред прочитан до него (на всех моих устройствах)
  await markThreadReadTx(tx, senderId, groupId, copyId, id);
}

/** Комментарий удалён: счётчики треда пересчитать по сообщениям (count, max id, последние 3 различных автора). */
export async function recountThread(tx: Tx, groupId: number, copyId: number): Promise<void> {
  const key = await threadKey(tx, groupId, copyId);
  if (!key) return;
  const t = await tx`select post_id from message_threads where chat_id = ${key.channelId} and copy_id = ${copyId} order by post_id for update`;
  if (!t.length) return;
  const [agg] = await tx`select count(*)::int as n, max(id) as last from messages where chat_id = ${groupId} and thread_id = ${copyId} and not deleted`;
  const recent = await tx`
    select sender_id from messages where chat_id = ${groupId} and thread_id = ${copyId} and not deleted
     group by sender_id order by max(id) desc limit 3`;
  await tx`update message_threads set count = ${agg.n}, last_id = ${agg.last ?? null}, recent = ${recent.map((r) => Number(r.sender_id))}::bigint[]
            where chat_id = ${key.channelId} and copy_id = ${copyId}`;
  if (await linkedNow(tx, key.channelId, copyId)) await scheduleReplies(tx, key.channelId, key.postId);
}

/** Задача replies.flush: счётчики треда событием replies на каждый пост треда (альбом — на каждый) в журнал канала.
 *  Строки — for share: смена до чтения учтена. */
export async function flushReplies(p: { chatId: number; postId: number }): Promise<void> {
  const chatId = Number(p.chatId), postId = Number(p.postId);
  await sql.begin(async (tx) => {
    const rows = await tx`
      select t.post_id, t.count, t.last_id, t.recent, c.deleted_at from message_threads t join chats c on c.id = t.chat_id
       where t.chat_id = ${chatId} and t.copy_id = (select copy_id from message_threads where chat_id = ${chatId} and post_id = ${postId})
         and exists (select 1 from messages lm join chats lc on lc.id = t.chat_id where lm.id = t.copy_id and lm.chat_id = lc.linked_chat_id)   -- перепривязали, пока задача ждала: тред старой группы молчит
       order by t.post_id for share of t`;
    if (!rows.length || rows[0].deleted_at) return;
    for (const t of rows) await chatEvent(tx, chatId, {
      type: 'replies', chatId, id: Number(t.post_id), count: Number(t.count), lastId: t.last_id == null ? null : Number(t.last_id), recent: (t.recent as (number | string)[]).map(Number),
    }, 'channel');
  });
}

/** Корень треда в группе: копия поста; удалённая — тоже (тред читается с шапкой «пост удалён»). */
async function threadRoot(db: Tx | typeof sql, groupId: number, copyId: number): Promise<Record<string, unknown>> {
  const [h] = await db`select * from messages where chat_id = ${groupId} and id = ${copyId} and origin is not null`;
  if (!h || !(await isThreadRoot(db, h.origin, copyId))) throw new DomainError('not_found', 'thread');
  return h;
}

export const THREAD_PAGE_MAX = 200;

/**
 * Страница треда (участник группы): шапка — копия поста (и удалённая), комментарии по возрастанию id — before (старее
 * него, с конца) или after (новее него). Видимые участнику — с history_from (общий count на кнопке может быть больше).
 */
export async function getThread(userId: number, groupId: number, copyId: number, before: number | null, limit: number, after: number | null = null): Promise<{ header: Message; messages: Message[]; hasMore: boolean }> {
  const ctx = await groupCtx(sql, groupId, userId);
  const take = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), THREAD_PAGE_MAX);
  const h = await threadRoot(sql, groupId, copyId);
  let rows: Record<string, unknown>[], hasMore: boolean;
  if (after != null) {
    const up = await sql`
      select * from messages where chat_id = ${groupId} and thread_id = ${copyId} and id > ${after} and id >= ${ctx.historyFrom}
       order by id limit ${take + 1}`;
    rows = up.slice(0, take); hasMore = up.length > take;
  } else {
    const down = await sql`
      select * from messages where chat_id = ${groupId} and thread_id = ${copyId} and (${before}::bigint is null or id < ${before}) and id >= ${ctx.historyFrom}
       order by id desc limit ${take + 1}`;
    rows = down.slice(0, take).reverse(); hasMore = down.length > take;
  }
  const [header, ...messages] = await withAllReactions((await openRows([h, ...rows])).map(toMessage), userId);
  return { header, messages, hasMore };
}

/** Прочитанность треда — только растёт; изменилась — readThread моим устройствам (личный журнал). */
async function markThreadReadTx(tx: Tx, userId: number, groupId: number, copyId: number, upToId: number): Promise<boolean> {
  const up = await tx`
    insert into thread_reads (user_id, chat_id, thread_id, read_max_id) values (${userId}, ${groupId}, ${copyId}, ${upToId})
    on conflict (user_id, chat_id, thread_id) do update set read_max_id = excluded.read_max_id where thread_reads.read_max_id < excluded.read_max_id
    returning 1`;
  if (!up.length) return false;
  await tx`delete from message_mentions where user_id = ${userId} and chat_id = ${groupId} and thread_id = ${copyId} and message_id <= ${upToId}`;   // упоминания треда прочитаны
  await appendUpdates(tx, [{ userId, update: { type: 'readThread', chatId: groupId, threadId: copyId, upToId } }]);
  return true;
}

/** PUT /chats/:group/threads/:copyId/read {upToId}: участник группы, upToId — не новее последнего в треде. */
export async function readThread(userId: number, groupId: number, copyId: number, upToId: unknown): Promise<{ readMaxId: number; changed: boolean }> {
  if (!Number.isSafeInteger(upToId) || (upToId as number) <= 0) throw new DomainError('bad_frame', 'upToId');
  return sql.begin(async (tx) => {
    await groupCtx(tx, groupId, userId);
    await threadRoot(tx, groupId, copyId);
    const [{ max }] = await tx`select greatest(${copyId}::bigint, coalesce(max(id), 0)) as max from messages where chat_id = ${groupId} and thread_id = ${copyId}`;
    if ((upToId as number) > Number(max)) throw new DomainError('not_found', 'message');
    const changed = await markThreadReadTx(tx, userId, groupId, copyId, upToId as number);
    const [r] = await tx`select read_max_id from thread_reads where user_id = ${userId} and chat_id = ${groupId} and thread_id = ${copyId}`;
    return { readMaxId: Number(r.read_max_id), changed };
  });
}
