import { SAVED_TITLE } from '@relay/protocol';
import { sql } from '../db';

/**
 * «Избранное» пользователя: существующее или новое. Личный чат с единственным участником — собой: сообщения, журнал,
 * шифр, поиск и медиа работают как в обычном личном чате, чужому его не открыть (не участник). Название лежит в
 * chats.title: поиск и прочие запросы берут coalesce(c.title, собеседник), а собеседника здесь нет.
 * Открыть — значит вернуть в список, если чат удаляли (hidden).
 */
export async function openSavedChat(userId: number): Promise<number> {
  return sql.begin(async (tx) => {
    // два устройства разом: замок по пользователю, чтобы второе не создало лишнего чата (первичный ключ — страховка)
    await tx`select pg_advisory_xact_lock(hashtextextended(${'saved:' + userId}, 0))`;
    const [found] = await tx`update saved_chats set hidden = false where user_id = ${userId} returning chat_id`;
    if (found) return Number(found.chat_id);
    const [chat] = await tx`insert into chats (kind, title) values ('direct', ${SAVED_TITLE}) returning id`;
    await tx`insert into chat_members (chat_id, user_id) values (${chat.id}, ${userId})`;
    await tx`insert into saved_chats (user_id, chat_id) values (${userId}, ${chat.id})`;
    return Number(chat.id);
  });
}
