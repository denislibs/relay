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
}

/** Вложение: фото (знает размеры заранее — лента не прыгает) или файл. thumb — крошечное размытое превью. */
export interface Attachment { id: string; kind: 'photo' | 'file'; mime: string; name: string; size: number; w: number | null; h: number | null; thumb?: string | null }

/** Реакция: кто и какой эмодзи (одна от пользователя на сообщение). */
export interface Reaction { userId: Id; emoji: string }

export type Update =
  | { type: 'newMessage'; message: Message }
  | { type: 'readOwn'; chatId: Id; upToId: Id }
  | { type: 'readBy'; chatId: Id; userId: Id; upToId: Id }
  | { type: 'draft'; chatId: Id; text: string; at: string }   // черновик своих устройств; пустой текст — удалён
  | { type: 'messageEdited'; chatId: Id; id: Id; body: string; editedAt: string }
  | { type: 'messageDeleted'; chatId: Id; id: Id }
  | { type: 'reactions'; chatId: Id; id: Id; reactions: Reaction[] }
  | { type: 'userUpdated'; user: PublicUser };   // профиль изменился: себе и всем, кто видит пользователя

/** День рождения: год необязателен. */
export interface Birthday { day: number; month: number; year?: number }

/** Профиль глазами зрителя (скрытые правилами приватности поля сервер не отдаёт). */
export interface PublicUser {
  id: Id; name: string; firstName: string; lastName: string;
  username: string | null; bio: string | null; birthday: Birthday | null; phone: string | null;
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
  | 'username_invalid' | 'username_taken' | 'username_reserved' | 'bio_too_long' | 'name_invalid' | 'birthday_invalid';

export type ClientFrame =
  | { op: 'hello'; lastSeq: number }
  | { op: 'sync'; since: number }
  | { op: 'send'; reqId: string; clientId: string; chatId: Id; body: string; replyToId?: Id | null; attachment?: { id: string; thumb?: string | null } | null }
  | { op: 'read'; reqId: string; chatId: Id; upToId: Id }
  | { op: 'typing'; chatId: Id }   // «печатаю» — без ответа, сервер пересылает остальным участникам
  | { op: 'draft'; reqId: string; chatId: Id; text: string }
  | { op: 'edit'; reqId: string; chatId: Id; id: Id; body: string }
  | { op: 'delete'; reqId: string; chatId: Id; id: Id }
  | { op: 'react'; reqId: string; chatId: Id; id: Id; emoji: string | null }
  | { op: 'ping' };

/** Присутствие собеседника: в сети сейчас или когда был последний раз (ISO). */
export interface PresenceItem { userId: number; online: boolean; lastSeen: string | null }

export type ServerFrame =
  | { op: 'hello'; seq: number; epoch: string }   // epoch — поколение базы; сменилось — кэш клиента недействителен
  | { op: 'updates'; from: number; to: number; items: JournalEntry[]; more: boolean }
  | { op: 'tooLong'; seq: number }
  | { op: 'ack'; reqId: string; result: Record<string, unknown> }
  | { op: 'err'; reqId?: string; code: ErrorCode; retry: boolean }
  | { op: 'poke' }
  | { op: 'presence'; items: PresenceItem[] }
  | { op: 'typing'; chatId: Id; userId: Id }
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
    case 'edit': return str(f.reqId, 64) && int(f.chatId) && int(f.id) && typeof f.body === 'string' ? { op: 'edit', reqId: f.reqId, chatId: f.chatId, id: f.id, body: f.body } : null;
    case 'delete': return str(f.reqId, 64) && int(f.chatId) && int(f.id) ? { op: 'delete', reqId: f.reqId, chatId: f.chatId, id: f.id } : null;
    case 'react': return str(f.reqId, 64) && int(f.chatId) && int(f.id) && (f.emoji === null || str(f.emoji, 16)) ? { op: 'react', reqId: f.reqId, chatId: f.chatId, id: f.id, emoji: f.emoji as string | null } : null;
    case 'draft': return str(f.reqId, 64) && int(f.chatId) && typeof f.text === 'string' ? { op: 'draft', reqId: f.reqId, chatId: f.chatId, text: f.text } : null;
    case 'send':
      if (!str(f.reqId, 64) || !str(f.clientId, 36) || !UUID.test(f.clientId) || !int(f.chatId) || typeof f.body !== 'string') return null;
      if (f.replyToId != null && !int(f.replyToId)) return null;
      if (f.attachment != null && (typeof f.attachment !== 'object' || !str((f.attachment as { id: unknown }).id, 36))) return null;
      return { op: 'send', reqId: f.reqId, clientId: f.clientId, chatId: f.chatId, body: f.body, replyToId: (f.replyToId as number | null) ?? null, attachment: (f.attachment as { id: string; thumb?: string | null } | null) ?? null };
    case 'read':
      return str(f.reqId, 64) && int(f.chatId) && int(f.upToId) ? { op: 'read', reqId: f.reqId, chatId: f.chatId, upToId: f.upToId } : null;
    default: return null;
  }
}
