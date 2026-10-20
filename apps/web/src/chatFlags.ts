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
