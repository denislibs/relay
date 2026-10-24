import type { ProfilePhoto } from '@relay/protocol';
import { sql } from '../db';
import { chatSeqOf } from './chatJournal';
import { canRead, listChats, toMessage, withAllReactions, type ChatSummary } from './chats';
import { openRows } from './messageContent';
import { DomainError } from './errors';
import { groupInfo } from './groupRights';

/**
 * Превью публичного канала до подписки (как в Telegram): кто угодно открывает канал с @именем как ленту только для
 * чтения — шапка, история, закрепы; внизу «Подписаться». GET /groups/:id: участнику — его строка списка (member),
 * не участнику публичного канала — строка без личного: ни роли, ни прочитанности, ни админских полей (владелец,
 * заявки). seq — номер журнала канала: клиент держит его, пока смотрит превью (watchChat), и догоняет push'и.
 */
export interface ChannelPreview { member: boolean; requested: boolean; chat: ChatSummary }

export async function channelPreview(userId: number, chatId: number): Promise<ChannelPreview> {
  const { member } = await canRead(sql, chatId, userId);
  if (member) {
    const [chat] = await listChats(userId, { ids: [chatId] });
    if (!chat) throw new DomainError('not_member');
    return { member: true, requested: false, chat };
  }
  const { pending: _p, kind: _k, ...info } = await groupInfo(sql, chatId);
  const [rows, pins, seq, [req]] = await Promise.all([
    sql`select * from messages where chat_id = ${chatId} order by id desc limit 1`,
    sql`select message_id from pinned_messages where chat_id = ${chatId} order by message_id desc limit 100`,
    chatSeqOf(chatId),
    sql`select exists (select 1 from chat_join_requests r where r.chat_id = ${chatId} and r.user_id = ${userId}) as requested`,
  ]);
  const last = (await withAllReactions((await openRows(rows)).map(toMessage), userId))[0] ?? null;
  return {
    member: false,
    requested: !!req?.requested,
    chat: {
      id: chatId, kind: 'channel', title: info.title, lastReadId: 0, unread: 0, last, peer: null, peerReadUpTo: 0, seq,
      pinned: pins.map((r) => Number(r.message_id)),
      // владельца канала подписчикам не раскрываем; заявки — только тем, кто их принимает
      group: { ...info, ownerId: null, requests: 0 },
    },
  };
}

/** Публичный канал в глобальном поиске (секция «Глобальный поиск», как в Telegram). */
export interface ChannelHit { id: number; title: string; username: string; photo: ProfilePhoto | null; members: number }

/**
 * Публичные каналы по @имени (начало) или названию (подстрока), кроме тех, где я уже состою — их находит список на
 * устройстве. Точное @имя — первым, дальше — крупные. Не больше 10.
 */
export async function searchChannels(userId: number, raw: string): Promise<{ channels: ChannelHit[] }> {
  const q = raw.trim().replace(/^@/, '');
  if (q.length < 2) return { channels: [] };
  if (q.length > 64) throw new DomainError('too_long');
  const esc = q.replace(/[\\%_]/g, (c) => '\\' + c);
  const rows = await sql`
    select c.id, c.title, c.username, c.photo, c.members_count
      from chats c
     where c.kind = 'channel' and c.username is not null and c.deleted_at is null
       and (c.username ilike ${esc + '%'} or c.title ilike ${'%' + esc + '%'})
       and not exists (select 1 from chat_members m where m.chat_id = c.id and m.user_id = ${userId})
       and not exists (select 1 from chat_bans b where b.chat_id = c.id and b.user_id = ${userId})
     order by (lower(c.username) = ${q.toLowerCase()}) desc, c.members_count desc, c.id
     limit 10`;
  return { channels: rows.map((r) => ({ id: Number(r.id), title: String(r.title ?? ''), username: String(r.username), photo: (r.photo as ProfilePhoto | null) ?? null, members: Number(r.members_count) })) };
}
