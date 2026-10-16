export type Id = number;

export interface Message {
  id: Id;
  chatId: Id;
  senderId: Id;
  clientId: string;
  kind: 'text';
  body: string;
  replyToId: Id | null;
  createdAt: string; // ISO
}

export type Update =
  | { type: 'newMessage'; message: Message }
  | { type: 'readOwn'; chatId: Id; upToId: Id }
  | { type: 'readBy'; chatId: Id; userId: Id; upToId: Id };

export interface JournalEntry { seq: number; update: Update }

export type ErrorCode = 'bad_frame' | 'unauthorized' | 'not_member' | 'not_found' | 'too_long' | 'internal';

export type ClientFrame =
  | { op: 'hello'; lastSeq: number }
  | { op: 'sync'; since: number }
  | { op: 'send'; reqId: string; clientId: string; chatId: Id; body: string; replyToId?: Id | null }
  | { op: 'read'; reqId: string; chatId: Id; upToId: Id }
  | { op: 'ping' };

export type ServerFrame =
  | { op: 'hello'; seq: number }
  | { op: 'updates'; from: number; to: number; items: JournalEntry[]; more: boolean }
  | { op: 'tooLong'; seq: number }
  | { op: 'ack'; reqId: string; result: Record<string, unknown> }
  | { op: 'err'; reqId?: string; code: ErrorCode; retry: boolean }
  | { op: 'poke' }
  | { op: 'pong' };
