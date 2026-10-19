import type { Message } from '@relay/protocol';
import type { Store } from './store';
import type { LocalChat, LocalMessage } from './types';

/*
 * Поля чата, производные из сообщений (last, lastAt, unread), пересчитываются только здесь: хранилище сообщает,
 * что случилось с сообщением. Значения сервера (applyChats) и сброс (resetForSnapshot) пишет само хранилище.
 */

/**
 * Сообщение чата добавлено, изменено или удалено (m — уже новое состояние; при отмене неотправленного — убранное).
 * Новое или правка последнего — становится last; удалили последнее — last и lastAt = предыдущего не удалённого
 * из памяти (чат опускается к дате нового верхнего сообщения, как в Telegram); не удалённых нет — lastAt прежний.
 */
export function onMessage(store: Store, chat: LocalChat, m: LocalMessage, kind: 'added' | 'edited' | 'deleted'): void {
  const last = chat.last;
  if (kind === 'deleted') {
    if (last?.key === m.key) {
      recomputeLast(store, chat);
      // в памяти ничего нет (чат не загружен) — остаётся удалённое: в превью «Сообщение удалено»
      if (!chat.last && m.deleted) chat.last = m;
    }
  } else if (!last || last.key === m.key || m.sort >= last.sort) {
    chat.last = m;
    if (m.createdAt > chat.lastAt) chat.lastAt = m.createdAt;
  }
  store.markChat(chat);
}

/**
 * last — самое позднее не удалённое из сообщений в памяти, lastAt — его время; все удалены — last самое позднее,
 * нет ни одного — null, lastAt в обоих случаях не трогаем. Черновик по-прежнему может поднять чат (sortAt).
 */
export function recomputeLast(store: Store, chat: LocalChat): void {
  const all = store.chatMessages(chat.id);
  let last: LocalMessage | null = all.length ? all[all.length - 1] : null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].deleted) continue;
    last = all[i];
    chat.lastAt = last.createdAt;
    break;
  }
  chat.last = last;
}

/** Входящее с сервера: живое (не история) чужое сообщение после прочитанного и после уже учтённых — +1 к unread. */
export function unreadOnArrival(store: Store, chat: LocalChat, m: Message, live: boolean): void {
  if (live && m.senderId !== store.userId && m.id > chat.lastReadId && m.id > chat.knownMaxId) chat.unread++;
}

/** Прочитали (from, to]: дочитали до конца — 0; иначе вычитаем известные чужие сообщения из этого диапазона. */
export function unreadAfterRead(store: Store, chat: LocalChat, from: number, to: number): number {
  if (to >= chat.knownMaxId) return 0;
  let n = 0;
  for (const m of store.chatMessages(chat.id)) {
    if (m.senderId !== store.userId && m.id != null && m.id > from && m.id <= to) n++;
  }
  return Math.max(0, chat.unread - n);
}
