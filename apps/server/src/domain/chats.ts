import type { Message } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';

export async function createChat(kind: 'direct' | 'group', title: string | null, memberIds: number[]): Promise<number> {
  return sql.begin(async (tx) => {
    const [chat] = await tx`insert into chats (kind, title) values (${kind}, ${title}) returning id`;
    for (const userId of new Set(memberIds)) {
      await tx`insert into chat_members (chat_id, user_id) values (${chat.id}, ${userId})`;
    }
    return chat.id as number;
  });
}

export async function assertMember(db: Tx | typeof sql, chatId: number, userId: number): Promise<void> {
  const [row] = await db`select 1 from chat_members where chat_id = ${chatId} and user_id = ${userId}`;
  if (!row) throw new DomainError('not_member');
}

export function toMessage(r: Record<string, unknown>): Message {
  return {
    id: r.id as number,
    chatId: r.chat_id as number,
    senderId: r.sender_id as number,
    clientId: r.client_id as string,
    kind: ((r.kind as string) ?? 'text') as Message['kind'],
    body: r.body as string,
    replyToId: (r.reply_to_id as number | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
    editedAt: r.edited_at ? (r.edited_at as Date).toISOString() : null,
    deleted: !!r.deleted,
    attachment: r.deleted ? null : ((r.attachment as Message['attachment']) ?? null),
  };
}

/** Подложить реакции к сообщениям (одним запросом). */
export async function withReactions(messages: Message[]): Promise<Message[]> {
  if (!messages.length) return messages;
  const rows = await sql`
    select chat_id, message_id, user_id, emoji from reactions
     where (chat_id, message_id) in (select * from unnest(${messages.map((m) => m.chatId)}::bigint[], ${messages.map((m) => m.id)}::bigint[]))
     order by created_at`;
  const by = new Map<string, { userId: number; emoji: string }[]>();
  for (const r of rows) {
    const k = r.chat_id + ':' + r.message_id;
    let list = by.get(k);
    if (!list) { list = []; by.set(k, list); }
    list.push({ userId: r.user_id as number, emoji: r.emoji as string });
  }
  for (const m of messages) m.reactions = by.get(m.chatId + ':' + m.id) ?? [];
  return messages;
}

export type ChatSummary = {
  id: number;
  kind: 'direct' | 'group';
  title: string | null;
  lastReadId: number;
  unread: number;
  last: Message | null;
  peer: { id: number; name: string } | null; // собеседник личного чата
  peerReadUpTo: number; // до какого id мои сообщения прочитаны всеми остальными участниками
  draft?: { text: string; at: string } | null; // черновик этого пользователя (синхронизируется между устройствами)
  sortAt?: string; // ключ сортировки списка (последнее сообщение или создание чата) — из него курсор страницы
};

/** Курсор страницы диалогов: время последнего сообщения (или создания чата) и id — как offset_date/offset_peer в Telegram. */
export interface DialogCursor { at: string; id: number }
export interface ListOpts { limit?: number; before?: DialogCursor; ids?: number[]; unreadOnly?: boolean }

/** Страница диалогов, новые сверху, и курсор следующей (null — дальше пусто). */
export async function listChatsPage(userId: number, limit: number, before?: DialogCursor): Promise<{ chats: ChatSummary[]; next: DialogCursor | null }> {
  const chats = await listChats(userId, { limit: limit + 1, before });
  const more = chats.length > limit;
  const page = more ? chats.slice(0, limit) : chats;
  const last = page[page.length - 1];
  return { chats: page, next: more && last ? { at: last.sortAt!, id: last.id } : null };
}

export async function listChats(userId: number, opts: ListOpts = {}): Promise<ChatSummary[]> {
  // время списка — с точностью до мс: курсор уходит клиенту в ISO (мс), иначе на стыке страниц теряются чаты одной миллисекунды
  const rows = await sql`
    select c.id, c.kind, c.title, c.created_at as chat_created_at, cm.last_read_id,
           lm.id as m_id, lm.chat_id as m_chat_id, lm.sender_id as m_sender_id, lm.client_id as m_client_id,
           lm.body as m_body, lm.kind as m_kind, lm.attachment as m_attachment, lm.reply_to_id as m_reply_to_id, lm.created_at as m_created_at, lm.edited_at as m_edited_at, lm.deleted as m_deleted,
           (select count(*) from messages m
             where m.chat_id = c.id and m.id > cm.last_read_id and m.sender_id <> ${userId})::int as unread,
           (select json_build_object('id', u.id, 'name', u.name) from chat_members pm join users u on u.id = pm.user_id
             where c.kind = 'direct' and pm.chat_id = c.id and pm.user_id <> ${userId} limit 1) as peer,
           (select coalesce(min(om.last_read_id), 0) from chat_members om where om.chat_id = c.id and om.user_id <> ${userId}) as peer_read_up_to,
           date_trunc('milliseconds', coalesce(lm.created_at, c.created_at)) as sort_at,
           (select json_build_object('text', d.text, 'at', d.updated_at) from drafts d where d.user_id = ${userId} and d.chat_id = c.id) as draft
      from chat_members cm
      join chats c on c.id = cm.chat_id
      left join lateral (
        select * from messages where chat_id = c.id order by id desc limit 1
      ) lm on true
     where cm.user_id = ${userId}
       ${opts.before ? sql`and (date_trunc('milliseconds', coalesce(lm.created_at, c.created_at)), c.id) < (${opts.before.at}::timestamptz, ${opts.before.id})` : sql``}
       ${opts.ids ? sql`and c.id = any(${opts.ids}::bigint[])` : sql``}
       ${opts.unreadOnly ? sql`and exists (select 1 from messages m where m.chat_id = c.id and m.id > cm.last_read_id and m.sender_id <> ${userId})` : sql``}
     order by date_trunc('milliseconds', coalesce(lm.created_at, c.created_at)) desc, c.id desc
     ${opts.limit ? sql`limit ${opts.limit}` : sql``}`;
  return rows.map((r) => ({
    id: r.id as number,
    kind: r.kind as 'direct' | 'group',
    title: (r.title as string | null) ?? null,
    lastReadId: r.last_read_id as number,
    unread: r.unread as number,
    peer: (r.peer as { id: number; name: string } | null) ?? null,
    peerReadUpTo: (r.peer_read_up_to as number) ?? 0,
    sortAt: new Date(r.sort_at as string).toISOString(),
    draft: r.draft ? { text: (r.draft as { text: string }).text, at: new Date((r.draft as { at: string }).at).toISOString() } : null,
    last: r.m_id == null ? null : toMessage({
      id: r.m_id, chat_id: r.m_chat_id, sender_id: r.m_sender_id, client_id: r.m_client_id,
      body: r.m_body, kind: r.m_kind, attachment: r.m_attachment, reply_to_id: r.m_reply_to_id, created_at: r.m_created_at, edited_at: r.m_edited_at, deleted: r.m_deleted,
    }),
  }));
}

/** Конкретные сообщения чата по id (исходники цитат, которых нет в загруженной истории). */
/** Медиа и файлы чата для вкладок панели «Информация»: новые сверху, страницами. */
export async function getChatMedia(userId: number, chatId: number, kind: 'photo' | 'file', beforeId: number | null, limit = 60): Promise<{ messages: Message[]; hasMore: boolean }> {
  await assertMember(sql, chatId, userId);
  const rows = await sql`
    select * from messages
     where chat_id = ${chatId} and not deleted and kind = ${kind}
       ${beforeId ? sql`and id < ${beforeId}` : sql``}
     order by id desc limit ${limit + 1}`;
  return { messages: rows.slice(0, limit).map(toMessage), hasMore: rows.length > limit };
}

export async function getMessagesByIds(userId: number, chatId: number, ids: number[]): Promise<Message[]> {
  await assertMember(sql, chatId, userId);
  if (!ids.length) return [];
  const rows = await sql`select * from messages where chat_id = ${chatId} and id = any(${ids}::bigint[]) order by id`;
  return withReactions(rows.map(toMessage));
}

export async function getHistory(userId: number, chatId: number, before: number | null, limit: number): Promise<{ messages: Message[]; hasMore: boolean }> {
  await assertMember(sql, chatId, userId);
  const take = Math.min(Math.max(limit, 1), 200);
  const rows = await sql`
    select * from messages
     where chat_id = ${chatId} and (${before}::bigint is null or id < ${before})
     order by id desc
     limit ${take + 1}`;
  const hasMore = rows.length > take;
  return { messages: await withReactions(rows.slice(0, take).reverse().map(toMessage)), hasMore };
}
