import { attachmentForSend } from './files';
import { clearDraftInTx } from './drafts';
import { normalizeEntities, trimFormatted, type Entity, type ForwardInfo, type ForwardRef, type LinkPreview, type Message } from '@relay/protocol';
import { sql } from '../db';
import { assertMember, toMessage } from './chats';
import { DomainError } from './errors';
import { fanOut } from './journal';
import { blockedInDirect } from './privacy';
import { burnCodes } from './login';
import { enqueue } from '../jobs/queue';
import { cachedPreview, firstUrl, getPreview } from './linkPreview';

export const MAX_BODY = 4096;

export async function sendMessage(
  userId: number,
  input: { chatId: number; clientId: string; body: string; entities?: Entity[]; replyToId?: number | null; attachment?: { id: string; thumb?: string | null } | null; groupId?: string | null; forward?: ForwardRef | null; noLinkPreview?: boolean },
): Promise<{ message: Message; duplicate: boolean }> {
  // пробелы по краям срезаем вместе с оформлением; оформление — только проверенное
  let { text: body, entities } = trimFormatted(input.body, normalizeEntities(input.body, input.entities));
  if (!input.forward) {
    if (!body && !input.attachment) throw new DomainError('bad_frame', 'empty body'); // у вложения подпись необязательна
    if (body.length > MAX_BODY) throw new DomainError('too_long');
  }

  const res = await sql.begin(async (tx) => {
    await assertMember(tx, input.chatId, userId);
    // личный чат, а собеседник заблокировал отправителя: не пишем ничего (повтор уже принятого — по-прежнему ack)
    if (await blockedInDirect(tx, input.chatId, userId)) {
      const [existing] = await tx`select * from messages where sender_id = ${userId} and client_id = ${input.clientId}`;
      if (existing) return { message: toMessage(existing), duplicate: true };
      throw new DomainError('blocked');
    }
    if (input.replyToId != null && !input.forward) {
      const [target] = await tx`select 1 from messages where chat_id = ${input.chatId} and id = ${input.replyToId}`;
      if (!target) throw new DomainError('not_found', 'reply target');
    }
    let attachment: Record<string, unknown> | null;
    let kind: string;
    let fwdFrom: ForwardInfo | null = null;
    let link: LinkPreview | null = null, fetchLink: string | null = null;
    if (input.forward) {
      // пересылка: всё берём у оригинала — только из чата, где пересылающий состоит; вложение — тот же объект
      // (файл уже доступен получателям через fileFor: он лежит в сообщении их чата), заново не загружается
      const f = input.forward;
      await assertMember(tx, f.chatId, userId);
      const [src] = await tx`select m.*, u.name as sender_name from messages m join users u on u.id = m.sender_id
        where m.chat_id = ${f.chatId} and m.id = ${f.id} and not m.deleted and m.service_type is null`;
      if (!src) throw new DomainError('not_found', 'forward source');
      attachment = (src.attachment as Record<string, unknown> | null) ?? null;
      kind = src.kind as string;
      const dropCaption = !!f.hideCaption && !!attachment;
      body = dropCaption ? '' : src.body as string;
      entities = dropCaption || !Array.isArray(src.entities) ? [] : normalizeEntities(body, src.entities as Entity[]);
      // пересланное пересланного — исходный автор; «скрыть отправителя» — без заголовка, как своё
      // превью ссылки пересылается как есть (ещё грузится — копия получит его, когда оригинал загрузится, не раньше)
      const sl = src.link as LinkPreview | null;
      if (sl && !sl.pending && !dropCaption) link = sl;
      fwdFrom = f.hideSender ? null : (src.fwd_from as ForwardInfo | null) ?? {
        userId: Number(src.sender_id), name: src.sender_name as string, chatId: f.chatId, messageId: Number(src.id), at: (src.created_at as Date).toISOString(),
      };
    } else {
      attachment = input.attachment ? await attachmentForSend(tx, userId, input.attachment) as unknown as Record<string, unknown> : null;
      kind = attachment ? attachment.kind as string : 'text';
      // превью первой ссылки (как в Telegram): готовое в кэше — сразу, иначе «грузится» и задача link.preview
      const url = !attachment && !input.noLinkPreview ? firstUrl(body, entities) : null;
      if (url) {
        const cached = await cachedPreview(url);
        if (cached === undefined) { link = { url, pending: true }; fetchLink = url; } else link = cached;
      }
    }
    const inserted = await tx`
      insert into messages (chat_id, sender_id, client_id, kind, body, entities, reply_to_id, attachment, group_id, fwd_from, link)
      values (${input.chatId}, ${userId}, ${input.clientId}, ${kind}, ${body}, ${entities.length ? sql.json(entities as never) : null}, ${input.forward ? null : input.replyToId ?? null}, ${attachment ? sql.json(attachment as never) : null},
              ${attachment && input.groupId && /^[0-9a-f-]{36}$/.test(input.groupId) ? input.groupId : null},   -- группа — только у вложений
              ${fwdFrom ? sql.json(fwdFrom as never) : null}, ${link ? sql.json(link as never) : null})
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
    await enqueue(tx, 'push.message', { message });  // уйдёт после коммита, воркером: ack не ждёт push-сервис
    await enqueue(tx, 'search.sync', { id: message.id });   // в индекс поиска — тоже после коммита
    if (fetchLink) await enqueue(tx, 'link.preview', { chatId: input.chatId, id: message.id, url: fetchLink }, { maxAttempts: 2 });
    return { message, duplicate: false };
  });
  return res;
}

/** Задача link.preview: загрузить превью и отдать его сообщению — если оно всё ещё ждёт именно эту ссылку
 *  (текст могли изменить или удалить). Участникам чата — обновление linkPreview. */
export async function applyLinkPreview(p: { chatId: number; id: number; url: string }): Promise<void> {
  const data = await getPreview(p.url);
  await sql.begin(async (tx) => {
    const [row] = await tx`update messages set link = ${data ? sql.json(data as never) : null}
      where id = ${p.id} and chat_id = ${p.chatId} and not deleted and link->>'url' = ${p.url} and (link->>'pending')::boolean is true returning id`;
    if (!row) return;
    const members = await tx`select user_id from chat_members where chat_id = ${p.chatId}`;
    await fanOut(tx, members.map((m) => m.user_id as number), { type: 'linkPreview', chatId: p.chatId, id: p.id, link: data });
  });
}
