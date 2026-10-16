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
}

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
}

export interface OutboxEntry {
  clientId: string;
  chatId: number;
  body: string;
  replyToId: number | null;
  createdAt: number;
  failed: boolean;
}

export type Query =
  | { kind: 'chatList'; limit: number }
  | { kind: 'messages'; chatId: number; limit: number }
  | { kind: 'counters' }
  | { kind: 'status' };

export type Item = { key: string } & Record<string, unknown>;

export type Patch =
  | { op: 'snapshot'; items: Item[]; order: string[] }
  | { op: 'diff'; upsert: Item[]; remove: string[]; order?: string[] };

export type Action =
  | { type: 'sendMessage'; chatId: number; body: string; replyToId?: number | null }
  | { type: 'seen'; chatId: number; upToId: number }
  | { type: 'loadOlder'; chatId: number }
  | { type: 'retry'; clientId: string };

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
}

export const PENDING_BASE = 2 ** 52;
