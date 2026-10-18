import { attachmentForSend } from './files';
import { clearDraftInTx } from './drafts';
import { normalizeEntities, trimFormatted, type Entity, type Message } from '@relay/protocol';
import { sql } from '../db';
import { assertMember, toMessage } from './chats';
import { DomainError } from './errors';
import { fanOut } from './journal';
import { blockedInDirect } from './privacy';
import { pushInBackground } from './push';
import { isServiceChat } from './service';
import { burnCodes } from './login';

export const MAX_BODY = 4096;

export async function sendMessage(
  userId: number,
  input: { chatId: number; clientId: string; body: string; entities?: Entity[]; replyToId?: number | null; attachment?: { id: string; thumb?: string | null } | null },
): Promise<{ message: Message; duplicate: boolean }> {
  // пробелы по краям срезаем вместе с оформлением; оформление — только проверенное
  const { text: body, entities } = trimFormatted(input.body, normalizeEntities(input.body, input.entities));
  if (!body && !input.attachment) throw new DomainError('bad_frame', 'empty body'); // у вложения подпись необязательна
  if (body.length > MAX_BODY) throw new DomainError('too_long');

  const res = await sql.begin(async (tx) => {
    await assertMember(tx, input.chatId, userId);
    if (await isServiceChat(tx, input.chatId)) throw new DomainError('forbidden');   // служебный чат только для чтения
    // личный чат, а собеседник заблокировал отправителя: не пишем ничего (повтор уже принятого — по-прежнему ack)
    if (await blockedInDirect(tx, input.chatId, userId)) {
      const [existing] = await tx`select * from messages where sender_id = ${userId} and client_id = ${input.clientId}`;
      if (existing) return { message: toMessage(existing), duplicate: true };
      throw new DomainError('blocked');
    }
    if (input.replyToId != null) {
      const [target] = await tx`select 1 from messages where chat_id = ${input.chatId} and id = ${input.replyToId}`;
      if (!target) throw new DomainError('not_found', 'reply target');
    }
    const attachment = input.attachment ? await attachmentForSend(tx, userId, input.attachment) : null;
    const kind = attachment ? attachment.kind : 'text';
    const inserted = await tx`
      insert into messages (chat_id, sender_id, client_id, kind, body, entities, reply_to_id, attachment)
      values (${input.chatId}, ${userId}, ${input.clientId}, ${kind}, ${body}, ${entities.length ? sql.json(entities as never) : null}, ${input.replyToId ?? null}, ${attachment ? sql.json(attachment as never) : null})
      on conflict (sender_id, client_id) do nothing
      returning *`;
    if (inserted.length === 0) {
      const [existing] = await tx`select * from messages where sender_id = ${userId} and client_id = ${input.clientId}`;
      return { message: toMessage(existing), duplicate: true };
    }
    const message = toMessage(inserted[0]);
    await burnCodes(tx, userId, body);
    const members = await tx`select user_id from chat_members where chat_id = ${input.chatId}`;
    await fanOut(tx, members.map((m) => m.user_id as number), { type: 'newMessage', message });
    await clearDraftInTx(tx, userId, input.chatId); // отправили — черновик на всех устройствах больше не нужен
    return { message, duplicate: false };
  });
  // после коммита и не дожидаясь: доставка в push-сервис не должна тормозить ack
  if (!res.duplicate) pushInBackground(res.message);
  return res;
}
