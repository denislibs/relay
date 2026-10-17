import { sql } from './db';
import { currentEpoch } from './domain/epoch';
import type { ClientFrame, ServerFrame } from '@relay/protocol';
import { DomainError } from './domain/errors';
import { currentSeq, getUpdates } from './domain/journal';
import { sendMessage } from './domain/messages';
import { markRead } from './domain/reads';
import { saveDraft } from './domain/drafts';
import { deleteMessage, editMessage, reactMessage } from './domain/messageOps';

/** publish — разослать кадр в топик пользователя (для «печатает…»); у тестов без сокетов — no-op. */
export async function handleFrame(userId: number, frame: ClientFrame, publish: (topic: string, msg: string) => void = () => {}): Promise<ServerFrame[]> {
  const reqId = 'reqId' in frame ? frame.reqId : undefined;
  try {
    switch (frame.op) {
      case 'typing': {
        // участникам, кроме себя; не участник — молча игнорируем (это не данные, ответа нет)
        const rows = await sql`select user_id from chat_members where chat_id = ${frame.chatId}`;
        const members = rows.map((r) => r.user_id as number);
        if (!members.includes(userId)) return [];
        const msg = JSON.stringify({ op: 'typing', chatId: frame.chatId, userId } satisfies ServerFrame);
        for (const m of members) if (m !== userId) publish(`user:${m}`, msg);
        return [];
      }
      case 'hello':
        return [{ op: 'hello', seq: await currentSeq(userId), epoch: await currentEpoch() }];
      case 'sync': {
        const page = await getUpdates(userId, frame.since);
        if (page.tooLong) return [{ op: 'tooLong', seq: page.seq }];
        const to = page.items.length ? page.items[page.items.length - 1].seq : frame.since;
        return [{ op: 'updates', from: frame.since, to, items: page.items, more: page.more }];
      }
      case 'send': {
        const { message, duplicate } = await sendMessage(userId, frame);
        return [{ op: 'ack', reqId: frame.reqId, result: { clientId: message.clientId, id: message.id, createdAt: message.createdAt, duplicate } }];
      }
      case 'read': {
        const res = await markRead(userId, frame.chatId, frame.upToId);
        return [{ op: 'ack', reqId: frame.reqId, result: res }];
      }
      case 'edit': return [{ op: 'ack', reqId: frame.reqId, result: await editMessage(userId, frame.chatId, frame.id, frame.body) }];
      case 'delete': return [{ op: 'ack', reqId: frame.reqId, result: await deleteMessage(userId, frame.chatId, frame.id) }];
      case 'react': return [{ op: 'ack', reqId: frame.reqId, result: await reactMessage(userId, frame.chatId, frame.id, frame.emoji) }];
      case 'draft': {
        const res = await saveDraft(userId, frame.chatId, frame.text);
        return [{ op: 'ack', reqId: frame.reqId, result: res }];
      }
      case 'ping':
        return [{ op: 'pong' }];
    }
  } catch (err) {
    // blocked — с номером своего журнала: разблокировку клиент узнает по более позднему userUpdated собеседника
    if (err instanceof DomainError) return [{ op: 'err', reqId, code: err.code, retry: false, ...(err.code === 'blocked' ? { seq: await currentSeq(userId) } : {}) }];
    console.error(err);
    return [{ op: 'err', reqId, code: 'internal', retry: true }];
  }
}
