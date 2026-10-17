import { getPrefs, type Prefs } from './prefs';

// Автозагрузка медиа: чистое решение «грузить ли вложение само». Медиа-код вызывает shouldAutoload
// с getPrefs().autoload; настройки хранятся на устройстве (prefs.ts).
export type MediaKind = 'photo' | 'video' | 'file';
export type ChatKind = 'contact' | 'private' | 'group';   // личный чат с контактом / с не-контактом / группа
type Autoload = Prefs['autoload'];

const FIELD = { contact: 'contacts', private: 'private', group: 'groups' } as const;

export function shouldAutoload(prefs: { autoload: Autoload }, a: { kind: MediaKind; chat: ChatKind; size: number }): boolean {
  const al = prefs.autoload;
  if (!al.enabled || !al[a.kind][FIELD[a.chat]]) return false;
  return a.kind !== 'file' || a.size <= al.fileMaxMb * 1024 * 1024;
}

const LABELS: [keyof Autoload['photo'], string][] = [['contacts', 'контакты'], ['private', 'личные чаты'], ['groups', 'группы']];

/** Подпись строки: «Вкл. для всех чатов» / «Контакты, личные чаты» / «Выкл.»; у файлов — «, до N МБ». */
export function autoloadSubtitle(al: Autoload, kind: MediaKind): string {
  const on = LABELS.filter(([k]) => al[kind][k]);
  if (!on.length) return 'Выкл.';
  const base = on.length === LABELS.length ? 'Вкл. для всех чатов' : on.map(([, t]) => t).join(', ').replace(/^./, (c) => c.toUpperCase());
  return kind === 'file' ? `${base}, до ${al.fileMaxMb} МБ` : base;
}

/** Значения автозагрузки совпадают с умолчаниями (кнопка «Сбросить» неактивна). */
export function isDefaultAutoload(al: Autoload, def: Autoload): boolean {
  return JSON.stringify(al) === JSON.stringify(def);
}

/** Автовоспроизведение GIF / беззвучного видео (Анимации и производительность). Для медиа-сессии: вызывать перед play(). */
export function canAutoplay(kind: 'gif' | 'video', prefs: { anim: Prefs['anim'] } = getPrefs()): boolean {
  return kind === 'gif' ? prefs.anim.autoplayGif : prefs.anim.autoplayVideo;
}

/** Вид чата для автозагрузки: группа; личный с контактом; личный с не-контактом. */
export function chatKindFor(chat: Record<string, unknown> | undefined, contactIds: ReadonlySet<number>): ChatKind {
  if (chat?.kind === 'group') return 'group';
  return typeof chat?.peerId === 'number' && contactIds.has(chat.peerId) ? 'contact' : 'private';
}

/** Политика для MediaPolicy кита (лента чата): что грузить само. Видео пока нет — флаг для будущего MediaBubble. */
export function mediaPolicy(prefs: { autoload: Autoload; anim: Prefs['anim'] }, chat: ChatKind): { photo: boolean; video: boolean; autoplayVideo: boolean; autoplayGif: boolean } {
  return {
    photo: shouldAutoload(prefs, { kind: 'photo', chat, size: 0 }),
    video: shouldAutoload(prefs, { kind: 'video', chat, size: 0 }),
    autoplayVideo: canAutoplay('video', prefs),
    autoplayGif: canAutoplay('gif', prefs),
  };
}
