import { attachmentForSend } from './files';
import { clearDraftInTx } from './drafts';
import { rightForKind, normalizeEntities, trimFormatted, type Block, blocksText, normalizeBlocks, type Entity, type ForwardInfo, type ForwardRef, type LinkPreview, type Message, type StickerRef, type Todo, type TodoInput } from '@relay/protocol';
import { newTodo } from './todo';
import { sql } from '../db';
import { assertMember, toMessage } from './chats';
import { DomainError } from './errors';
import { appendUpdates, chatEvent } from './journal';
import { unarchiveOnMessage } from './chatFlags';
import { blockedInDirect } from './privacy';
import { burnCodes } from './login';
import { enqueue } from '../jobs/queue';
import { can, groupCtx, hasAdmin, requireRight } from './groupRights';
import { stickerForSend } from './stickers';
import { cachedPreview, firstUrl, getPreview } from './linkPreview';
import { contentColumns, openRows, updateContent } from './messageContent';
import { currentChatKey } from '../crypto/chatKeys';

export const MAX_BODY = 4096;

export async function sendMessage(
  userId: number,
  input: { chatId: number; clientId: string; body: string; entities?: Entity[]; replyToId?: number | null; attachment?: { id: string; thumb?: string | null } | null; groupId?: string | null; forward?: ForwardRef | null; noLinkPreview?: boolean; blocks?: unknown; todo?: TodoInput | null; sticker?: { id: number } | null },
): Promise<{ message: Message; duplicate: boolean }> {
  // пробелы по краям срезаем вместе с оформлением; оформление — только проверенное
  let { text: body, entities } = trimFormatted(input.body, normalizeEntities(input.body, input.entities));
  // «статья»: блоки проверяются и чистятся; body — их простой текст (сервер считает сам, клиенту не верим)
  let blocks: Block[] | null = null;
  if (input.blocks != null && !input.forward) {
    if (input.attachment) throw new DomainError('bad_frame', 'article with attachment');
    blocks = normalizeBlocks(input.blocks);
    if (!blocks) throw new DomainError('bad_frame', 'blocks');
    body = blocksText(blocks); entities = [];
  }
  // чек-лист: тело — его заголовок (для превью и поиска), своего текста и вложения нет
  const todo = input.todo && !input.forward && !input.attachment && !blocks ? newTodo(input.todo) : null;
  if (todo) { body = todo.title; entities = []; }
  // стикер — без текста и вложения: тело пустое, всё в снимке стикера
  const stickerId = input.sticker && !input.forward && !input.attachment && !blocks && !todo ? input.sticker.id : null;
  if (stickerId != null) { body = ''; entities = []; }
  if (!input.forward && !blocks && stickerId == null) {
    if (!body && !input.attachment) throw new DomainError('bad_frame', 'empty body'); // у вложения подпись необязательна
    if (body.length > MAX_BODY) throw new DomainError('too_long');
  }

  // ключ чата — в кэш до транзакции: внутри неё он берётся из памяти (создание в транзакции в кэш не попадает)
  await currentChatKey(input.chatId).catch(() => {});
  const res = await sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, input.chatId, userId);
    // повтор уже принятого — ack, даже если права с тех пор отобрали
    const [again] = await tx`select * from messages where sender_id = ${userId} and client_id = ${input.clientId}`;
    if (again) return { message: toMessage((await openRows([again], '', tx))[0]), duplicate: true };
    // личный чат, а собеседник заблокировал отправителя: не пишем ничего (повтор уже принятого — по-прежнему ack)
    if (await blockedInDirect(tx, input.chatId, userId)) {
      const [existing] = await tx`select * from messages where sender_id = ${userId} and client_id = ${input.clientId}`;
      if (existing) return { message: toMessage((await openRows([existing], '', tx))[0]), duplicate: true };
      throw new DomainError('blocked');
    }
    // канал: публикуют только админы с правом post; ответов в ленте канала нет (обсуждение — в треде группы)
    let post: { author: string | null } | null = null;
    if (ctx.kind === 'channel') {
      if (!hasAdmin(ctx, 'post')) throw new DomainError('forbidden', 'post');
      if (input.replyToId != null) throw new DomainError('bad_frame', 'reply in channel');
      const [pc] = await tx`select c.signatures, u.name from chats c, users u where c.id = ${input.chatId} and u.id = ${userId}`;
      post = { author: pc.signatures ? (pc.name as string) : null };   // подпись — имя на момент поста
    }
    // копия без «Переслано от» — новое сообщение и может быть ответом; настоящая пересылка — нет (как в Telegram)
    const canReply = !input.forward || !!input.forward.hideSender;
    if (input.replyToId != null && canReply) {
      const [target] = await tx`select 1 from messages where chat_id = ${input.chatId} and id = ${input.replyToId}`;
      if (!target) throw new DomainError('not_found', 'reply target');
    }
    let attachment: Record<string, unknown> | null;
    let kind: string;
    let fwdFrom: ForwardInfo | null = null;
    let link: LinkPreview | null = null, fetchLink: string | null = null;
    let fwdTodo: Todo | null = null;
    let sticker: StickerRef | null = null;
    if (input.forward) {
      // пересылка: всё берём у оригинала — только из чата, где пересылающий состоит; вложение — тот же объект
      // (файл уже доступен получателям через fileFor: он лежит в сообщении их чата), заново не загружается
      const f = input.forward;
      const from = await groupCtx(tx, f.chatId, userId);
      if (from.protected) throw new DomainError('forbidden', 'protected');   // в группе запрещено копирование
      const [src] = await tx`select m.*, u.name as sender_name from messages m join users u on u.id = m.sender_id
        where m.chat_id = ${f.chatId} and m.id = ${f.id} and m.id >= ${from.historyFrom} and not m.deleted and m.service_type is null`;
      if (!src) throw new DomainError('not_found', 'forward source');
      await openRows([src], '', tx);   // текст и вложение оригинала — из шифра его чата
      attachment = (src.attachment as Record<string, unknown> | null) ?? null;
      // строка вложения — for share до конца транзакции: сборка мусора (storageGc.ts) не удалит его посреди пересылки
      if (attachment && !(await tx`select 1 from attachments where id = ${attachment.id as string} for share`).length) throw new DomainError('not_found', 'forward attachment');
      kind = src.kind as string;
      fwdTodo = (src.todo as Todo | null) ?? null;   // пересланный чек-лист — копия, только для чтения
      sticker = (src.sticker as StickerRef | null) ?? null;   // стикер пересылается своим снимком
      const dropCaption = !!f.hideCaption && !!attachment;
      body = dropCaption ? '' : src.body as string;
      entities = dropCaption || !Array.isArray(src.entities) ? [] : normalizeEntities(body, src.entities as Entity[]);
      // пересланное пересланного — исходный автор; «скрыть отправителя» — без заголовка, как своё
      // превью ссылки пересылается как есть (ещё грузится — копия получит его, когда оригинал загрузится, не раньше)
      blocks = (src.blocks as Block[] | null) ?? null;   // статья пересылается целиком
      const sl = src.link as LinkPreview | null;
      if (sl && !sl.pending && !dropCaption) link = sl;
      fwdFrom = f.hideSender ? null : (src.fwd_from as ForwardInfo | null) ?? {
        userId: Number(src.sender_id), name: src.sender_name as string, chatId: f.chatId, messageId: Number(src.id), at: (src.created_at as Date).toISOString(),
      };
    } else {
      attachment = input.attachment ? await attachmentForSend(tx, userId, input.attachment) as unknown as Record<string, unknown> : null;
      sticker = stickerId != null ? await stickerForSend(tx, userId, stickerId) : null;
      kind = sticker ? 'sticker' : todo ? 'todo' : attachment ? attachment.kind as string : 'text';
      // превью первой ссылки (как в Telegram): готовое в кэше — сразу, иначе «грузится» и задача link.preview
      const url = !attachment && !blocks && !todo && !sticker && !input.noLinkPreview ? firstUrl(body, entities) : null;
      if (url) {
        const cached = await cachedPreview(url);
        if (cached === undefined) { link = { url, pending: true }; fetchLink = url; } else link = cached;
      }
    }
    // права участника группы: вид сообщения, превью ссылок, медленный режим (админов не касается)
    requireRight(ctx, rightForKind(kind, attachment?.mime as string | undefined));
    if (link && !can(ctx, 'links')) { link = null; fetchLink = null; }
    if (ctx.slowMode && !ctx.admin) {
      const [last] = await tx`select created_at, group_id from messages where chat_id = ${input.chatId} and sender_id = ${userId} and service_type is null order by id desc limit 1`;
      const sameAlbum = last?.group_id && input.groupId && last.group_id === input.groupId;
      if (last && !sameAlbum && Date.now() - new Date(last.created_at as string).getTime() < ctx.slowMode * 1000) throw new DomainError('flood', 'slow_mode');
    }
    // содержимое — шифром ключа чата (messageContent.ts); открытыми остаются метаданные
    const c = await contentColumns(input.chatId, input.clientId, { body, entities: entities.length ? entities : null, todo: todo ?? fwdTodo, blocks, link, attachment }, tx);
    const inserted = await tx`
      insert into messages (chat_id, sender_id, client_id, kind, body, entities, reply_to_id, attachment, group_id, fwd_from, link, blocks, todo, sticker, content, has_link, post, post_author)
      values (${input.chatId}, ${userId}, ${input.clientId}, ${kind}, ${c.body}, ${c.entities?.length ? sql.json(c.entities as never) : null}, ${canReply ? input.replyToId ?? null : null}, ${c.attachment ? sql.json(c.attachment as never) : null},
              ${attachment && input.groupId && /^[0-9a-f-]{36}$/.test(input.groupId) ? input.groupId : null},   -- группа — только у вложений
              ${fwdFrom ? sql.json(fwdFrom as never) : null}, ${c.link ? sql.json(c.link as never) : null}, ${c.blocks ? sql.json(c.blocks as never) : null}, ${c.todo ? sql.json(c.todo as never) : null}, ${sticker ? sql.json(sticker as never) : null}, ${c.content}, ${c.hasLink}, ${!!post}, ${post?.author ?? null})
      on conflict (sender_id, client_id) do nothing
      returning *`;
    if (inserted.length === 0) {
      const [existing] = await tx`select * from messages where sender_id = ${userId} and client_id = ${input.clientId}`;
      return { message: toMessage((await openRows([existing], '', tx))[0]), duplicate: true };
    }
    const message = toMessage((await openRows([inserted[0]], '', tx))[0]);
    await burnCodes(tx, userId, body);
    await chatEvent(tx, input.chatId, { type: 'newMessage', message }, ctx.kind);
    if (post) {
      // свой пост — не непрочитанный: senderId у поста 0, другие устройства автора сняли бы +1 только по readOwn
      await tx`update chat_members set last_read_id = greatest(last_read_id, ${message.id}) where chat_id = ${input.chatId} and user_id = ${userId}`;
      await appendUpdates(tx, [{ userId, update: { type: 'readOwn', chatId: input.chatId, upToId: message.id } }]);
    }
    // как в Telegram: новое сообщение возвращает чат из архива (если не заглушён). Группы — клиент условной операцией
    // unarchive (chatFlags.ts): запись каждому участнику на каждое сообщение для них непозволительна
    if (ctx.kind === 'direct') await unarchiveOnMessage(tx, input.chatId, userId);
    await clearDraftInTx(tx, userId, input.chatId); // отправили — черновик на всех устройствах больше не нужен
    // уйдёт после коммита, воркером: ack не ждёт push-сервис. В задаче — ссылка: текст в jobs не храним
    await enqueue(tx, 'push.message', { chatId: input.chatId, id: message.id });
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
    // ссылка теперь в шифре — сверяем после открытия строки, под блокировкой
    const row = await updateContent(tx, p.chatId, p.id, (c, r) => {
      const l = c.link as { url?: string; pending?: boolean } | null;
      return !r.deleted && l?.url === p.url && l.pending === true ? { link: data } : false;
    });
    if (!row) return;
    await chatEvent(tx, p.chatId, { type: 'linkPreview', chatId: p.chatId, id: p.id, link: data });
  });
}
