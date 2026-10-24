import { sql } from './db';
import { currentEpoch } from './domain/epoch';
import type { ClientFrame, ServerFrame } from '@relay/protocol';
import { DomainError } from './domain/errors';
import { currentSeq, getUpdates } from './domain/journal';
import { chatSeqOf, chatSeqsSince, getChatUpdates } from './domain/chatJournal';
import { syncSubscriptions, unwatchChat, watchChat, type ChatSocket } from './sockets';
import { canRead } from './domain/chats';
import { sendMessage } from './domain/messages';
import { markRead } from './domain/reads';
import { saveDraft } from './domain/drafts';
import { deleteMessage, editMessage, markListened, reactMessage } from './domain/messageOps';
import { appendTodo, editTodo, toggleTodo } from './domain/todo';
import { pressButton } from './domain/buttons';
import { ctxFromRow, hasAdmin } from './domain/groupRights';

/** Ждать open сокета (подписки на журналы чатов), но не дольше ms: Valkey недоступен — отвечаем, сверка догонит. */
const opened = (sock: ChatSocket | undefined, ms = 5000) => sock?.data.opened ? Promise.race([sock.data.opened, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve();

/** publish — разослать кадр в топик (шина Valkey: «печатает…»); у тестов без сокетов — no-op.
 *  sessionId — сеанс сокета (кнопки «Нового входа» отличают этот сеанс от остальных); sock — сам сокет (подписки на журналы чатов). */
export async function handleFrame(userId: number, frame: ClientFrame, publish: (topic: string, msg: string) => void = () => {}, sessionId?: number, sock?: ChatSocket): Promise<ServerFrame[]> {
  const reqId = 'reqId' in frame ? frame.reqId : undefined;
  try {
    switch (frame.op) {
      case 'typing': {
        // не участник — молча игнорируем (это не данные, ответа нет)
        const [c] = await sql`select c.kind, m.role, m.admin_rights from chats c join chat_members m on m.chat_id = c.id and m.user_id = ${userId}
                               where c.id = ${frame.chatId} and c.deleted_at is null`;
        if (!c) return [];
        // канал: «печатает» шлёт только тот, кто публикует (админ с post); подписчика игнорируем
        if (c.kind === 'channel' && !hasAdmin(ctxFromRow(frame.chatId, userId, c), 'post')) return [];
        // в канале — от имени канала (userId 0): какой админ пишет, подписчики не узнают (как и автора поста)
        const msg = JSON.stringify({ op: 'typing', chatId: frame.chatId, userId: c.kind === 'channel' ? 0 : userId } satisfies ServerFrame);
        if (c.kind !== 'direct') {
          // группа: один publish в топик чата (все процессы раздают своим подписчикам); свой userId и заблокированных отсеивает клиент
          publish(`chat:${frame.chatId}`, msg);
          return [];
        }
        // личный: собеседнику, кроме того, кто заблокировал отправителя
        const rows = await sql`
          select m.user_id, exists (select 1 from blocks b where b.owner_id = m.user_id and b.user_id = ${userId}) as blocked
            from chat_members m where m.chat_id = ${frame.chatId} and m.user_id <> ${userId}`;
        for (const r of rows) if (!r.blocked) publish(`user:${r.user_id}`, msg);
        return [];
      }
      case 'hello': {
        // отвечаем после подписок сокета: событие между ответом и подпиской иначе потерялось бы до сверки
        await opened(sock);
        if (sock) await syncSubscriptions(sock).catch((e) => console.error('chat subscriptions:', e));
        const [seq, epoch, chats] = await Promise.all([currentSeq(userId), currentEpoch(), chatSeqsSince(userId, frame.since ?? 0)]);
        return [{ op: 'hello', seq, epoch, now: chats.now, chats: chats.items }];
      }
      case 'chatsSince': {
        if (sock) await syncSubscriptions(sock).catch((e) => console.error('chat subscriptions:', e));
        const chats = await chatSeqsSince(userId, frame.since);
        return [{ op: 'chats', now: chats.now, items: chats.items }];
      }
      case 'syncChat': {
        let page;
        try { page = await getChatUpdates(userId, frame.chatId, frame.since); }
        catch (e) {
          if (e instanceof DomainError && (e.code === 'not_member' || e.code === 'not_found')) return [{ op: 'chatGone', reqId: frame.reqId, chatId: frame.chatId }];
          throw e;
        }
        if (page.tooLong) return [{ op: 'chatTooLong', reqId: frame.reqId, chatId: frame.chatId, seq: page.seq }];
        const to = page.items.length ? page.items[page.items.length - 1].seq : frame.since;
        return [{ op: 'chatUpdates', reqId: frame.reqId, chatId: frame.chatId, from: frame.since, to, items: page.items, more: page.more }];
      }
      case 'watchChat': {
        // превью публичного канала: читать можно (canRead) — сокет получает push'и канала; seq — догнать, что прошло мимо
        await canRead(sql, frame.chatId, userId);
        await opened(sock);
        if (sock && !(await watchChat(sock, frame.chatId))) throw new DomainError('flood', 'watch');
        return [{ op: 'ack', reqId: frame.reqId, result: { seq: await chatSeqOf(frame.chatId) } }];
      }
      case 'unwatchChat': {
        if (sock) await unwatchChat(sock, frame.chatId);
        return [];
      }
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
      case 'edit': return [{ op: 'ack', reqId: frame.reqId, result: await editMessage(userId, frame.chatId, frame.id, frame.body, frame.entities) }];
      case 'delete': return [{ op: 'ack', reqId: frame.reqId, result: await deleteMessage(userId, frame.chatId, frame.id) }];
      case 'listened': return [{ op: 'ack', reqId: frame.reqId, result: await markListened(userId, frame.chatId, frame.id) }];
      case 'react': return [{ op: 'ack', reqId: frame.reqId, result: await reactMessage(userId, frame.chatId, frame.id, frame.emoji) }];
      case 'todoToggle': return [{ op: 'ack', reqId: frame.reqId, result: await toggleTodo(userId, frame.chatId, frame.id, frame.completed, frame.incompleted) }];
      case 'todoAppend': return [{ op: 'ack', reqId: frame.reqId, result: await appendTodo(userId, frame.chatId, frame.id, frame.items) }];
      case 'button': {
        if (sessionId == null) throw new DomainError('unauthorized');
        return [{ op: 'ack', reqId: frame.reqId, result: { ...await pressButton(userId, sessionId, frame.chatId, frame.id, frame.data) } }];
      }
      case 'todoEdit': return [{ op: 'ack', reqId: frame.reqId, result: await editTodo(userId, frame.chatId, frame.id, frame.todo) }];
      case 'draft': {
        const res = await saveDraft(userId, frame.chatId, frame.text, frame.entities);
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
