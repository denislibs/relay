import { closePoll, votePoll } from './domain/polls';
import { sql } from './db';
import { resolvePeer } from './domain/peerRef';
import { currentEpoch } from './domain/epoch';
import type { ClientFrame, ServerFrame } from '@relay/protocol';
import { DomainError } from './domain/errors';
import { currentSeq, getUpdates } from './domain/journal';
import { chatSeqOf, chatSeqsSince, getChatUpdates } from './domain/chatJournal';
import { syncSubscriptions, unwatchChat, unwatchThread, watchChat, watchThread, type ChatSocket } from './sockets';
import { canRead } from './domain/chats';
import { threadAccess } from './domain/threads';
import { sendMessage } from './domain/messages';
import { scheduleMessage } from './domain/scheduled';
import { markRead } from './domain/reads';
import { saveDraft } from './domain/drafts';
import { deleteMessage, editMessage, markListened, reactMessage } from './domain/messageOps';
import { appendTodo, editTodo, toggleTodo } from './domain/todo';
import { pressButton } from './domain/buttons';
import { ctxFromRow, hasAdmin } from './domain/groupRights';
import { allowGroupMember, callLink, currentGroupCall, decideCallRequest, inviteToCall, joinByCallLink, previewCallLink, startConference, endGroupCallBy, joinGroupCall, kickGroupMember, leaveGroupCall, muteGroupMember, setGroupCallSettings, pingGroupCall, relayGroupKeys, startGroupCall, updateGroupMember } from './domain/groupCalls';
import { acceptCall, confirmCall, currentCall, declineCall, hangupCall, pingCall, receivedCall, relaySignal, requestCall } from './domain/calls';

/** Ждать open сокета (подписки на журналы чатов), но не дольше ms: Valkey недоступен — отвечаем, сверка догонит. */
const opened = (sock: ChatSocket | undefined, ms = 5000) => sock?.data.opened ? Promise.race([sock.data.opened, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve();

/** publish — разослать кадр в топик (шина Valkey: «печатает…»); у тестов без сокетов — no-op.
 *  sessionId — сеанс сокета (кнопки «Нового входа» отличают этот сеанс от остальных); sock — сам сокет (подписки на журналы чатов). */
const emojiFxAt = new Map<string, number>();   // последний emojiFx по «пользователь:чат:сообщение»

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
      case 'emojiFx': {
        // клики по большому эмодзи — только личный чат; пачки на одно сообщение клиент шлёт не чаще раза в секунду —
        // лимит на (пользователь, чат, сообщение) с запасом на дрожание сети; в журнал не пишем
        const rk = userId + ':' + frame.chatId + ':' + frame.id, now = Date.now();
        if (now - (emojiFxAt.get(rk) ?? 0) < 800) return [];
        emojiFxAt.set(rk, now);
        if (emojiFxAt.size > 10_000) emojiFxAt.clear();
        const [c] = await sql`select c.kind from chats c join chat_members m on m.chat_id = c.id and m.user_id = ${userId}
                               where c.id = ${frame.chatId} and c.kind = 'direct' and c.deleted_at is null`;
        if (!c) return [];
        const msg = JSON.stringify({ op: 'emojiFx', chatId: frame.chatId, id: frame.id, key: frame.key, t: frame.t, userId } satisfies ServerFrame);
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
        // карточка контакта: человек — по ссылке (ключ или сообщение), иначе id ничего не открывает и не раскрывает имя
        if (frame.contact) frame.contact = { userId: await resolvePeer(sql, userId, { id: frame.contact.userId, key: frame.contact.key, via: frame.contact.via }, 'contact') };
        // отложить: сообщения ещё нет, только строка отложенных (domain/scheduled.ts)
        if (frame.scheduleAt != null) return [{ op: 'ack', reqId: frame.reqId, result: { clientId: frame.clientId, ...await scheduleMessage(userId, frame) } }];
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
      case 'pollVote': return [{ op: 'ack', reqId: frame.reqId, result: await votePoll(userId, frame.chatId, frame.id, frame.options) }];
      case 'pollClose': return [{ op: 'ack', reqId: frame.reqId, result: await closePoll(userId, frame.chatId, frame.id) }];
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
      case 'watchThread': {
        // гость треда (не участник группы, threads.ts threadAccess) — топик треда; участнику хватает топика чата
        const { guest } = await threadAccess(sql, frame.chatId, userId, frame.threadId);
        // сокет мог закрыться, пока проверяли (releaseThreads уже прошёл) — не подписывать: счётчик тредов процесса не утечёт
        if (guest && sock && sock.readyState === 1 && !watchThread(sock, frame.chatId, frame.threadId, guest.channelId)) throw new DomainError('flood', 'watch');
        return [{ op: 'ack', reqId: frame.reqId, result: { guest: !!guest } }];
      }
      case 'unwatchThread':
        if (sock) unwatchThread(sock, frame.chatId, frame.threadId);
        return [{ op: 'ack', reqId: frame.reqId, result: { ok: true } }];
      // звонки 1:1 (domain/calls.ts): сессия нужна — сигналинг идёт между сессиями, которые ведут звонок
      case 'callRequest': case 'callAccept': case 'callGet':
      case 'callReceived': case 'callConfirm': case 'callDecline': case 'callHangup': case 'callSignal': case 'callPing': {
        if (sessionId == null) throw new DomainError('unauthorized');
        switch (frame.op) {
          case 'callRequest': return [{ op: 'ack', reqId: frame.reqId, result: await requestCall(publish, userId, sessionId, frame) }];
          case 'callAccept': return [{ op: 'ack', reqId: frame.reqId, result: await acceptCall(publish, userId, sessionId, frame) }];
          case 'callGet': return [{ op: 'ack', reqId: frame.reqId, result: { call: await currentCall(userId) } }];
          case 'callReceived': await receivedCall(publish, userId, frame.callId); return [];
          case 'callConfirm': await confirmCall(publish, userId, sessionId, frame); return [];
          case 'callDecline': await declineCall(publish, userId, sessionId, frame.callId); return [];
          case 'callHangup': await hangupCall(publish, userId, sessionId, frame); return [];
          case 'callSignal': await relaySignal(publish, userId, sessionId, frame); return [];
          case 'callPing': await pingCall(userId, sessionId, frame.callId); return [];
        }
        return [];
      }
      // групповые звонки (domain/groupCalls.ts)
      case 'groupCallStart': case 'groupCallJoin': case 'groupCallLeave': case 'groupCallKeys': case 'groupCallUpdate':
      case 'groupCallPing': case 'groupCallGet': case 'groupCallEnd': case 'groupCallMute': case 'groupCallKick': case 'groupCallSettings': case 'groupCallAllow':
      case 'groupCallConference': case 'groupCallInvite': case 'groupCallLink': case 'groupCallLinkPreview': case 'groupCallLinkJoin': case 'groupCallDecide': {
        if (sessionId == null) throw new DomainError('unauthorized');
        switch (frame.op) {
          case 'groupCallStart': return [{ op: 'ack', reqId: frame.reqId, result: await startGroupCall(userId, frame.chatId) }];
          case 'groupCallJoin': return [{ op: 'ack', reqId: frame.reqId, result: await joinGroupCall(publish, userId, sessionId, frame) }];
          case 'groupCallGet': return [{ op: 'ack', reqId: frame.reqId, result: { call: await currentGroupCall(userId, frame.chatId) } }];
          case 'groupCallEnd': return [{ op: 'ack', reqId: frame.reqId, result: await endGroupCallBy(publish, userId, frame.callId) }];
          case 'groupCallMute': return [{ op: 'ack', reqId: frame.reqId, result: await muteGroupMember(publish, userId, frame) }];
          case 'groupCallKick': return [{ op: 'ack', reqId: frame.reqId, result: await kickGroupMember(publish, userId, frame) }];
          case 'groupCallAllow': await allowGroupMember(publish, userId, frame); return [{ op: 'ack', reqId: frame.reqId, result: { ok: true } }];
          case 'groupCallConference': return [{ op: 'ack', reqId: frame.reqId, result: await startConference(publish, userId, frame) }];
          case 'groupCallInvite': return [{ op: 'ack', reqId: frame.reqId, result: await inviteToCall(publish, userId, frame) }];
          case 'groupCallLink': return [{ op: 'ack', reqId: frame.reqId, result: await callLink(userId, frame) }];
          case 'groupCallLinkPreview': return [{ op: 'ack', reqId: frame.reqId, result: await previewCallLink(userId, frame.token) }];
          case 'groupCallLinkJoin': return [{ op: 'ack', reqId: frame.reqId, result: await joinByCallLink(publish, userId, frame.token) }];
          case 'groupCallDecide': return [{ op: 'ack', reqId: frame.reqId, result: await decideCallRequest(publish, userId, frame) }];
          case 'groupCallSettings': return [{ op: 'ack', reqId: frame.reqId, result: await setGroupCallSettings(publish, userId, frame) }];
          case 'groupCallLeave': await leaveGroupCall(publish, frame.callId, sessionId); return [];
          case 'groupCallKeys': await relayGroupKeys(publish, userId, sessionId, frame); return [];
          case 'groupCallUpdate': await updateGroupMember(publish, userId, sessionId, frame); return [];
          case 'groupCallPing': await pingGroupCall(userId, sessionId, frame.callId); return [];
        }
        return [];
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
