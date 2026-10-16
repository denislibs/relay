export type Status = 'pending' | 'sent' | 'read' | 'failed';

export interface LocalMessage {
  key: string;            // = clientId: одинаков у черновика, ack и newMessage
  clientId: string;
  id: number | null;      // null, пока сервер не подтвердил
  chatId: number;
  senderId: number;
  body: string;
  replyToId: number | null;
  createdAt: string;
  status: Status;
  sort: number;           // id, а у неподтверждённых — PENDING_BASE + время создания
  editedAt?: string | null;
  deleted?: boolean;
  reactions?: { userId: number; emoji: string }[];
  kind?: 'text' | 'photo' | 'file';
  attachment?: LocalAttachment | null;
  progress?: number;      // загрузка файла 0..1, пока сообщение в очереди
}

/** Вложение сообщения; у неотправленного id пустой, пока файл не загружен. */
export interface LocalAttachment { id: string; kind: 'photo' | 'file'; mime: string; name: string; size: number; w: number | null; h: number | null; thumb?: string | null }

export interface LocalChat {
  id: number;
  kind: 'direct' | 'group';
  title: string | null;
  lastReadId: number;
  unread: number;
  knownMaxId: number;     // максимальный id сообщения, который уже учтён в unread
  peerReadUpTo: number;   // до какого id собеседники прочитали мои сообщения
  historyComplete: boolean;
  peerId: number | null;  // собеседник личного чата
  named: boolean;         // название пришло со снимка (иначе чат узнали из сообщения)
  last: LocalMessage | null;
  lastAt: string;
  draft?: { text: string; at: string } | null;   // неотправленный текст композера (общий для вкладок)
}

export interface OutboxEntry {
  clientId: string;
  chatId: number;
  body: string;
  replyToId: number | null;
  createdAt: number;
  failed: boolean;
  attachment?: LocalAttachment | null;   // id появляется после загрузки файла
}

export type Query =
  | { kind: 'chatList'; limit: number }
  /** Окно ленты: без якоря — последние limit (живой хвост); с якорем — limit сообщений, которые
   *  заканчиваются на sort (end), начинаются с него (start) или стоят вокруг него (center). */
  | { kind: 'messages'; chatId: number; limit: number; anchor?: { sort: number; side: 'end' | 'start' | 'center' } }
  | { kind: 'counters' }
  | { kind: 'status' }
  | { kind: 'presence'; userId: number };

export type Item = { key: string } & Record<string, unknown>;

export type Patch =
  | { op: 'snapshot'; items: Item[]; order: string[] }
  | { op: 'diff'; upsert: Item[]; remove: string[]; order?: string[] };

export type Action =
  | { type: 'sendMessage'; chatId: number; body: string; replyToId?: number | null }
  | { type: 'seen'; chatId: number; upToId: number }
  | { type: 'loadOlder'; chatId: number }
  | { type: 'retry'; clientId: string }
  | { type: 'refreshChats' }
  | { type: 'loadMoreChats' }
  | { type: 'setDraft'; chatId: number; text: string }
  | { type: 'typing'; chatId: number }
  | { type: 'editMessage'; chatId: number; id: number; body: string }
  | { type: 'deleteMessage'; chatId: number; id: number }
  | { type: 'react'; chatId: number; id: number; emoji: string | null }
  | { type: 'search'; q: string; chatId?: number; beforeId?: number; limit?: number }
  | { type: 'chatMedia'; chatId: number; kind: 'photo' | 'file' }
  | { type: 'sendFile'; chatId: number; body: string; file: Blob; name: string; mime: string; w?: number | null; h?: number | null; thumb?: string | null; replyToId?: number | null };

export interface EngineConfig {
  userId: number;
  dbName: string;
  httpBase: string;
  wsUrl: string;
  /** Только сериализуемое: конфиг уходит в воркер через postMessage. В браузере не нужен — cookie сессии уходит сам. */
  headers?: Record<string, string>;
  frameMs?: number;
  readFlushMs?: number;
  backoffMs?: [number, number];
  historyPage?: number;
  dialogsPage?: number;
  typingMs?: number;      // сколько держать «печатает…» после последнего кадра (по умолчанию 6000)   // диалогов в странице (по умолчанию 100)
}

export const PENDING_BASE = 2 ** 52;

/** Результат поиска: сообщение и где оно (для перехода). source — откуда ответ (без сети ищем локально). */
export interface SearchHit { chatId: number; chatTitle: string | null; id: number; sort: number; senderId: number; body: string; createdAt: string }
export interface SearchResult { hits: SearchHit[]; hasMore: boolean; source: 'server' | 'local' }
