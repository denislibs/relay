export type Id = number;

export interface Message {
  id: Id;
  chatId: Id;
  senderId: Id;
  clientId: string;
  kind: 'text' | 'photo' | 'file';
  body: string;
  replyToId: Id | null;
  createdAt: string; // ISO
  editedAt?: string | null;
  deleted?: boolean;
  reactions?: Reaction[];
  attachment?: Attachment | null;
  entities?: Entity[];   // оформление текста; нет или пусто — простой текст
}

/** Оформление куска текста: смещения в единицах UTF-16 (как String.length). Один тип сам с собой не перекрывается. */
export type EntityType = 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler' | 'code' | 'pre' | 'link';
export interface Entity { type: EntityType; offset: number; length: number; url?: string }
export const ENTITY_TYPES: readonly EntityType[] = ['bold', 'italic', 'underline', 'strike', 'spoiler', 'code', 'pre', 'link'];
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
    const key = type === 'link' ? 'link ' + url : (type as string);
    const list = by.get(key) ?? [];
    list.push(url ? { type: 'link', offset: s, length: end - s, url } : { type: type as EntityType, offset: s, length: end - s });
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
export interface Attachment { id: string; kind: 'photo' | 'file'; mime: string; name: string; size: number; w: number | null; h: number | null; thumb?: string | null }

/** Реакция: кто и какой эмодзи (одна от пользователя на сообщение). */
export interface Reaction { userId: Id; emoji: string }

export type Update =
  | { type: 'newMessage'; message: Message }
  | { type: 'readOwn'; chatId: Id; upToId: Id }
  | { type: 'readBy'; chatId: Id; userId: Id; upToId: Id }
  | { type: 'draft'; chatId: Id; text: string; at: string; entities?: Entity[] }   // черновик своих устройств; пустой текст — удалён
  | { type: 'messageEdited'; chatId: Id; id: Id; body: string; editedAt: string; entities?: Entity[] }
  | { type: 'messageDeleted'; chatId: Id; id: Id }
  | { type: 'reactions'; chatId: Id; id: Id; reactions: Reaction[] }
  | { type: 'userUpdated'; user: PublicUser }   // профиль изменился: себе и всем, кто видит пользователя
  // контакт добавлен/изменён (contact) или удалён (removed + user — как его видно без контакта); только владельцу
  | { type: 'contactsChanged'; contact?: Contact; removed?: Id; user?: PublicUser | null }
  // настройки аккаунта (общие для устройств) изменились: приходят целиком, только владельцу
  | { type: 'settingsChanged'; settings: UserSettings }
  // правила конфиденциальности изменились: приходят целиком, только владельцу
  | { type: 'privacyChanged'; rules: PrivacyRules }
  // чёрный список: человек заблокирован (blocked) или разблокирован (unblocked); только владельцу
  | { type: 'blocksChanged'; blocked?: BlockedUser; unblocked?: Id };

/** Тело уведомления/push без предпросмотра: текст сообщения не раскрываем. */
export const NO_PREVIEW = 'Новое сообщение';

/** Вид чата для умолчаний уведомлений. */
export type NotifyType = 'direct' | 'group';
export interface NotifyPref { muted: boolean; preview: boolean }
/** Настройки аккаунта (GET /settings добавляет seq своей записи журнала на момент снимка). */
export interface UserSettings { notify: Record<NotifyType, NotifyPref>; sessionsTtlDays: number }
export interface SettingsSnapshot extends UserSettings { privacy?: PrivacyRules; seq?: number }
/** Сроки автозавершения неактивных сеансов, дней (PUT /settings/sessions-ttl). */
export const SESSION_TTLS: readonly number[] = [7, 30, 90, 180, 365];

/** Сеанс (GET /sessions): устройство — грубо по User-Agent («Chrome 141, macOS»), IP входа; current — этот запрос. */
export interface SessionInfo { id: Id; device: string; ip: string | null; createdAt: string; lastActiveAt: string; current: boolean; online: boolean }

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
export interface PublicUser {
  id: Id; name: string; firstName: string; lastName: string;
  username: string | null; bio: string | null; birthday: Birthday | null; phone: string | null;
  /** собственное имя пользователя; name/firstName/lastName у владельца контакта — контактные */
  publicName?: string;
  /** этот человек заблокировал зрителя: писать ему в личный чат нельзя (плашка вместо поля ввода) */
  blocksMe?: boolean;
}

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
  seq?: number;
}

export interface JournalEntry { seq: number; update: Update }

export type ErrorCode = 'bad_frame' | 'unauthorized' | 'not_member' | 'not_found' | 'too_long' | 'forbidden' | 'internal'
  | 'username_invalid' | 'username_taken' | 'username_reserved' | 'bio_too_long' | 'name_invalid' | 'birthday_invalid' | 'note_too_long'
  | 'blocked';

export type ClientFrame =
  | { op: 'hello'; lastSeq: number }
  | { op: 'sync'; since: number }
  | { op: 'send'; reqId: string; clientId: string; chatId: Id; body: string; entities?: Entity[]; replyToId?: Id | null; attachment?: { id: string; thumb?: string | null } | null }
  | { op: 'read'; reqId: string; chatId: Id; upToId: Id }
  | { op: 'typing'; chatId: Id }   // «печатаю» — без ответа, сервер пересылает остальным участникам
  | { op: 'draft'; reqId: string; chatId: Id; text: string; entities?: Entity[] }
  | { op: 'edit'; reqId: string; chatId: Id; id: Id; body: string; entities?: Entity[] }
  | { op: 'delete'; reqId: string; chatId: Id; id: Id }
  | { op: 'react'; reqId: string; chatId: Id; id: Id; emoji: string | null }
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
    case 'react': return str(f.reqId, 64) && int(f.chatId) && int(f.id) && (f.emoji === null || str(f.emoji, 16)) ? { op: 'react', reqId: f.reqId, chatId: f.chatId, id: f.id, emoji: f.emoji as string | null } : null;
    case 'draft': return str(f.reqId, 64) && int(f.chatId) && typeof f.text === 'string' ? { op: 'draft', reqId: f.reqId, chatId: f.chatId, text: f.text, entities: normalizeEntities(f.text, f.entities) } : null;
    case 'send':
      if (!str(f.reqId, 64) || !str(f.clientId, 36) || !UUID.test(f.clientId) || !int(f.chatId) || typeof f.body !== 'string') return null;
      if (f.replyToId != null && !int(f.replyToId)) return null;
      if (f.attachment != null && (typeof f.attachment !== 'object' || !str((f.attachment as { id: unknown }).id, 36))) return null;
      return { op: 'send', reqId: f.reqId, clientId: f.clientId, chatId: f.chatId, body: f.body, entities: normalizeEntities(f.body, f.entities), replyToId: (f.replyToId as number | null) ?? null, attachment: (f.attachment as { id: string; thumb?: string | null } | null) ?? null };
    case 'read':
      return str(f.reqId, 64) && int(f.chatId) && int(f.upToId) ? { op: 'read', reqId: f.reqId, chatId: f.chatId, upToId: f.upToId } : null;
    default: return null;
  }
}
