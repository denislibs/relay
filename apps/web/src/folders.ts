// Папки с чатами: чистые правила — кто в папке, счётчик вкладки, иконка, подпись, рекомендуемые.
// Без DOM и глобального состояния, чтобы проверять юнит-тестами. Модель папки — @relay/protocol (folders.ts).
import type { ChatFolder } from '@relay/protocol';

/** Чат, как его видит фильтр (поля элемента подписки chatList). */
export interface FolderChat { id: number; kind: 'direct' | 'group'; peerId: number | null; unread: number; muteUntil?: number | null; unreadMark?: boolean; archived?: boolean }

/** Непрочитанный: есть непрочитанные сообщения или «Отметить как непрочитанное» (как в Telegram). */
export const isUnread = (c: FolderChat): boolean => c.unread > 0 || !!c.unreadMark;

/** Что фильтр знает о мире: контакты (id людей) и заглушён ли чат (muteUntil чата или умолчание аккаунта). */
export interface FolderCtx { contacts: ReadonlySet<number>; isMuted(c: FolderChat): boolean }

/** «Все чаты» — id 0: встроенная, первая, не хранится. */
export const ALL = 0;

/**
 * Попадает ли чат в папку. Порядок проверок как в Telegram: явное исключение сильнее всего,
 * явное включение сильнее флагов исключения, дальше «кроме прочитанных / заглушённых», дальше типы.
 */
export function inFolder(f: ChatFolder, c: FolderChat, ctx: FolderCtx): boolean {
  if (f.exclude.includes(c.id)) return false;
  if (f.include.includes(c.id)) return true;
  if (c.archived) return false;   // архив — только под строкой «Архив» (явно добавленный в папку — виден, проверено выше)
  if (f.excludeRead && !isUnread(c)) return false;
  if (f.excludeMuted && ctx.isMuted(c)) return false;
  if (c.kind === 'group') return f.groups;
  const contact = c.peerId !== null && ctx.contacts.has(c.peerId);
  return contact ? f.contacts : f.nonContacts;
}

/** Чаты папки в порядке основного списка (null / ALL — все). */
export function folderChats<T extends FolderChat>(f: ChatFolder | null, chats: readonly T[], ctx: FolderCtx): T[] {
  return f ? chats.filter((c) => inFolder(f, c, ctx)) : chats.slice();
}

/**
 * Счётчик вкладки — непрочитанные чаты (не сообщения). muted — все непрочитанные заглушены: бейдж серый.
 * Для «Все» заглушённые не считаются вовсе (как в Telegram Web K) — иначе бейдж «Все» всегда горит.
 */
export function folderBadge(f: ChatFolder | null, chats: readonly FolderChat[], ctx: FolderCtx): { count: number; muted: boolean } {
  let count = 0, loud = 0;
  for (const c of chats) {
    if (!isUnread(c) || (f ? !inFolder(f, c, ctx) : c.archived)) continue;   // архив в «Все» не считается — у него свой бейдж
    const m = ctx.isMuted(c);
    if (!f && m) continue;
    count++;
    if (!m) loud++;
  }
  return { count, muted: count > 0 && loud === 0 };
}

/** Эмодзи папки → монохромный значок (как в Telegram: хранится эмодзи, рисуется иконка). Порядок — порядок выбора. */
export const FOLDER_ICONS: Record<string, string> = {
  '💬': 'chats', '📁': 'folder', '⭐': 'star', '✅': 'checkCircle', '👤': 'contact', '👥': 'community',
  '💼': 'briefcase', '🏠': 'home', '❤️': 'heart', '🎓': 'graduation', '🎮': 'gamepad', '✈️': 'plane',
  '🛒': 'cart', '📢': 'channels', '🔔': 'bell', '🤖': 'bot',
};
// 📁 в выборе не нужен: первая кнопка («по типу чатов») и так рисует папку
export const FOLDER_EMOJI = Object.keys(FOLDER_ICONS).filter((e) => e !== '📁');

/** Иконка папки для вкладок слева: значок по эмодзи (чужое эмодзи — как есть), иначе по единственному типу, иначе общая папка. */
export function folderIcon(f: ChatFolder | null): { emoji: string } | { icon: string } {
  if (!f) return { icon: 'chats' };
  if (f.emoji) return FOLDER_ICONS[f.emoji] ? { icon: FOLDER_ICONS[f.emoji] } : { emoji: f.emoji };
  const only = onlyType(f);
  return { icon: only === 'groups' ? 'community' : only === 'contacts' || only === 'nonContacts' ? 'contact' : 'folder' };
}

type TypeFlag = 'contacts' | 'nonContacts' | 'groups';
const TYPE_LABEL: Record<TypeFlag, string> = { contacts: 'Все контакты', nonContacts: 'Все не контакты', groups: 'Все группы' };

/** Единственный тип без явных чатов — папка «про тип» (подпись «Все группы»). */
function onlyType(f: ChatFolder): TypeFlag | null {
  if (f.include.length || f.exclude.length) return null;
  const on = (['contacts', 'nonContacts', 'groups'] as const).filter((k) => f[k]);
  return on.length === 1 ? on[0] : null;
}

export const chatsWord = (n: number): string => {
  const d = n % 10, h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? 'чат' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'чата' : 'чатов'}`;
};

/** Подпись строки в настройках: «Все группы» для папки одного типа, иначе «N чатов» (сколько сейчас в ней). */
export function folderSubtitle(f: ChatFolder, count: number): string {
  const only = onlyType(f);
  return only && !f.excludeRead && !f.excludeMuted ? TYPE_LABEL[only] : chatsWord(count);
}

/** Рекомендуемые папки: правила без id. «Непрочитанные» — бывшая зашитая вкладка. */
export interface Recommended { key: string; folder: Omit<ChatFolder, 'id'>; description: string }
const empty = { emoji: null, include: [], exclude: [], contacts: false, nonContacts: false, groups: false, excludeMuted: false, excludeRead: false };
export const RECOMMENDED: readonly Recommended[] = [
  { key: 'unread', folder: { ...empty, title: 'Непрочитанные', emoji: '✅', contacts: true, nonContacts: true, groups: true, excludeRead: true }, description: 'Новые сообщения из всех чатов' },
  { key: 'personal', folder: { ...empty, title: 'Личные', emoji: '👤', contacts: true, nonContacts: true }, description: 'Только личные переписки' },
  { key: 'groups', folder: { ...empty, title: 'Группы', emoji: '👥', groups: true }, description: 'Только групповые чаты' },
];

/** Те же правила (без названия и иконки) — рекомендация уже добавлена. */
const sameRules = (a: Omit<ChatFolder, 'id'>, b: Omit<ChatFolder, 'id'>) =>
  a.contacts === b.contacts && a.nonContacts === b.nonContacts && a.groups === b.groups && a.excludeMuted === b.excludeMuted && a.excludeRead === b.excludeRead
  && !a.include.length && !b.include.length && !a.exclude.length && !b.exclude.length;

export const recommendedFor = (folders: readonly ChatFolder[]): Recommended[] => RECOMMENDED.filter((r) => !folders.some((f) => sameRules(f, r.folder)));

/** Переставить элемент списка (порядок папок при перетаскивании). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list.slice();
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
  return out;
}

/**
 * Чат в папку / из папки (меню чата). Добавить — во включённые (и из исключённых). Убрать — из включённых,
 * а если чат всё равно попадает по типу — в исключённые (как в Telegram Web K), иначе галочка не снялась бы.
 */
export function toggleChatInFolder(f: ChatFolder, c: FolderChat, ctx: FolderCtx): ChatFolder {
  if (inFolder(f, c, ctx)) {
    const next = { ...f, include: f.include.filter((x) => x !== c.id) };
    return inFolder(next, c, ctx) ? { ...next, exclude: [...next.exclude, c.id] } : next;
  }
  return { ...f, include: [...f.include, c.id], exclude: f.exclude.filter((x) => x !== c.id) };
}
