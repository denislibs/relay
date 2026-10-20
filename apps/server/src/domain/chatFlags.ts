import type { Update } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { assertMember } from './chats';
import { DomainError } from './errors';
import { appendUpdates } from './journal';

/** Сколько чатов можно закрепить в одном списке («Все» и «Архив» — отдельно), как у Telegram без Premium. */
export const PIN_LIMIT = 5;

export interface ChatFlags { pinnedAt: number | null; archived: boolean; unreadMark: boolean }

type Row = { pinned_at: Date | null; archived: boolean; unread_mark: boolean };
const toFlags = (r: Row): ChatFlags => ({ pinnedAt: r.pinned_at ? new Date(r.pinned_at).getTime() : null, archived: !!r.archived, unreadMark: !!r.unread_mark });
const update = (chatId: number, f: ChatFlags): Update => ({ type: 'chatFlags', chatId, ...f });

/**
 * Закрепить / в архив / отметить непрочитанным (поля тела необязательны: pinned, archived, unreadMark — boolean).
 * Перенос в архив и обратно снимает закрепление: у каждого списка свои закреплённые. Запись — только в журнал самого
 * пользователя; ничего не поменялось — журнал не трогаем.
 */
export async function setChatFlags(userId: number, chatId: number, body: unknown): Promise<ChatFlags> {
  const b = (body ?? {}) as { pinned?: unknown; archived?: unknown; unreadMark?: unknown };
  for (const k of ['pinned', 'archived', 'unreadMark'] as const) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw new DomainError('bad_frame', k);
  return sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    const [cur] = await tx`select pinned_at, archived, unread_mark from chat_members where chat_id = ${chatId} and user_id = ${userId} for update`;
    const was = toFlags(cur as Row);
    const archived = (b.archived as boolean | undefined) ?? was.archived;
    let pinned = was.pinnedAt != null && archived === was.archived;   // в другой список закрепление не переезжает
    if (b.pinned === false) pinned = false;
    let pinNow = false;
    if (b.pinned === true && !pinned) {
      const [{ n }] = await tx`select count(*)::int as n from chat_members where user_id = ${userId} and archived = ${archived} and pinned_at is not null and chat_id <> ${chatId}`;
      if ((n as number) >= PIN_LIMIT) throw new DomainError('pin_limit');
      pinned = true; pinNow = true;
    }
    const unreadMark = (b.unreadMark as boolean | undefined) ?? was.unreadMark;
    const pinnedAt = pinNow ? sql`now()` : pinned ? sql`pinned_at` : sql`null`;
    const [row] = await tx`
      update chat_members set pinned_at = ${pinnedAt}, archived = ${archived}, unread_mark = ${unreadMark}
       where chat_id = ${chatId} and user_id = ${userId}
       returning pinned_at, archived, unread_mark`;
    const next = toFlags(row as Row);
    if (next.pinnedAt !== was.pinnedAt || next.archived !== was.archived || next.unreadMark !== was.unreadMark) {
      await appendUpdates(tx, [{ userId, update: update(chatId, next) }]);
    }
    return next;
  });
}

/** Прочитал чат (на любом устройстве) — пометка «непрочитанное» больше не нужна. */
export async function clearUnreadMark(tx: Tx, userId: number, chatId: number): Promise<void> {
  const rows = await tx`
    update chat_members set unread_mark = false where chat_id = ${chatId} and user_id = ${userId} and unread_mark
    returning pinned_at, archived, unread_mark`;
  if (rows.length) await appendUpdates(tx, [{ userId, update: update(chatId, toFlags(rows[0] as Row)) }]);
}

/** Новое сообщение возвращает чат из архива тем, у кого уведомления чата включены (как в Telegram); заглушённые остаются. */
export async function unarchiveOnMessage(tx: Tx, chatId: number, senderId: number): Promise<void> {
  const rows = await tx`
    update chat_members set archived = false, pinned_at = null
     where chat_id = ${chatId} and user_id <> ${senderId} and archived and (mute_until is null or mute_until <= now())
     returning user_id, pinned_at, archived, unread_mark`;
  if (rows.length) await appendUpdates(tx, rows.map((r) => ({ userId: r.user_id as number, update: update(chatId, toFlags(r as Row)) })));
}
