// Закрепить, в архив, отметить непрочитанным — как в Telegram (настройка аккаунта: одна на все устройства).
// Правка уходит операцией setChatFlags (очередь движка, переживает офлайн) и видна сразу; сервер рассылает её
// по журналу остальным устройствам. Лимит закреплённых проверяем здесь же, до отправки (как telegram-tt).
import { getGlobal } from './global';
import { showToast } from './settingsData';

export const PIN_LIMIT = 5;   // в «Все» и в «Архиве» — у каждого свой (сервер: domain/chatFlags.ts)

type FlagsIn = { pinned?: boolean; archived?: boolean; unreadMark?: boolean };
type Chat = object | null | undefined;   // строка списка (Item): смотрим только pinnedAt, archived, unreadMark
const f = (c: Chat) => (c ?? {}) as { pinnedAt?: unknown; archived?: unknown; unreadMark?: unknown };
let setFlags: (chatId: number, flags: FlagsIn) => Promise<unknown> = () => Promise.reject(new Error('engine not started'));
/** Действие движка; привязывает data.ts (там же движок). */
export function bindChatFlags(fn: typeof setFlags): void { setFlags = fn; }
const send = (chatId: number, flags: FlagsIn) => { setFlags(chatId, flags).catch((e) => console.warn('chat flags:', String(e))); };

export const isPinned = (c: Chat) => typeof f(c).pinnedAt === 'number';
export const isArchived = (c: Chat) => !!f(c).archived;
export const hasUnreadMark = (c: Chat) => !!f(c).unreadMark;

const chatById = (id: number) => getGlobal().chats.find((c) => c.id === id);

/** Закрепить / открепить. Закреплённых в этом списке уже PIN_LIMIT — тост, на сервер не уходит. */
export function togglePin(chatId: number): void {
  const c = chatById(chatId);
  if (isPinned(c)) { send(chatId, { pinned: false }); return; }
  const archived = isArchived(c);
  const pinned = getGlobal().chats.filter((x) => isPinned(x) && isArchived(x) === archived && x.id !== chatId).length;
  if (pinned >= PIN_LIMIT) { showToast(`Закрепить можно не больше ${PIN_LIMIT} чатов. Открепите один из них.`, 3500); return; }
  send(chatId, { pinned: true });
}

/** В архив / из архива (закрепление в другой список не переезжает — снимает сервер и движок). */
export function toggleArchive(chatId: number): void {
  const archived = !isArchived(chatById(chatId));
  send(chatId, { archived });
  showToast(archived ? 'Чат перенесён в архив' : 'Чат возвращён из архива');
}

export function markUnread(chatId: number): void { send(chatId, { unreadMark: true }); }
export function clearUnreadMark(chatId: number): void { if (hasUnreadMark(chatById(chatId))) send(chatId, { unreadMark: false }); }

/** Выбранные в порядке списка, сверху вниз. */
export function inListOrder(ids: readonly number[], list: readonly object[]): number[] {
  const set = new Set(ids);
  return list.map((c) => (c as { id: number }).id).filter((id) => set.has(id));
}

/** Хватит ли места закрепить ids: у «Всех» и «Архива» лимит свой (PIN_LIMIT). */
export function pinRoom(ids: readonly number[], chats: readonly (Chat & { id?: unknown })[]): boolean {
  const byId = new Map(chats.map((c) => [c.id as number, c]));
  for (const archived of [false, true]) {
    const add = ids.filter((id) => { const c = byId.get(id); return c && !isPinned(c) && isArchived(c) === archived; }).length;
    if (add && chats.filter((c) => isPinned(c) && isArchived(c) === archived).length + add > PIN_LIMIT) return false;
  }
  return true;
}

/**
 * Закрепить / открепить несколько. Порядок закреплённых — по времени закрепления (позже — выше), поэтому
 * шлём снизу вверх: верхний из выбранных окажется выше. Не влезает в лимит — тост, ничего не уходит.
 */
export function pinMany(ids: number[], pinned: boolean): boolean {
  const chats = getGlobal().chats;
  const todo = inListOrder(ids, chats).filter((id) => isPinned(chatById(id)) !== pinned);
  if (pinned && !pinRoom(todo, chats)) { showToast(`Закрепить можно не больше ${PIN_LIMIT} чатов. Открепите один из них.`, 3500); return false; }
  for (const id of (pinned ? todo.reverse() : todo)) send(id, { pinned });
  return true;
}

export function archiveMany(ids: number[], archived: boolean): void {
  const todo = ids.filter((id) => isArchived(chatById(id)) !== archived);
  for (const id of todo) send(id, { archived });
  if (todo.length) showToast(archived ? (todo.length > 1 ? 'Чаты перенесены в архив' : 'Чат перенесён в архив') : (todo.length > 1 ? 'Чаты возвращены из архива' : 'Чат возвращён из архива'));
}

/** Отметка «непрочитано»; снять — только с тех, у кого она есть (счётчик гасит data.seen в chatSelectRun). */
export function markUnreadMany(ids: number[], unread: boolean): void {
  for (const id of ids) if (hasUnreadMark(chatById(id)) !== unread) send(id, { unreadMark: unread });
}
