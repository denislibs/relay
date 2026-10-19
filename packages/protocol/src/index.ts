import type { Block } from './blocks';
import type { ProfileLink } from './links';
export * from './links';
export * from './folders';
import type { ChatFolder } from './folders';
import type { GroupInfo, MyMembership } from './groups';

export type Id = number;

/** Служебное сообщение от системного пользователя: машинный тип для отрисовки и склейки повторов. */
export type ServiceType = 'login_code' | 'new_login' | 'group_created' | 'welcome'
  | 'title_changed' | 'photo_changed' | 'photo_removed' | 'members_added' | 'member_left' | 'member_removed'
  | 'joined_by_link' | 'joined_by_request' | 'owner_changed' | 'protected_on' | 'protected_off'
  | 'todo_done' | 'todo_append';   // чек-лист: автор отметил / добавил задачи в список replyToId (номера — в data)
/** Участники служебного события (имена на момент события) и новое название. */
export interface ServiceData { users?: { id: Id; name: string }[]; title?: string; completed?: number[]; incompleted?: number[]; items?: number[] }   // group_created: тело — название группы, автор — создатель

export interface Message {
  id: Id;
  chatId: Id;
  senderId: Id;
  clientId: string;
  kind: 'text' | 'photo' | 'video' | 'file' | 'voice' | 'round' | 'audio' | 'todo';
  groupId?: string | null;   // отправлены вместе (несколько файлов) — в ленте одним пузырём
  body: string;
  replyToId: Id | null;
  createdAt: string; // ISO
  editedAt?: string | null;
  deleted?: boolean;
  reactions?: Reaction[];
  attachment?: Attachment | null;
  service?: { type: ServiceType; data?: ServiceData };   // есть только у служебных сообщений
  todo?: Todo;           // чек-лист (kind 'todo'): задачи и кто что отметил
  entities?: Entity[];   // оформление текста; нет или пусто — простой текст
  listened?: boolean;    // голосовое/кружок прослушан получателем
  fwdFrom?: ForwardInfo | null;   // переслано: откуда (нет — своё или отправитель скрыт)
  link?: LinkPreview | null;      // превью первой ссылки в тексте (pending — сервер ещё загружает страницу)
  blocks?: Block[] | null;        // «статья»: блоки (body — её простой текст)
}

/** Превью ссылки: сайт, заголовок, описание и картинка (уже в нашем хранилище: /files/<id>). */
export interface LinkPreview {
  url: string;
  pending?: boolean;
  siteName?: string | null; title?: string | null; description?: string | null;
  photo?: { id: string; w: number; h: number } | null;
}

/** Откуда пересланное: исходный автор (имя — на момент пересылки), чат и сообщение оригинала, когда оно написано. */
export interface ForwardInfo { userId: Id; name: string; chatId: Id; messageId: Id; at: string }
/** Ссылка на пересылаемое в кадре send: сервер сам берёт текст, оформление и вложение оригинала. */
export interface ForwardRef { chatId: Id; id: Id; hideSender?: boolean; hideCaption?: boolean }

/** Оформление куска текста: смещения в единицах UTF-16 (как String.length). Один тип сам с собой не перекрывается. */
export type EntityType = 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler' | 'code' | 'pre' | 'link' | 'date';
/** date — дата и время (как messageEntityFormattedDate в Telegram): date — unix-секунды, format — как показывать:
 *  'r' — относительно («завтра в 10:00»), иначе по порядку w (день недели), d / D (дата коротко / полностью),
 *  t / T (время коротко / с секундами); пусто — показать текст сообщения как есть. */
export interface Entity { type: EntityType; offset: number; length: number; url?: string; date?: number; format?: string }
export const DATE_FORMAT = /^(r|w?[dD]?[tT]?)$/;
export const ENTITY_TYPES: readonly EntityType[] = ['bold', 'italic', 'underline', 'strike', 'spoiler', 'code', 'pre', 'link', 'date'];
export const MAX_ENTITIES = 100;

/** Адрес ссылки, который можно показать: http(s) или mailto, без пробелов, до 2048 символов. */
export function entityUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 2048 || /\s/.test(s)) return null;
  return /^(https?:\/\/[^/?#\s]+|mailto:[^@\s]+@)/i.test(s) ? s : null;
}

/**
 * Проверка оформления от клиента: только известные типы и целые смещения в пределах текста, ссылки — безопасные,
 * один тип склеивается сам с собой, не больше MAX_ENTITIES. Мусор отбрасывается, а не превращается в ошибку.
 */
export function normalizeEntities(text: string, raw: unknown): Entity[] {
  if (!Array.isArray(raw)) return [];
  const by = new Map<string, Entity[]>();
  for (const e of raw.slice(0, MAX_ENTITIES * 2)) {
    if (!e || typeof e !== 'object') continue;
    const { type, offset, length } = e as Record<string, unknown>;
    if (!ENTITY_TYPES.includes(type as EntityType) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) continue;
    const s = Math.max(0, offset as number), end = Math.min(text.length, (offset as number) + (length as number));
    if (end <= s) continue;
    const url = type === 'link' ? entityUrl((e as { url?: unknown }).url) : undefined;
    if (type === 'link' && !url) continue;
    const date = type === 'date' ? (e as { date?: unknown }).date : undefined;
    const format = type === 'date' ? ((e as { format?: unknown }).format ?? '') : undefined;
    // дата: целые секунды с 1970 до 2100 года и формат из допустимых букв
    if (type === 'date' && (!Number.isSafeInteger(date) || (date as number) < 0 || (date as number) > 4102444800 || typeof format !== 'string' || !DATE_FORMAT.test(format))) continue;
    const key = type === 'link' ? 'link ' + url : type === 'date' ? 'date ' + date + ' ' + format : (type as string);
    const list = by.get(key) ?? [];
    list.push(url ? { type: 'link', offset: s, length: end - s, url } : type === 'date' ? { type: 'date', offset: s, length: end - s, date: date as number, ...(format ? { format: format as string } : {}) } : { type: type as EntityType, offset: s, length: end - s });
    by.set(key, list);
  }
  const out: Entity[] = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.offset - b.offset);
    let cur: Entity | null = null;
    for (const e of list) {
      if (cur && e.offset <= cur.offset + cur.length) cur.length = Math.max(cur.length, e.offset + e.length - cur.offset);
      else { cur = { ...e }; out.push(cur); }
    }
  }
  return out.sort((a, b) => a.offset - b.offset || b.length - a.length).slice(0, MAX_ENTITIES);
}

/** Обрезать пробелы по краям текста и сдвинуть оформление вместе с ним. */
export function trimFormatted(body: string, entities: Entity[]): { text: string; entities: Entity[] } {
  const lead = body.length - body.trimStart().length;
  const text = body.trim();
  return { text, entities: normalizeEntities(text, entities.map((e) => ({ ...e, offset: e.offset - lead }))) };
}

/** Вложение: фото (знает размеры заранее — лента не прыгает) или файл. thumb — крошечное размытое превью. */
export interface Attachment {
  id: string; kind: AttachmentKind; mime: string; name: string; size: number; w: number | null; h: number | null; thumb?: string | null;
  duration?: number | null;   // голосовое, кружок, видео и музыка: целые секунды
  waveform?: string | null;   // голосовое: 63 байта (100 значений по 5 бит, младшие биты первыми) в base64
  title?: string | null;      // музыка: из тегов файла
  performer?: string | null;
  spoiler?: boolean;          // фото и видео «под спойлером»: размыто, пока не нажмут (как в Telegram)
  /** Видео после обработки на сервере (до неё — нет): короткий немой ролик для ленты и облегчённые копии для просмотра.
   *  Адрес — /files/<id>/<name>; оригинал остаётся /files/<id>. */
  preview?: VideoVariant | null;
  variants?: VideoVariant[];
}
/** Копия видео: preview — первые секунды без звука, 360p, до 1 МБ (лента); '720' — H.264 720p (просмотрщик по умолчанию). */
export interface VideoVariant { name: 'preview' | '720'; w: number; h: number; size: number }
/** video — видео как медиа (кадр, длительность, играет в ленте); видео «как файл» остаётся file с mime video/*. */
export type AttachmentKind = 'photo' | 'video' | 'file' | 'voice' | 'round' | 'audio';
/** Вкладки «Общих медиа» (как в Telegram): медиа — фото и видео, файлы, музыка, голосовые и кружки, ссылки. */
export type MediaTab = 'media' | 'file' | 'audio' | 'voice' | 'link';
export const MEDIA_TABS: readonly MediaTab[] = ['media', 'file', 'link', 'audio', 'voice'];
/** Кружок: сторона квадрата и предел длительности (как в Telegram). */
export const ROUND_SIZE = 400;
export const ROUND_MAX_SECONDS = 60;
export const WAVEFORM_BYTES = 63;
/** Предел одного файла — как у Telegram без Premium: 2 ГБ. Сервер отказывает (file_too_big), клиент проверяет до очереди. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** Реакция: кто и какой эмодзи (одна от пользователя на сообщение). */
export interface Reaction { userId: Id; emoji: string }

export type Update =
  | { type: 'newMessage'; message: Message }
  | { type: 'readOwn'; chatId: Id; upToId: Id }
  | { type: 'readBy'; chatId: Id; userId: Id; upToId: Id }
  | { type: 'draft'; chatId: Id; text: string; at: string; entities?: Entity[] }   // черновик своих устройств; пустой текст — удалён
  | { type: 'messageEdited'; chatId: Id; id: Id; body: string; editedAt: string; entities?: Entity[] }
  | { type: 'todoUpdated'; chatId: Id; id: Id; todo: Todo; editedAt?: string }   // чек-лист целиком: отметили, добавили или изменили
  | { type: 'messageDeleted'; chatId: Id; id: Id }
  | { type: 'reactions'; chatId: Id; id: Id; reactions: Reaction[] }
  | { type: 'mediaListened'; chatId: Id; id: Id }   // голосовое/кружок прослушали
  | { type: 'userUpdated'; user: PublicUser }   // профиль изменился: себе и всем, кто видит пользователя
  // контакт добавлен/изменён (contact) или удалён (removed + user — как его видно без контакта); только владельцу
  | { type: 'contactsChanged'; contact?: Contact; removed?: Id; user?: PublicUser | null }
  // настройки аккаунта (общие для устройств) изменились: приходят целиком, только владельцу
  | { type: 'settingsChanged'; settings: UserSettings }
  // правила конфиденциальности изменились: приходят целиком, только владельцу
  | { type: 'privacyChanged'; rules: PrivacyRules }
  // чёрный список: человек заблокирован (blocked) или разблокирован (unblocked); только владельцу
  | { type: 'blocksChanged'; blocked?: BlockedUser; unblocked?: Id }
  | { type: 'sessionsChanged' }
  | { type: 'pins'; chatId: Id; ids: Id[] }
  | { type: 'linkPreview'; chatId: Id; id: Id; link: LinkPreview | null }
  | { type: 'attachmentUpdated'; chatId: Id; id: Id; attachment: Attachment }   // видео обработано: копии и faststart-оригинал
  // группа: информация и настройки целиком — всем участникам
  | { type: 'groupUpdated'; chatId: Id; group: GroupInfo }
  // моё место в группе (роль, права, исключение, звание) — только мне
  | { type: 'membership'; chatId: Id; me: MyMembership }
  // состав или роли участников изменились — перечитать список
  | { type: 'membersChanged'; chatId: Id }
  // чат больше не мой: вышел, удалили, группу удалили
  | { type: 'chatRemoved'; chatId: Id };   // превью ссылки сообщения загрузилось (null — превью нет)   // закреплённые сообщения чата целиком (новые сверху)   // список сеансов изменился: новый вход, подтверждение, завершение

/** Тело уведомления/push без предпросмотра: текст сообщения не раскрываем. */
export const NO_PREVIEW = 'Новое сообщение';

/** Вид чата для умолчаний уведомлений. */
export type NotifyType = 'direct' | 'group';
export interface NotifyPref { muted: boolean; preview: boolean }
/** Настройки аккаунта (GET /settings добавляет seq своей записи журнала на момент снимка). */
export interface UserSettings { notify: Record<NotifyType, NotifyPref>; sessionsTtlDays: number; folders: ChatFolder[] }   // folders — свои папки по порядку вкладок
export interface SettingsSnapshot extends UserSettings { privacy?: PrivacyRules; seq?: number }
/** Сроки автозавершения неактивных сеансов, дней (PUT /settings/sessions-ttl). */
export const SESSION_TTLS: readonly number[] = [7, 30, 90, 180, 365];

/** Сеанс (GET /sessions): устройство — грубо по User-Agent («Chrome 141, macOS»), IP входа; current — этот запрос. */
export interface SessionInfo { id: Id; device: string; ip: string | null; createdAt: string; lastActiveAt: string; current: boolean; online: boolean; unconfirmed: boolean }

/** Правила конфиденциальности. phoneDiscovery — «Кто найдёт меня по номеру» (только everyone | contacts). */
export type PrivacyKey = 'phone' | 'phoneDiscovery' | 'lastSeen' | 'bio' | 'birthday';
export type PrivacyMode = 'everyone' | 'contacts' | 'nobody';
export const PRIVACY_KEYS: readonly PrivacyKey[] = ['phone', 'phoneDiscovery', 'lastSeen', 'bio', 'birthday'];
/** Исключения: deny главнее allow, allow главнее mode. */
export interface PrivacyRule { mode: PrivacyMode; allow: Id[]; deny: Id[] }
export type PrivacyRules = Record<PrivacyKey, PrivacyRule>;
/** Умолчания, когда правила нет: номер — контактам, остальное — всем. */
export const defaultPrivacyRule = (key: PrivacyKey): PrivacyRule => ({ mode: key === 'phone' ? 'contacts' : 'everyone', allow: [], deny: [] });
export const defaultPrivacy = (): PrivacyRules => ({
  phone: defaultPrivacyRule('phone'), phoneDiscovery: defaultPrivacyRule('phoneDiscovery'), lastSeen: defaultPrivacyRule('lastSeen'),
  bio: defaultPrivacyRule('bio'), birthday: defaultPrivacyRule('birthday'),
});

/** Заблокированный: профиль глазами владельца списка и когда заблокирован. seq — как у Contact. */
export interface BlockedUser { userId: Id; user: PublicUser; at: string; seq?: number }

/** День рождения: год необязателен. */
export interface Birthday { day: number; month: number; year?: number }

/** Профиль глазами зрителя (скрытые правилами приватности поля сервер не отдаёт). */
/** Фото профиля: id — 640×640, small — 160×160 (оба — файлы /files/:id), thumb — крошечное размытое превью (data:URL), at — когда поставлено (мс). */
export interface ProfilePhoto { id: string; small: string; thumb: string; at: number; pid?: number; video?: string }
/** Фото из истории профиля (GET /users/:id/photos): pid — номер в истории; video — видео-аватарка (зацикленная, без звука). */
export interface UserPhoto { pid: number; id: string; small: string; thumb: string; video?: string; at: number }

export interface PublicUser {
  /** системный пользователь «Relay»: служебные уведомления, ответить нельзя */
  system?: true;
  id: Id; name: string; firstName: string; lastName: string;
  username: string | null; bio: string | null; birthday: Birthday | null; phone: string | null;
  links: ProfileLink[];   // ссылки на профили в других сервисах, в порядке владельца; видны всем
  /** фото профиля; null — нет или зритель заблокирован */
  photo?: ProfilePhoto | null;
  /** собственное имя пользователя; name/firstName/lastName у владельца контакта — контактные */
  publicName?: string;
  /** этот человек заблокировал зрителя: писать ему в личный чат нельзя (плашка вместо поля ввода) */
  blocksMe?: boolean;
  /** музыка профиля: сколько треков и последний добавленный (плашка под аватаром); список — GET /users/:id/music */
  music?: ProfileMusicSummary | null;
}

export interface ProfileMusicSummary { count: number; top: { id: string; title: string; duration: number | null } }

/** Контакт: имя, которое дал владелец (видно только ему), заметка, профиль и присутствие.
 *  seq — номер записи журнала владельца, на момент которой снят ответ (порядок ответов и журнала). */
export interface Contact {
  userId: Id; firstName: string; lastName: string; note: string;
  user: PublicUser;
  presence?: { online: boolean | null; lastSeen: string | null };
  seq?: number;
}

/** Собственный профиль (GET /me). userId и name — совместимость со старым клиентом.
 *  seq — номер записи своего журнала, на момент которой снят профиль: клиент не даёт старой записи userUpdated
 *  откатить более свежий ответ. */
export interface Me {
  userId: Id; name: string; firstName: string; lastName: string;
  username: string | null; bio: string | null; birthday: Birthday | null; phone: string | null;
  links: ProfileLink[];
  photo?: ProfilePhoto | null;
  music?: ProfileMusicSummary | null;
  seq?: number;
}

export interface JournalEntry { seq: number; update: Update }

export type ErrorCode = 'bad_frame' | 'unauthorized' | 'not_member' | 'not_found' | 'too_long' | 'forbidden' | 'internal'
  | 'username_invalid' | 'username_taken' | 'username_reserved' | 'bio_too_long' | 'name_invalid' | 'birthday_invalid' | 'links_invalid' | 'note_too_long'
  | 'blocked' | 'code_invalid' | 'code_expired' | 'flood' | 'fresh_session'
  | 'password_invalid' | 'password_missing' | 'recovery_unavailable' | 'email_invalid' | 'qr_expired' | 'passkey_not_found' | 'passkey_invalid'
  | 'folder_title' | 'folder_empty' | 'folder_too_many_chats' | 'folder_emoji' | 'folders_limit'
  | 'upload_missing' | 'upload_mismatch' | 'upload_pending' | 'upload_incomplete' | 'photo_invalid' | 'file_too_big';

export type ClientFrame =
  | { op: 'hello'; lastSeq: number }
  | { op: 'sync'; since: number }
  | { op: 'send'; reqId: string; clientId: string; chatId: Id; body: string; entities?: Entity[]; replyToId?: Id | null; attachment?: { id: string; thumb?: string | null; spoiler?: boolean } | null; groupId?: string | null; forward?: ForwardRef | null; noLinkPreview?: boolean; blocks?: Block[] | null; todo?: TodoInput }
  | { op: 'read'; reqId: string; chatId: Id; upToId: Id }
  | { op: 'typing'; chatId: Id }   // «печатаю» — без ответа, сервер пересылает остальным участникам
  | { op: 'draft'; reqId: string; chatId: Id; text: string; entities?: Entity[] }
  | { op: 'edit'; reqId: string; chatId: Id; id: Id; body: string; entities?: Entity[] }
  | { op: 'delete'; reqId: string; chatId: Id; id: Id }
  | { op: 'react'; reqId: string; chatId: Id; id: Id; emoji: string | null }
  | { op: 'todoToggle'; reqId: string; chatId: Id; id: Id; completed: number[]; incompleted: number[] }
  | { op: 'todoAppend'; reqId: string; chatId: Id; id: Id; items: string[] }
  | { op: 'todoEdit'; reqId: string; chatId: Id; id: Id; todo: TodoInput }
  | { op: 'listened'; reqId: string; chatId: Id; id: Id }
  | { op: 'ping' };

/** Присутствие собеседника: в сети сейчас или когда был последний раз (ISO).
 *  Скрыто правилом «Последний визит» — {online: null, lastSeen: 'recently'} («был(а) недавно»). */
export const RECENTLY = 'recently';
export interface PresenceItem { userId: number; online: boolean | null; lastSeen: string | null }

export type ServerFrame =
  | { op: 'hello'; seq: number; epoch: string }   // epoch — поколение базы; сменилось — кэш клиента недействителен
  | { op: 'updates'; from: number; to: number; items: JournalEntry[]; more: boolean }
  | { op: 'tooLong'; seq: number }
  | { op: 'ack'; reqId: string; result: Record<string, unknown> }
  | { op: 'err'; reqId?: string; code: ErrorCode; retry: boolean }
  | { op: 'poke' }
  | { op: 'presence'; items: PresenceItem[] }
  | { op: 'typing'; chatId: Id; userId: Id }
  // сеанс этого сокета завершён; следом сокет закрывается. reason: logout — выход в другой вкладке этого же браузера,
  // terminated — с другого устройства, автозавершением или сеанс пропал
  | { op: 'sessionTerminated'; reason?: 'logout' | 'terminated' }
  | { op: 'pong' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function parseClientFrame(raw: string): ClientFrame | null {
  let f: Record<string, unknown>;
  try { f = JSON.parse(raw); } catch { return null; }
  if (!f || typeof f !== 'object') return null;
  switch (f.op) {
    case 'hello': return int(f.lastSeq) ? { op: 'hello', lastSeq: f.lastSeq } : null;
    case 'sync': return int(f.since) ? { op: 'sync', since: f.since } : null;
    case 'ping': return { op: 'ping' };
    case 'typing': return int(f.chatId) ? { op: 'typing', chatId: f.chatId } : null;
    case 'edit': return str(f.reqId, 64) && int(f.chatId) && int(f.id) && typeof f.body === 'string' ? { op: 'edit', reqId: f.reqId, chatId: f.chatId, id: f.id, body: f.body, entities: normalizeEntities(f.body, f.entities) } : null;
    case 'delete': return str(f.reqId, 64) && int(f.chatId) && int(f.id) ? { op: 'delete', reqId: f.reqId, chatId: f.chatId, id: f.id } : null;
    case 'listened': return str(f.reqId, 64) && int(f.chatId) && int(f.id) ? { op: 'listened', reqId: f.reqId, chatId: f.chatId, id: f.id } : null;
    case 'todoToggle': {
      const ids = (v: unknown) => Array.isArray(v) && v.length <= TODO_ITEMS_MAX && v.every((x) => int(x)) ? v as number[] : null;
      const done = ids(f.completed), undone = ids(f.incompleted);
      return str(f.reqId, 64) && int(f.chatId) && int(f.id) && done && undone ? { op: 'todoToggle', reqId: f.reqId, chatId: f.chatId, id: f.id, completed: done, incompleted: undone } : null;
    }
    case 'todoAppend': return str(f.reqId, 64) && int(f.chatId) && int(f.id) && Array.isArray(f.items) && f.items.length >= 1 && f.items.length <= TODO_ITEMS_MAX && f.items.every((x) => typeof x === 'string')
      ? { op: 'todoAppend', reqId: f.reqId, chatId: f.chatId, id: f.id, items: f.items as string[] } : null;
    case 'todoEdit': { const t = normalizeTodo(f.todo); return str(f.reqId, 64) && int(f.chatId) && int(f.id) && t ? { op: 'todoEdit', reqId: f.reqId, chatId: f.chatId, id: f.id, todo: t } : null; }
    case 'react': return str(f.reqId, 64) && int(f.chatId) && int(f.id) && (f.emoji === null || str(f.emoji, 16)) ? { op: 'react', reqId: f.reqId, chatId: f.chatId, id: f.id, emoji: f.emoji as string | null } : null;
    case 'draft': return str(f.reqId, 64) && int(f.chatId) && typeof f.text === 'string' ? { op: 'draft', reqId: f.reqId, chatId: f.chatId, text: f.text, entities: normalizeEntities(f.text, f.entities) } : null;
    case 'send':
      if (!str(f.reqId, 64) || !str(f.clientId, 36) || !UUID.test(f.clientId) || !int(f.chatId) || typeof f.body !== 'string') return null;
      if (f.replyToId != null && !int(f.replyToId)) return null;
      if (f.attachment != null && (typeof f.attachment !== 'object' || !str((f.attachment as { id: unknown }).id, 36))) return null;
      if (f.groupId != null && !(typeof f.groupId === 'string' && UUID.test(f.groupId))) return null;
      let forward: ForwardRef | null = null;
      if (f.forward != null) {
        const w = f.forward as Record<string, unknown>;
        if (typeof w !== 'object' || !int(w.chatId) || !int(w.id)) return null;
        forward = { chatId: w.chatId as number, id: w.id as number, hideSender: w.hideSender === true, hideCaption: w.hideCaption === true };
      }
      if (f.todo != null && !normalizeTodo(f.todo)) return null;
      return { op: 'send', ...(f.todo != null ? { todo: normalizeTodo(f.todo)! } : {}), reqId: f.reqId, clientId: f.clientId, chatId: f.chatId, body: f.body, entities: normalizeEntities(f.body, f.entities), replyToId: (f.replyToId as number | null) ?? null, attachment: (f.attachment as { id: string; thumb?: string | null; spoiler?: boolean } | null) ?? null, groupId: (f.groupId as string | null) ?? null, forward, ...(f.noLinkPreview === true ? { noLinkPreview: true } : {}), ...(Array.isArray(f.blocks) ? { blocks: f.blocks as Block[] } : {}) };
    case 'read':
      return str(f.reqId, 64) && int(f.chatId) && int(f.upToId) ? { op: 'read', reqId: f.reqId, chatId: f.chatId, upToId: f.upToId } : null;
    default: return null;
  }
}

/** Знаки-заглушки вместо скрытого текста (Брайль: похоже на «шум», ширина близка к буквам). */
export const SPOILER_FILL = '⠺⠵⠞⠟⠽⠾⠷⠯';

/**
 * Текст, где спойлеры заменены заглушкой (пробелы и переводы строк сохраняются): для уведомлений,
 * push и превью — туда, где спойлер не раскрыть, настоящий текст не попадает.
 */
export function hideSpoilers(text: string, entities?: readonly { type: string; offset: number; length: number }[] | null): string {
  if (!entities?.length) return text;
  let out: string[] | null = null;
  for (const e of entities) {
    if (e.type !== 'spoiler') continue;
    out ??= text.split('');   // смещения — в единицах UTF-16, как и у сущностей
    for (let i = e.offset; i < Math.min(text.length, e.offset + e.length); i++) if (!/\s/.test(text[i])) out[i] = SPOILER_FILL[i % SPOILER_FILL.length];
  }
  return out ? out.join('') : text;
}

/* ---------- чек-листы (как в Telegram: todoList) ---------- */

/** Задача: id — номер внутри списка (1..N при создании, новые — максимум + 1). */
export interface TodoItem { id: number; title: string }
/** Отметка «выполнено»: какая задача, кто и когда. */
export interface TodoCompletion { id: number; by: Id; at: string }
export interface Todo { title: string; items: TodoItem[]; othersCanAppend: boolean; othersCanComplete: boolean; completions: TodoCompletion[] }
/** Что присылает клиент при создании и правке: задачи без номера получают их на сервере. */
export interface TodoInput { title: string; items: { id?: number; title: string }[]; othersCanAppend: boolean; othersCanComplete: boolean }
/** Данные служебной строки чек-листа: какие задачи отметили / сняли / добавили. */
export type TodoServiceData = ServiceData;

/** Пределы как у Telegram (todo_items_max / todo_title_length_max / todo_item_length_max по умолчанию). */
export const TODO_ITEMS_MAX = 30;
export const TODO_TITLE_MAX = 32;
export const TODO_ITEM_MAX = 64;
const glyphs = (s: string) => [...s].length;

/** Проверка чек-листа от клиента: заголовок и задачи непустые и в пределах; переводы строк — пробелы. null — не чек-лист. */
export function normalizeTodo(raw: unknown): TodoInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const line = (v: unknown) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  const title = line(r.title);
  if (!title || glyphs(title) > TODO_TITLE_MAX || !Array.isArray(r.items)) return null;
  const items: { id?: number; title: string }[] = [];
  const seen = new Set<number>();
  for (const it of r.items) {
    const t = line(it && typeof it === 'object' ? (it as Record<string, unknown>).title : it);
    if (!t) continue;
    if (glyphs(t) > TODO_ITEM_MAX) return null;
    const id = it && typeof it === 'object' ? (it as Record<string, unknown>).id : undefined;
    if (Number.isSafeInteger(id) && (id as number) > 0 && !seen.has(id as number)) { seen.add(id as number); items.push({ id: id as number, title: t }); }
    else items.push({ title: t });
  }
  if (!items.length || items.length > TODO_ITEMS_MAX) return null;
  return { title, items, othersCanAppend: r.othersCanAppend === true, othersCanComplete: r.othersCanComplete === true };
}

export * from './groups';
export * from './blocks';
