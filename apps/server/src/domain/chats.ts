import { graphemes, normalizeEntities, type Entity, type Block, type ForwardInfo, type LinkPreview, type MediaTab, type Message, type ProfilePhoto, type ServiceData, type ServiceType, type Todo } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { fanOut } from './journal';
import { nameForSql } from './profile';
import { summaryFromRow } from './groupRights';
import type { GroupInfo, MyMembership } from '@relay/protocol';

export async function createChat(kind: 'direct' | 'group', title: string | null, memberIds: number[]): Promise<number> {
  return sql.begin(async (tx) => {
    const [chat] = await tx`insert into chats (kind, title) values (${kind}, ${title}) returning id`;
    for (const userId of new Set(memberIds)) {
      await tx`insert into chat_members (chat_id, user_id) values (${chat.id}, ${userId})`;
    }
    return chat.id as number;
  });
}

export const GROUP_TITLE_MAX = 128;
export const GROUP_MEMBERS_MAX = 200;   // вместе с создателем

/**
 * Новая группа: создатель и участники, первое сообщение — служебное «создал(а) группу» (его newMessage
 * всем участникам и приносит чат в их списки). Нельзя добавить несуществующего, системного или того,
 * с кем есть блокировка в любую сторону.
 */
export async function createGroup(creatorId: number, input: { title?: unknown; memberIds?: unknown }): Promise<{ chatId: number; message: Message }> {
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) throw new DomainError('bad_frame', 'title');
  if (graphemes(title) > GROUP_TITLE_MAX) throw new DomainError('too_long', 'title');
  if (!Array.isArray(input.memberIds)) throw new DomainError('bad_frame', 'members');
  const ids = [...new Set(input.memberIds.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== creatorId))];
  if (!ids.length) throw new DomainError('bad_frame', 'members');
  if (ids.length + 1 > GROUP_MEMBERS_MAX) throw new DomainError('too_long', 'members');
  return sql.begin(async (tx) => {
    const found = await tx`select id from users where id = any(${ids}::bigint[]) and not system`;
    if (found.length !== ids.length) throw new DomainError('not_found', 'member');
    const [blocked] = await tx`select 1 from blocks where (owner_id = ${creatorId} and user_id = any(${ids}::bigint[])) or (user_id = ${creatorId} and owner_id = any(${ids}::bigint[])) limit 1`;
    if (blocked) throw new DomainError('blocked');
    const [chat] = await tx`insert into chats (kind, title, owner_id) values ('group', ${title}, ${creatorId}) returning id`;
    const members = [creatorId, ...ids];
    await tx`insert into chat_members (chat_id, user_id, inviter_id) select ${chat.id}, unnest(${ids}::bigint[]), ${creatorId}`;
    await tx`insert into chat_members (chat_id, user_id, role) values (${chat.id}, ${creatorId}, 'owner')`;
    const [row] = await tx`
      insert into messages (chat_id, sender_id, client_id, kind, body, service_type)
      values (${chat.id}, ${creatorId}, ${crypto.randomUUID()}, 'text', ${title}, 'group_created') returning *`;
    const message = toMessage(row);
    await fanOut(tx, members, { type: 'newMessage', message });
    return { chatId: Number(chat.id), message };
  });
}

/** Личный чат с peer: существующий (не служебный) или новый. Собеседник увидит его с первым сообщением. */
export async function openDirect(userId: number, peerId: unknown): Promise<number> {
  const peer = Number(peerId);
  if (!Number.isInteger(peer) || peer <= 0 || peer === userId) throw new DomainError('bad_frame', 'peer');
  return sql.begin(async (tx) => {
    const [u] = await tx`select id from users where id = ${peer} and not system`;
    if (!u) throw new DomainError('not_found', 'peer');
    // одна личная переписка на пару: берём замок по паре, чтобы два одновременных запроса не создали две
    await tx`select pg_advisory_xact_lock(hashtextextended(${Math.min(userId, peer) + ':' + Math.max(userId, peer)}, 0))`;
    const [found] = await tx`
      select c.id from chats c
      join chat_members a on a.chat_id = c.id and a.user_id = ${userId}
      join chat_members b on b.chat_id = c.id and b.user_id = ${peer}
      where c.kind = 'direct' and not exists (select 1 from service_chats s where s.chat_id = c.id)
        and (select count(*) from chat_members m where m.chat_id = c.id) = 2
      order by c.id limit 1`;
    if (found) return Number(found.id);
    const [chat] = await tx`insert into chats (kind, title) values ('direct', null) returning id`;
    await tx`insert into chat_members (chat_id, user_id) values (${chat.id}, ${userId}), (${chat.id}, ${peer})`;
    return Number(chat.id);
  });
}

/** С какого сообщения участнику видна история (скрытая история для новых — с момента вступления). */
export async function historyFrom(chatId: number, userId: number): Promise<number> {
  const [r] = await sql`select history_from from chat_members where chat_id = ${chatId} and user_id = ${userId}`;
  return Number(r?.history_from ?? 0);
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
    ...((r.kind === 'voice' || r.kind === 'round') && !r.deleted ? { listened: !!r.listened } : {}),
    // из jsonb — в каноническом виде (порядок ключей у jsonb свой)
    ...(r.service_type ? { service: { type: r.service_type as ServiceType, ...(r.service_data ? { data: r.service_data as ServiceData } : {}) } } : {}),
    ...(r.kind === 'todo' && r.todo && !r.deleted ? { todo: r.todo as Todo } : {}),
    ...(r.group_id ? { groupId: r.group_id as string } : {}),
    ...(r.fwd_from ? { fwdFrom: r.fwd_from as ForwardInfo } : {}),
    ...(r.link ? { link: r.link as LinkPreview } : {}),
    ...(r.blocks ? { blocks: r.blocks as Block[] } : {}),
    ...(!r.deleted && Array.isArray(r.entities) && r.entities.length ? { entities: normalizeEntities(r.body as string, r.entities) } : {}),
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
  peer: { id: number; name: string; system?: true; photo?: ProfilePhoto | null } | null; // собеседник личного чата
  peerReadUpTo: number; // до какого id мои сообщения прочитаны всеми остальными участниками
  draft?: { text: string; at: string; entities?: Entity[] } | null; // черновик этого пользователя (синхронизируется между устройствами)
  sortAt?: string; // ключ сортировки списка (последнее сообщение или создание чата) — из него курсор страницы
  pinned?: number[]; // закреплённые сообщения (новые сверху)
  group?: GroupInfo;    // только у групп: информация и настройки
  me?: MyMembership;    // только у групп: моя роль и права
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
           c.about, c.photo as g_photo, c.owner_id, c.rights as chat_rights, c.slow_mode, c.history_hidden, c.join_approval, c.username, c.reactions, c.protected,
           cm.role, cm.admin_rights, cm.restricted, cm.history_from, cm.rank,
           case when c.kind = 'group' then (select count(*)::int from chat_members gm where gm.chat_id = c.id) end as g_members,
           case when c.kind = 'group' then (select count(*)::int from chat_join_requests jr where jr.chat_id = c.id) end as g_pending,
           lm.id as m_id, lm.chat_id as m_chat_id, lm.sender_id as m_sender_id, lm.client_id as m_client_id,
           lm.body as m_body, lm.kind as m_kind, lm.attachment as m_attachment, lm.reply_to_id as m_reply_to_id, lm.created_at as m_created_at, lm.edited_at as m_edited_at, lm.deleted as m_deleted, lm.entities as m_entities, lm.service_type as m_service_type, lm.service_data as m_service_data, lm.todo as m_todo, lm.fwd_from as m_fwd_from,
           (select count(*) from messages m
             where m.chat_id = c.id and m.id > cm.last_read_id and m.id >= cm.history_from and m.sender_id <> ${userId})::int as unread,
           (select json_build_object('id', u.id, 'name', ${nameForSql(userId)}, 'system', u.system,   -- контактное имя — только владельцу
                    'photo', case when exists (select 1 from blocks b where b.owner_id = u.id and b.user_id = ${userId}) then null else u.photo end)
              from chat_members pm join users u on u.id = pm.user_id
             where c.kind = 'direct' and pm.chat_id = c.id and pm.user_id <> ${userId} limit 1) as peer,
           (select coalesce(min(om.last_read_id), 0) from chat_members om where om.chat_id = c.id and om.user_id <> ${userId}) as peer_read_up_to,
           date_trunc('milliseconds', coalesce(lm.created_at, c.created_at)) as sort_at,
           (select json_build_object('text', d.text, 'at', d.updated_at, 'entities', d.entities) from drafts d where d.user_id = ${userId} and d.chat_id = c.id) as draft,
           (select coalesce(json_agg(p.message_id order by p.message_id desc), '[]') from (select message_id from pinned_messages where chat_id = c.id order by message_id desc limit 100) p) as pinned
      from chat_members cm
      join chats c on c.id = cm.chat_id
      left join lateral (
        select * from messages where chat_id = c.id and id >= cm.history_from order by id desc limit 1
      ) lm on true
     where cm.user_id = ${userId}
       -- личный чат, который удалили (история сдвинута) и в котором с тех пор ничего нет, — не в списке
       and not (c.kind = 'direct' and cm.history_from > 0 and lm.id is null)
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
    peer: r.peer ? { id: (r.peer as { id: number }).id, name: (r.peer as { name: string }).name, photo: (r.peer as { photo?: ProfilePhoto | null }).photo ?? null, ...((r.peer as { system?: boolean }).system ? { system: true as const } : {}) } : null,
    peerReadUpTo: (r.peer_read_up_to as number) ?? 0,
    sortAt: new Date(r.sort_at as string).toISOString(),
    pinned: ((r.pinned as number[] | null) ?? []).map(Number),
    ...(r.kind === 'group' ? summaryFromRow(Number(r.id), userId, r) : {}),
    draft: r.draft ? { text: (r.draft as { text: string }).text, at: new Date((r.draft as { at: string }).at).toISOString(), ...((r.draft as { entities?: Entity[] | null }).entities?.length ? { entities: normalizeEntities((r.draft as { text: string }).text, (r.draft as { entities: Entity[] }).entities) } : {}) } : null,
    last: r.m_id == null ? null : toMessage({
      id: r.m_id, chat_id: r.m_chat_id, sender_id: r.m_sender_id, client_id: r.m_client_id,
      body: r.m_body, kind: r.m_kind, attachment: r.m_attachment, reply_to_id: r.m_reply_to_id, created_at: r.m_created_at, edited_at: r.m_edited_at, deleted: r.m_deleted, entities: r.m_entities, service_type: r.m_service_type, service_data: r.m_service_data, todo: r.m_todo, fwd_from: r.m_fwd_from,
    }),
  }));
}

/** Конкретные сообщения чата по id (исходники цитат, которых нет в загруженной истории). */
/** Условие вкладки «Общих медиа» (как в Telegram): видео, присланное файлом, — тоже медиа; ссылки — по тексту и сущностям. */
export function tabWhere(tab: MediaTab) {
  switch (tab) {
    case 'media': return sql`(kind = 'photo' or (kind = 'file' and attachment->>'mime' like 'video/%'))`;
    case 'file': return sql`(kind = 'file' and coalesce(attachment->>'mime', '') not like 'video/%')`;
    case 'audio': return sql`kind = 'audio'`;
    case 'voice': return sql`kind in ('voice', 'round')`;
    case 'link': return sql`(service_type is null and (body ~* '(https?://|www\\.)[^\\s]' or coalesce(entities, '[]'::jsonb) @> '[{"type":"link"}]'))`;
  }
}

/** Вкладка «Общих медиа»: новые сверху, страницами по id. */
export async function getChatMedia(userId: number, chatId: number, tab: MediaTab, beforeId: number | null, limit = 40): Promise<{ messages: Message[]; hasMore: boolean }> {
  await assertMember(sql, chatId, userId);
  const rows = await sql`
    select * from messages
     where chat_id = ${chatId} and not deleted and ${tabWhere(tab)} and id >= ${await historyFrom(chatId, userId)}
       ${beforeId ? sql`and id < ${beforeId}` : sql``}
     order by id desc limit ${limit + 1}`;
  return { messages: rows.slice(0, limit).map(toMessage), hasMore: rows.length > limit };
}

/** Сколько всего в каждой вкладке — пустые вкладки панель не показывает (как в Telegram Web K). */
export async function getChatMediaCounts(userId: number, chatId: number): Promise<Record<MediaTab, number>> {
  await assertMember(sql, chatId, userId);
  const [r] = await sql`
    select count(*) filter (where ${tabWhere('media')})::int as media,
           count(*) filter (where ${tabWhere('file')})::int as file,
           count(*) filter (where ${tabWhere('audio')})::int as audio,
           count(*) filter (where ${tabWhere('voice')})::int as voice,
           count(*) filter (where ${tabWhere('link')})::int as link
      from messages where chat_id = ${chatId} and not deleted and id >= ${await historyFrom(chatId, userId)}`;
  return { media: r.media, file: r.file, audio: r.audio, voice: r.voice, link: r.link };
}

/** «Перейти к дате»: первое сообщение не раньше from (полночь выбранного дня у клиента); позже нет — последнее. */
export async function messageAtDate(userId: number, chatId: number, from: string): Promise<{ id: number | null }> {
  const at = new Date(from);
  if (Number.isNaN(at.getTime())) throw new DomainError('bad_frame', 'from');
  await assertMember(sql, chatId, userId);
  const visible = await historyFrom(chatId, userId);
  const [first] = await sql`select id from messages where chat_id = ${chatId} and id >= ${visible} and created_at >= ${at} order by created_at, id limit 1`;
  if (first) return { id: Number(first.id) };
  const [last] = await sql`select id from messages where chat_id = ${chatId} order by id desc limit 1`;
  return { id: last ? Number(last.id) : null };
}

export async function getMessagesByIds(userId: number, chatId: number, ids: number[]): Promise<Message[]> {
  await assertMember(sql, chatId, userId);
  if (!ids.length) return [];
  const rows = await sql`select * from messages where chat_id = ${chatId} and id = any(${ids}::bigint[]) and id >= ${await historyFrom(chatId, userId)} order by id`;
  return withReactions(rows.map(toMessage));
}

export async function getHistory(userId: number, chatId: number, before: number | null, limit: number): Promise<{ messages: Message[]; hasMore: boolean }> {
  await assertMember(sql, chatId, userId);
  const take = Math.min(Math.max(limit, 1), 200);
  const rows = await sql`
    select * from messages
     where chat_id = ${chatId} and (${before}::bigint is null or id < ${before}) and id >= ${await historyFrom(chatId, userId)}
     order by id desc
     limit ${take + 1}`;
  const hasMore = rows.length > take;
  return { messages: await withReactions(rows.slice(0, take).reverse().map(toMessage)), hasMore };
}

/**
 * «Удалить чат» в личной переписке (как в Telegram): история исчезает у меня или у обоих — первое видимое сообщение
 * сдвигается за последнее (history_from), чат уходит из списка этих людей и вернётся с новым сообщением.
 */
export async function deleteDirectChat(userId: number, chatId: number, forAll: boolean): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    const [c] = await tx`select kind from chats where id = ${chatId}`;
    if (c?.kind !== 'direct') throw new DomainError('bad_frame', 'not a direct chat');
    const [m] = await tx`select coalesce(max(id), 0)::bigint as max from messages where chat_id = ${chatId}`;
    const from = Number(m.max) + 1;
    const who = forAll
      ? (await tx`select user_id from chat_members where chat_id = ${chatId}`).map((r) => Number(r.user_id))
      : [userId];
    await tx`update chat_members set history_from = ${from}, last_read_id = greatest(last_read_id, ${from - 1}) where chat_id = ${chatId} and user_id = any(${who}::bigint[])`;
    await fanOut(tx, who, { type: 'chatRemoved', chatId });
    return { ok: true };
  });
}
