import type { ClientFrame, ServerFrame } from '@relay/protocol';
import { DomainError } from './domain/errors';
import { currentSeq, getUpdates } from './domain/journal';
import { sendMessage } from './domain/messages';
import { markRead } from './domain/reads';

export async function handleFrame(userId: number, frame: ClientFrame): Promise<ServerFrame[]> {
  const reqId = 'reqId' in frame ? frame.reqId : undefined;
  try {
    switch (frame.op) {
      case 'hello':
        return [{ op: 'hello', seq: await currentSeq(userId) }];
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
      case 'ping':
        return [{ op: 'pong' }];
    }
  } catch (err) {
    if (err instanceof DomainError) return [{ op: 'err', reqId, code: err.code, retry: false }];
    console.error(err);
    return [{ op: 'err', reqId, code: 'internal', retry: true }];
  }
}
