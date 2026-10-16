import type { Message } from '@relay/protocol';

export function msg(p: Partial<Message> & { id: number; chatId: number; senderId: number }): Message {
  return { clientId: crypto.randomUUID(), kind: 'text', body: 'text ' + p.id, replyToId: null, createdAt: new Date(1_700_000_000_000 + p.id * 1000).toISOString(), ...p };
}
