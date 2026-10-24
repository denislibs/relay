import type { Update } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { assertMember } from './chats';
import { DomainError } from './errors';
import { appendUpdates } from './journal';

/** Сколько чатов можно закрепить в одном списке («Все» и «Архив» — отдельно), как у Telegram без Premium. */
export const PIN_LIMIT = 5;

export interface ChatFlags { pinnedAt: number | null; archived: boolean; unreadMark: boolean; archivedAtId: number }

type Row = { pinned_at: Date | null; archived: boolean; unread_mark: boolean; archived_at_id?: number | string | null };
const toFlags = (r: Row): ChatFlags => ({ pinnedAt: r.pinned_at ? new Date(r.pinned_at).getTime() : null, archived: !!r.archived, unreadMark: !!r.unread_mark, archivedAtId: Number(r.archived_at_id ?? 0) });
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
    const [cur] = await tx`select pinned_at, archived, unread_mark, archived_at_id from chat_members where chat_id = ${chatId} and user_id = ${userId} for update`;
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
    // граница архива — при каждой записи archived = true (не только на переходе): повторная архивация, ушедшая раньше
    // стоящего в очереди unarchive, должна её сдвинуть. Снятие архива границу не трогает
    const [row] = await tx`
      update chat_members set pinned_at = ${pinnedAt}, archived = ${archived}, unread_mark = ${unreadMark},
             archived_at_id = ${archived ? sql`(select coalesce(max(id), 0) from messages where chat_id = ${chatId})` : sql`archived_at_id`}
       where chat_id = ${chatId} and user_id = ${userId}
       returning pinned_at, archived, unread_mark, archived_at_id`;
    const next = toFlags(row as Row);
    if (next.pinnedAt !== was.pinnedAt || next.archived !== was.archived || next.unreadMark !== was.unreadMark || next.archivedAtId !== was.archivedAtId) {
      await appendUpdates(tx, [{ userId, update: update(chatId, next) }]);
    }
    return next;
  });
}

/** Прочитал чат (на любом устройстве) — пометка «непрочитанное» больше не нужна. */
export async function clearUnreadMark(tx: Tx, userId: number, chatId: number): Promise<void> {
  const rows = await tx`
    update chat_members set unread_mark = false where chat_id = ${chatId} and user_id = ${userId} and unread_mark
    returning pinned_at, archived, unread_mark, archived_at_id`;
  if (rows.length) await appendUpdates(tx, [{ userId, update: update(chatId, toFlags(rows[0] as Row)) }]);
}

/** Личный чат: новое сообщение возвращает чат из архива собеседнику, если уведомления включены (как в Telegram); заглушённый остаётся. */
export async function unarchiveOnMessage(tx: Tx, chatId: number, senderId: number): Promise<void> {
  const rows = await tx`
    update chat_members set archived = false, pinned_at = null
     where chat_id = ${chatId} and user_id <> ${senderId} and archived and (mute_until is null or mute_until <= now())
     returning user_id, pinned_at, archived, unread_mark, archived_at_id`;
  if (rows.length) await appendUpdates(tx, rows.map((r) => ({ userId: r.user_id as number, update: update(chatId, toFlags(r as Row)) })));
}

/**
 * Группа: клиент увидел сообщение в архивном незаглушённом чате и просит снять архив. Снимаем, только если сообщение
 * новее границы архива (повтор старых событий через syncChat или отложенная очередь ничего не меняют), не моё,
 * существует, и чат не заглушён на момент операции. Снятие — тот же путь, что ручное: закрепление сбрасывается,
 * другие устройства получают chatFlags. Ответ — всегда текущие флаги.
 */
export async function unarchiveByMessage(userId: number, chatId: number, body: unknown): Promise<ChatFlags & { changed: boolean }> {
  const messageId = Number((body as { messageId?: unknown } | null)?.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new DomainError('bad_frame', 'messageId');
  return sql.begin(async (tx) => {
    const [cur] = await tx`select m.pinned_at, m.archived, m.unread_mark, m.archived_at_id, (m.mute_until is not null and m.mute_until > now()) as muted, c.deleted_at
                             from chat_members m join chats c on c.id = m.chat_id where m.chat_id = ${chatId} and m.user_id = ${userId} for update of m`;
    if (!cur) throw new DomainError('not_member');
    if (cur.deleted_at) throw new DomainError('not_found', 'chat');
    const was = toFlags(cur as Row);
    const muted = !!cur.muted;   // в базе: 'infinity' — навсегда
    const [m] = await tx`select sender_id from messages where chat_id = ${chatId} and id = ${messageId} and not deleted`;
    const ok = was.archived && !muted && messageId > was.archivedAtId && !!m && Number(m.sender_id) !== userId;
    if (!ok) return { ...was, changed: false };
    const [row] = await tx`update chat_members set archived = false, pinned_at = null where chat_id = ${chatId} and user_id = ${userId} returning pinned_at, archived, unread_mark, archived_at_id`;
    const next = toFlags(row as Row);
    await appendUpdates(tx, [{ userId, update: update(chatId, next) }]);
    return { ...next, changed: true };
  });
}
