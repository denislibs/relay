import { isVideoMedia, mediaTabs, type MediaTab, type Message } from '@relay/protocol';
import type { Store } from './store';
import type { LocalChat, LocalMessage } from './types';

/*
 * Поля чата, производные из сообщений (last, lastAt, unread), пересчитываются только здесь: хранилище сообщает,
 * что случилось с сообщением. Значения сервера (applyChats) и сброс (resetForSnapshot) пишет само хранилище.
 */

/**
 * Сообщение чата добавлено, изменено или удалено (m — уже новое состояние; при отмене неотправленного — убранное;
 * prev — прежнее, если было известно).
 * Новое или правка последнего — становится last; удалили последнее — last и lastAt = предыдущего не удалённого
 * из памяти (чат опускается к дате нового верхнего сообщения, как в Telegram); не удалённых нет — lastAt прежний.
 */
export function onMessage(store: Store, chat: LocalChat, m: LocalMessage, kind: 'added' | 'edited' | 'deleted', prev?: LocalMessage): void {
  countMedia(chat, m, prev);
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

/** Вкладки «Общих медиа», где лежит сообщение: удалённое и неотправленное — ни в одной. */
export function tabsOf(m: LocalMessage): MediaTab[] {
  if (m.deleted || m.id == null) return [];
  return mediaTabs({ kind: m.kind ?? 'text', attachment: m.attachment as Message['attachment'], body: m.body, entities: m.entities, service: m.service as Message['service'] });
}

/**
 * Счётчики вкладок (chat.mediaCounts), пока они есть. Новее учтённого (mediaCountsAt) — прибавляется и сдвигает
 * границу: повторный приход того же (снимок, перезапуск, страница) не считается дважды. Уже учтённое — разница
 * вкладок до и после (правка добавила или убрала ссылку, удаление — минус); прежнее неизвестно — не трогаем.
 */
function countMedia(chat: LocalChat, m: LocalMessage, prev: LocalMessage | undefined): void {
  const counts = chat.mediaCounts;
  if (!counts || m.id == null) return;
  // видео среди «Медиа» (counts.video) — пока сервер его прислал; удалённое видео — минус
  const video = (x: LocalMessage) => tabsOf(x).includes('media') && isVideoMedia(x as Pick<Message, 'kind' | 'attachment'>);
  if (m.id > (chat.mediaCountsAt ?? 0)) {
    chat.mediaCountsAt = m.id;
    for (const t of tabsOf(m)) counts[t]++;
    if (counts.video != null && video(m)) counts.video++;
    return;
  }
  if (prev?.id == null) return;
  const before = tabsOf(prev), after = tabsOf(m);
  for (const t of before) if (!after.includes(t)) counts[t] = Math.max(0, counts[t] - 1);
  for (const t of after) if (!before.includes(t)) counts[t]++;
  if (counts.video != null && video(prev) !== video(m)) counts.video = Math.max(0, counts.video + (video(m) ? 1 : -1));
}
