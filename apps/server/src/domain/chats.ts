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
    kind: 'text',
    body: r.body as string,
    replyToId: (r.reply_to_id as number | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
  };
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
};

export async function listChats(userId: number): Promise<ChatSummary[]> {
  const rows = await sql`
    select c.id, c.kind, c.title, c.created_at as chat_created_at, cm.last_read_id,
           lm.id as m_id, lm.chat_id as m_chat_id, lm.sender_id as m_sender_id, lm.client_id as m_client_id,
           lm.body as m_body, lm.reply_to_id as m_reply_to_id, lm.created_at as m_created_at,
           (select count(*) from messages m
             where m.chat_id = c.id and m.id > cm.last_read_id and m.sender_id <> ${userId})::int as unread,
           (select json_build_object('id', u.id, 'name', u.name) from chat_members pm join users u on u.id = pm.user_id
             where c.kind = 'direct' and pm.chat_id = c.id and pm.user_id <> ${userId} limit 1) as peer,
           (select coalesce(min(om.last_read_id), 0) from chat_members om where om.chat_id = c.id and om.user_id <> ${userId}) as peer_read_up_to
      from chat_members cm
      join chats c on c.id = cm.chat_id
      left join lateral (
        select * from messages where chat_id = c.id order by id desc limit 1
      ) lm on true
     where cm.user_id = ${userId}
     order by coalesce(lm.created_at, c.created_at) desc, c.id desc`;
  return rows.map((r) => ({
    id: r.id as number,
    kind: r.kind as 'direct' | 'group',
    title: (r.title as string | null) ?? null,
    lastReadId: r.last_read_id as number,
    unread: r.unread as number,
    peer: (r.peer as { id: number; name: string } | null) ?? null,
    peerReadUpTo: (r.peer_read_up_to as number) ?? 0,
    last: r.m_id == null ? null : toMessage({
      id: r.m_id, chat_id: r.m_chat_id, sender_id: r.m_sender_id, client_id: r.m_client_id,
      body: r.m_body, reply_to_id: r.m_reply_to_id, created_at: r.m_created_at,
    }),
  }));
}

export async function getHistory(userId: number, chatId: number, before: number | null, limit: number): Promise<{ messages: Message[]; hasMore: boolean }> {
  await assertMember(sql, chatId, userId);
  const take = Math.min(Math.max(limit, 1), 100);
  const rows = await sql`
    select * from messages
     where chat_id = ${chatId} and (${before}::bigint is null or id < ${before})
     order by id desc
     limit ${take + 1}`;
  const hasMore = rows.length > take;
  return { messages: rows.slice(0, take).reverse().map(toMessage), hasMore };
}
