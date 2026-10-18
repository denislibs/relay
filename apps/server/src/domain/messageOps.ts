import { normalizeEntities, trimFormatted, type Entity, type Reaction } from '@relay/protocol';
import { sql } from '../db';
import { assertMember } from './chats';
import { DomainError } from './errors';
import { fanOut } from './journal';
import { blockedInDirect } from './privacy';

const MAX_BODY = 4096;
const EMOJI = /^\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*$/u;

async function ownMessage(tx: Parameters<typeof assertMember>[0], userId: number, chatId: number, id: number) {
  const [m] = await tx`select sender_id, deleted from messages where chat_id = ${chatId} and id = ${id} for update`;
  if (!m || m.deleted) throw new DomainError('not_found', 'message');
  if (m.sender_id !== userId) throw new DomainError('forbidden', 'not your message');
}
const membersOf = async (tx: Parameters<typeof assertMember>[0], chatId: number) =>
  (await tx`select user_id from chat_members where chat_id = ${chatId}`).map((r) => r.user_id as number);

/** Правка своего сообщения: новое тело и отметка «изм.» — всем участникам через журнал. */
export async function editMessage(userId: number, chatId: number, id: number, body: string, rawEntities?: Entity[]): Promise<{ editedAt: string }> {
  const { text, entities } = trimFormatted(body, normalizeEntities(body, rawEntities));
  if (!text) throw new DomainError('bad_frame', 'empty body');
  if (text.length > MAX_BODY) throw new DomainError('too_long');
  return sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    await ownMessage(tx, userId, chatId, id);
    // заблокированный не правит сообщения в личном чате с тем, кто его заблокировал
    if (await blockedInDirect(tx, chatId, userId)) throw new DomainError('blocked');
    const [row] = await tx`update messages set body = ${text}, entities = ${entities.length ? sql.json(entities as never) : null}, edited_at = now() where chat_id = ${chatId} and id = ${id} returning edited_at`;
    const editedAt = new Date(row.edited_at as string).toISOString();
    await fanOut(tx, await membersOf(tx, chatId), { type: 'messageEdited', chatId, id, body: text, editedAt, entities });
    return { editedAt };
  });
}

/** Удаление своего сообщения у всех: тело стирается, остаётся «Сообщение удалено». Реакции уходят вместе с ним. */
export async function deleteMessage(userId: number, chatId: number, id: number): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    await ownMessage(tx, userId, chatId, id);
    await tx`update messages set body = '', entities = null, deleted = true where chat_id = ${chatId} and id = ${id}`;
    await tx`delete from reactions where chat_id = ${chatId} and message_id = ${id}`;
    await fanOut(tx, await membersOf(tx, chatId), { type: 'messageDeleted', chatId, id });
    return { ok: true };
  });
}

/** Реакция (null — снять). Одна от пользователя; всем участникам уходит полный список реакций сообщения. */
export async function reactMessage(userId: number, chatId: number, id: number, emoji: string | null): Promise<{ reactions: Reaction[] }> {
  if (emoji !== null && !EMOJI.test(emoji)) throw new DomainError('bad_frame', 'emoji');
  return sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    const [m] = await tx`select deleted from messages where chat_id = ${chatId} and id = ${id}`;
    if (!m || m.deleted) throw new DomainError('not_found', 'message');
    if (await blockedInDirect(tx, chatId, userId)) throw new DomainError('blocked');
    if (emoji) {
      await tx`insert into reactions (chat_id, message_id, user_id, emoji) values (${chatId}, ${id}, ${userId}, ${emoji})
               on conflict (chat_id, message_id, user_id) do update set emoji = excluded.emoji, created_at = now()`;
    } else {
      await tx`delete from reactions where chat_id = ${chatId} and message_id = ${id} and user_id = ${userId}`;
    }
    const rows = await tx`select user_id, emoji from reactions where chat_id = ${chatId} and message_id = ${id} order by created_at`;
    const reactions = rows.map((r) => ({ userId: r.user_id as number, emoji: r.emoji as string }));
    await fanOut(tx, await membersOf(tx, chatId), { type: 'reactions', chatId, id, reactions });
    return { reactions };
  });
}
