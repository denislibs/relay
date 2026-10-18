/**
 * Папки с чатами: общая модель сервера, движка и веба.
 * «Все чаты» — встроенная, не хранится. Своя папка — набор правил: явно включённые и исключённые чаты,
 * типы чатов и флаги исключения. Проверка попадания чата — в вебе (apps/web/src/folders.ts).
 */
export interface ChatFolder {
  id: number;
  title: string;
  emoji: string | null;   // иконка папки (вкладки слева); null — по типу или общая
  include: number[];      // чаты, которые в папке всегда (если не исключены явно)
  exclude: number[];      // чаты, которых в папке нет никогда
  contacts: boolean;      // личные чаты с контактами
  nonContacts: boolean;   // личные чаты не с контактами
  groups: boolean;        // группы
  excludeMuted: boolean;  // кроме заглушённых
  excludeRead: boolean;   // кроме прочитанных
}

export const FOLDER_LIMITS = { folders: 10, chats: 200, title: 16, emoji: 16 } as const;
/** id своих папок начинаются с 2: 0 — «Все чаты», 1 зарезервирован (архив). */
export const FOLDER_MIN_ID = 2;
export const FOLDER_MAX_ID = 1_000_000;

/** Длина в графемах: эмодзи из нескольких кодовых точек считается одним символом. */
export function graphemes(s: string): number {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<unknown> } }).Segmenter;
  if (Seg) { let n = 0; for (const _ of new Seg(undefined, { granularity: 'grapheme' }).segment(s)) n++; return n; }
  return [...s].length;
}

const ids = (v: unknown): number[] => {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const x of v) if (typeof x === 'number' && Number.isSafeInteger(x) && x > 0 && !seen.has(x)) { seen.add(x); out.push(x); }
  return out;
};

/**
 * Папка из чего угодно (тело запроса, старый IDB, событие журнала): лишнее отброшено, недостающее — по умолчанию.
 * Чат, попавший в оба списка, остаётся только во включённых (как в Telegram). null — нет годного id.
 */
export function normalizeFolder(v: unknown): ChatFolder | null {
  const f = v as Partial<Record<keyof ChatFolder, unknown>> | null;
  if (!f || typeof f !== 'object') return null;
  const id = f.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < FOLDER_MIN_ID || id > FOLDER_MAX_ID) return null;
  const include = ids(f.include);
  const inc = new Set(include);
  const emoji = typeof f.emoji === 'string' && f.emoji.trim() ? f.emoji.trim() : null;
  return {
    id,
    title: typeof f.title === 'string' ? f.title.replace(/\s+/g, ' ').trim() : '',
    emoji,
    include,
    exclude: ids(f.exclude).filter((x) => !inc.has(x)),
    contacts: f.contacts === true,
    nonContacts: f.nonContacts === true,
    groups: f.groups === true,
    excludeMuted: f.excludeMuted === true,
    excludeRead: f.excludeRead === true,
  };
}

export type FolderError = 'folder_title' | 'folder_empty' | 'folder_too_many_chats' | 'folder_emoji';

/** Что не так с нормализованной папкой (null — можно сохранять). */
export function folderError(f: ChatFolder): FolderError | null {
  const n = graphemes(f.title);
  if (n < 1 || n > FOLDER_LIMITS.title) return 'folder_title';
  if (f.emoji !== null && (graphemes(f.emoji) !== 1 || f.emoji.length > FOLDER_LIMITS.emoji)) return 'folder_emoji';
  if (f.include.length > FOLDER_LIMITS.chats || f.exclude.length > FOLDER_LIMITS.chats) return 'folder_too_many_chats';
  if (!f.include.length && !f.contacts && !f.nonContacts && !f.groups) return 'folder_empty';
  return null;
}

/** Список папок из чего угодно: годные, без повторов id, не больше лимита. */
export function normalizeFolders(v: unknown): ChatFolder[] {
  if (!Array.isArray(v)) return [];
  const out: ChatFolder[] = [];
  const seen = new Set<number>();
  for (const raw of v) {
    const f = normalizeFolder(raw);
    if (f && !seen.has(f.id) && out.length < FOLDER_LIMITS.folders) { seen.add(f.id); out.push(f); }
  }
  return out;
}

/** Новый id: больше всех существующих (удалённые id не переиспользуются в пределах списка). */
export const nextFolderId = (folders: readonly ChatFolder[]): number => folders.reduce((m, f) => Math.max(m, f.id + 1), FOLDER_MIN_ID);
