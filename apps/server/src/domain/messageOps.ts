import { unpinDeleted } from './pins';
import { canEditKind, emojiKey, normalizeEntities, trimFormatted, type Entity, type Reaction } from '@relay/protocol';
import { sql } from '../db';
import { assertMember } from './chats';
import { DomainError } from './errors';
import { dropUnreadReactions, noteReaction } from './reactionsUnread';
import { chatEvent } from './journal';
import { updateContent } from './messageContent';
import { blockedInDirect } from './privacy';
import { isServiceChat } from './service';
import { burnCodes } from './login';
import { enqueue } from '../jobs/queue';
import { can, groupCtx, hasAdmin } from './groupRights';
import { reactPost, type Counts } from './reactionCounts';
import { messageCtx, recountThread, withCopy } from './threads';
import { collectMentions } from './mentions';
import type { Tx } from '../db';

const MAX_BODY = 4096;
const EMOJI = /^\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*$/u;

/** Строка под замком; копия поста в группе обсуждения (origin) из группы не правится и не удаляется — только через пост. */
async function lockMessage(tx: Parameters<typeof assertMember>[0], chatId: number, id: number) {
  const [m] = await tx`select sender_id, deleted, service_type, origin, thread_id from messages where chat_id = ${chatId} and id = ${id} for update`;
  if (!m || m.deleted) throw new DomainError('not_found', 'message');
  if (m.origin != null) throw new DomainError('forbidden', 'post copy');
  return m;
}

async function ownMessage(tx: Parameters<typeof assertMember>[0], userId: number, chatId: number, id: number) {
  const m = await lockMessage(tx, chatId, id);
  if (m.sender_id !== userId) throw new DomainError('forbidden', 'not your message');
  return m;
}

/** Правка своего сообщения (в канале — и чужого поста админом с правом edit, без срока): новое тело и отметка «изм.» —
 *  всем участникам через журнал. */
export async function editMessage(userId: number, chatId: number, id: number, body: string, rawEntities?: Entity[]): Promise<{ editedAt: string }> {
  const { text, entities } = trimFormatted(body, normalizeEntities(body, rawEntities));
  if (!text) throw new DomainError('bad_frame', 'empty body');
  if (text.length > MAX_BODY) throw new DomainError('too_long');
  return sql.begin(async (tx) => {
    const ctx = await messageCtx(tx, chatId, userId, id);   // и гость треда — свой комментарий (threads.ts)
    if (ctx.kind === 'channel' && hasAdmin(ctx, 'edit')) {
      const [m] = await tx`select deleted, service_type from messages where chat_id = ${chatId} and id = ${id} for update`;
      if (!m || m.deleted || m.service_type) throw new DomainError('not_found', 'message');
    } else await ownMessage(tx, userId, chatId, id);   // в служебном чате — тоже только свои (сообщения Relay не правятся)
    // пересланное — чужой текст: как в Telegram, его не правит ни переславший, ни админ канала
    // (пересылка «без автора» — уже своё сообщение, fwd_from у неё нет)
    const [f] = await tx`select fwd_from is not null as fwd, kind from messages where chat_id = ${chatId} and id = ${id}`;
    if (f?.fwd) throw new DomainError('forbidden', 'forwarded');
    // текста у таких нет (как в Telegram): правка дописала бы стикеру или кружку подпись и сломала пузырь;
    // чек-лист правится своей операцией (todoEdit), иначе потерялись бы задачи
    if (f && !canEditKind(f.kind as string)) throw new DomainError('forbidden', 'kind');
    // заблокированный не правит сообщения в личном чате с тем, кто его заблокировал
    if (await blockedInDirect(tx, chatId, userId)) throw new DomainError('blocked');
    await burnCodes(tx, userId, text);
    const row = (await updateContent(tx, chatId, id, (c) => {
      // статью обычной правкой текста не меняем (иначе пропадут блоки); блоки — в шифре, проверка после открытия
      if (c.blocks) throw new DomainError('bad_frame', 'article edit');
      return { body: text, entities: entities.length ? entities : null };
    }, () => ({ edited_at: sql`now()` })))!;
    const editedAt = new Date(row.edited_at as string).toISOString();
    await chatEvent(tx, chatId, { type: 'messageEdited', chatId, id, body: text, editedAt, entities });
    await enqueue(tx, 'search.sync', { id });
    // новые @имена правки — новые упоминания; убранные остаются (как в Telegram)
    await collectMentions(tx, ctx, row);
    // пост канала — та же правка копии в группе обсуждения
    if (ctx.kind === 'channel') await withCopy(tx, chatId, id, async (groupId, copyId) => {
      const copy = await updateContent(tx, groupId, copyId, () => ({ body: text, entities: entities.length ? entities : null }), () => ({ edited_at: sql`now()` }));
      if (copy) await chatEvent(tx, groupId, { type: 'messageEdited', chatId: groupId, id: copyId, body: text, editedAt: new Date(copy.edited_at as string).toISOString(), entities }, 'group');
    });
    return { editedAt };
  });
}

/** Удаление своего сообщения у всех (как в Telegram): сообщение исчезает из истории целиком, тело стирается, реакции
 *  уходят вместе с ним. Пересланные копии в других чатах — свои строки, их это не касается. */
export async function deleteMessage(userId: number, chatId: number, id: number): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    const ctx = await messageCtx(tx, chatId, userId, id);   // и гость треда — свой комментарий (threads.ts)
    // админ группы с правом удалять — и чужие (кроме служебных)
    let m;
    if (hasAdmin(ctx, 'delete')) {
      m = await lockMessage(tx, chatId, id);
      if (m.service_type) throw new DomainError('not_found', 'message');
    } else m = await ownMessage(tx, userId, chatId, id);
    await erase(tx, chatId, id, ctx.kind);
    // пост канала — копия в группе обсуждения удаляется тоже: из ленты группы пропадает, тред остаётся (шапка «Пост удалён»)
    if (ctx.kind === 'channel') await withCopy(tx, chatId, id, (groupId, copyId) => erase(tx, groupId, copyId, 'group'));
    // комментарий — счётчики треда заново
    if (m.thread_id != null) await recountThread(tx, chatId, Number(m.thread_id));
    return { ok: true };
  });
}

/** Стереть сообщение у всех (замок строки уже взят): текст и шифр целиком, реакции, закреп; событие в журнал чата. */
async function erase(tx: Tx, chatId: number, id: number, kind: 'direct' | 'group' | 'channel'): Promise<void> {
  // текст и шифр стираются целиком: у удалённого не остаётся содержимого ни открыто, ни шифром
  // и вложение: у старых (до шифрования) строк в нём открытые имя, название и миниатюра (CRYPTO-9)
  await tx`update messages set body = '', entities = null, todo = null, blocks = null, link = null, content = null, attachment = null, deleted = true where chat_id = ${chatId} and id = ${id}`;
  await tx`delete from reactions where chat_id = ${chatId} and message_id = ${id}`;
  await tx`delete from message_mentions where chat_id = ${chatId} and message_id = ${id}`;   // «@» у упомянутых гаснет
  await dropUnreadReactions(tx, chatId, id);   // и «сердце» у автора
  if (kind === 'channel') await tx`delete from message_reaction_counts where chat_id = ${chatId} and message_id = ${id}`;
  await chatEvent(tx, chatId, { type: 'messageDeleted', chatId, id }, kind);
  await enqueue(tx, 'search.sync', { id });   // убрать из индекса
  await unpinDeleted(tx, chatId, id);
}

/** Реакция (null — снять). Одна от пользователя; всем участникам уходит полный список реакций сообщения.
 *  Канал — счётчиками (reactionCounts.ts): событие reactionCounts раз в секунду на пост, в ответе — counts и mine. */
export async function reactMessage(userId: number, chatId: number, id: number, emoji: string | null): Promise<{ reactions: Reaction[]; counts?: Counts; mine?: string | null }> {
  if (emoji !== null && !EMOJI.test(emoji)) throw new DomainError('bad_frame', 'emoji');
  return sql.begin(async (tx) => {
    const ctx = await messageCtx(tx, chatId, userId, id);   // и гость треда — сообщения треда (threads.ts)
    if (await isServiceChat(tx, chatId)) throw new DomainError('forbidden');   // служебный чат только для чтения
    if (emoji) {   // реакции в группе: право участника и набор, разрешённый группой
      if (!can(ctx, 'react') || ctx.reactions.mode === 'none') throw new DomainError('forbidden', 'react');
      // набор сравниваем по ключу без FE0F: старые настройки и клиенты шлют «❤️», новые — «❤»
      if (ctx.reactions.mode === 'some' && !ctx.reactions.allowed.some((a) => emojiKey(a) === emojiKey(emoji))) throw new DomainError('forbidden', 'reaction');
    }
    if (ctx.kind === 'channel') return reactPost(tx, userId, chatId, id, ctx.historyFrom, emoji);
    const [m] = await tx`select deleted from messages where chat_id = ${chatId} and id = ${id} and id >= ${ctx.historyFrom}`;
    if (!m || m.deleted) throw new DomainError('not_found', 'message');
    if (await blockedInDirect(tx, chatId, userId)) throw new DomainError('blocked');
    const [was] = await tx`select emoji from reactions where chat_id = ${chatId} and message_id = ${id} and user_id = ${userId}`;
    if (emoji) {
      await tx`insert into reactions (chat_id, message_id, user_id, emoji) values (${chatId}, ${id}, ${userId}, ${emoji})
               on conflict (chat_id, message_id, user_id) do update set emoji = excluded.emoji, created_at = now()`;
    } else {
      await tx`delete from reactions where chat_id = ${chatId} and message_id = ${id} and user_id = ${userId}`;
    }
    const rows = await tx`select user_id, emoji from reactions where chat_id = ${chatId} and message_id = ${id} order by created_at`;
    const reactions = rows.map((r) => ({ userId: r.user_id as number, emoji: r.emoji as string }));
    await chatEvent(tx, chatId, { type: 'reactions', chatId, id, reactions });
    await noteReaction(tx, chatId, id, userId, (was?.emoji as string | undefined) ?? null, emoji);   // автору — непрочитанная реакция (кнопка «сердце»)
    return { reactions };
  });
}

/** Получатель прослушал голосовое или посмотрел кружок: отметка всем участникам (у отправителя гаснет точка). Повтор — без записи. */
export async function markListened(userId: number, chatId: number, id: number): Promise<{ changed: boolean }> {
  return sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    const [m] = await tx`select sender_id, kind, deleted, listened from messages where chat_id = ${chatId} and id = ${id} for update`;
    if (!m || m.deleted) throw new DomainError('not_found', 'message');
    if (m.kind !== 'voice' && m.kind !== 'round') throw new DomainError('bad_frame', 'not a voice message');
    if (m.sender_id === userId || m.listened) return { changed: false };   // своё не «прослушивается»
    await tx`update messages set listened = true where chat_id = ${chatId} and id = ${id}`;
    await chatEvent(tx, chatId, { type: 'mediaListened', chatId, id });
    return { changed: true };
  });
}
