import type { Message } from '@relay/protocol';
import { sql } from '../db';
import { assertMember, toMessage } from './chats';
import { DomainError } from './errors';
import { fanOut } from './journal';

export const MAX_BODY = 4096;

export async function sendMessage(
  userId: number,
  input: { chatId: number; clientId: string; body: string; replyToId?: number | null },
): Promise<{ message: Message; duplicate: boolean }> {
  const body = input.body.trim();
  if (!body) throw new DomainError('bad_frame', 'empty body');
  if (body.length > MAX_BODY) throw new DomainError('too_long');

  return sql.begin(async (tx) => {
    await assertMember(tx, input.chatId, userId);
    if (input.replyToId != null) {
      const [target] = await tx`select 1 from messages where chat_id = ${input.chatId} and id = ${input.replyToId}`;
      if (!target) throw new DomainError('not_found', 'reply target');
    }
    const inserted = await tx`
      insert into messages (chat_id, sender_id, client_id, kind, body, reply_to_id)
      values (${input.chatId}, ${userId}, ${input.clientId}, 'text', ${body}, ${input.replyToId ?? null})
      on conflict (sender_id, client_id) do nothing
      returning *`;
    if (inserted.length === 0) {
      const [existing] = await tx`select * from messages where sender_id = ${userId} and client_id = ${input.clientId}`;
      return { message: toMessage(existing), duplicate: true };
    }
    const message = toMessage(inserted[0]);
    const members = await tx`select user_id from chat_members where chat_id = ${input.chatId}`;
    await fanOut(tx, members.map((m) => m.user_id as number), { type: 'newMessage', message });
    return { message, duplicate: false };
  });
}
