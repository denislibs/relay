// Групповые звонки (docs/plans/2026-11-07-relay-group-calls.md). Медиа — через LiveKit (SFU), кадры шифруются на
// устройствах ключами отправителей; сервер Relay пускает в комнату (пропуск), ведёт состав и эпоху ключей и
// пересылает зашифрованные ключи адресно — сам их не читает.

type Id = number;

/** Пинг участника звонка; без пинга дольше ~3 интервалов участник считается ушедшим. */
export const GROUP_CALL_PING_MS = 20_000;
/** Сколько человек показываем в плашке «Идёт звонок» (аватары). */
export const GROUP_CALL_FACES = 3;
/** Предел пакета ключей: один адресат — ≤ 512 знаков шифротекста; адресатов — не больше участников комнаты. */
export const GROUP_CALL_KEY_MAX = 512;
export const GROUP_CALL_MEMBERS_MAX = 200;

/** Идёт звонок в группе — для плашки у всех участников группы (журнал группы, снимок списка чатов). */
export interface GroupCallSummary { callId: string; count: number; startedAt: number; faces: Id[]; title?: string }
/** Запланированный звонок группы (админ с правом calls): плашка «Созвон · в 19:00 · Напомнить», напоминание в срок. */
export interface GroupCallPlan { id: string; at: number; title: string | null; by: Id }
/** Название звонка и плана — до стольких знаков. */
export const GROUP_CALL_TITLE_MAX = 64;

/** Участник звонка. session — сессия, которая ведёт звонок (ключи адресуются ей); pub — открытый ключ ECDH этой эпохи. */
export interface GroupCallMember { userId: Id; session: Id; pub: string; muted: boolean; video: boolean; screen: boolean; hand: number | null; joinedAt: number; mutedByAdmin?: boolean; mutedOnJoin?: boolean }   // mutedOnJoin — без микрофона по правилу «новые участники без микрофона»

/** Служебное «X начал(а) звонок» / «Звонок завершён (N мин)». */
/** Что видно по ссылке до входа: звонок, кто в нём, нужно ли одобрение. */
export interface GroupCallLinkPreview { callId: string; chatId: Id; chatTitle: string | null; title: string | null; count: number; faces: Id[]; approval: boolean; member: boolean }
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

export interface GroupCallServiceData { callId: string; state: 'started' | 'ended' | 'scheduled'; duration?: number; at?: number; title?: string }   // scheduled — «запланировал(а) звонок на …», callId — id плана

export type GroupCallClientFrame =
  | { op: 'groupCallStart'; reqId: string; chatId: Id }                                  // ack: { callId }
  | { op: 'groupCallJoin'; reqId: string; callId: string; pub: string; muted: boolean; video: boolean }   // ack: { token, identity, epoch }
  | { op: 'groupCallLeave'; callId: string }
  | { op: 'groupCallKeys'; callId: string; epoch: number; to: { session: Id; data: string }[] }
  | { op: 'groupCallUpdate'; callId: string; muted: boolean; video: boolean; screen: boolean; hand: boolean }
  | { op: 'groupCallPing'; callId: string }
  | { op: 'groupCallGet'; reqId: string; chatId: Id }                                     // ack: { call: GroupCallSummary | null }
  | { op: 'groupCallEnd'; reqId: string; callId: string }                                 // завершить для всех: начавший или админ с правом calls
  | { op: 'groupCallMute'; reqId: string; callId: string; userId: Id }                    // админ: выключить микрофон
  | { op: 'groupCallKick'; reqId: string; callId: string; userId: Id }                    // админ: удалить из звонка
  | { op: 'groupCallSettings'; reqId: string; callId: string; joinMuted?: boolean; title?: string }   // админ: без микрофона на входе, название звонка
  | { op: 'groupCallAllow'; reqId: string; callId: string; userId: Id }
  | { op: 'groupCallConference'; reqId: string; invite: Id[]; fromCall?: string }         // звонок без группы (из 1:1 — fromCall): ack { callId }
  | { op: 'groupCallInvite'; reqId: string; callId: string; users: Id[] }                 // позвать ещё (участник конференции): ack { invited }
  | { op: 'groupCallLink'; reqId: string; callId: string; approval: boolean; revoke?: boolean }   // ссылка-приглашение: ack { token } (revoke — отозвать все)
  | { op: 'groupCallLinkPreview'; reqId: string; token: string }                          // ack GroupCallLinkPreview
  | { op: 'groupCallLinkJoin'; reqId: string; token: string }                             // ack { callId, chatId } | { pending: true }
  | { op: 'groupCallDecide'; reqId: string; callId: string; userId: Id; approve: boolean };   // админ / создатель: пустить по заявке                  // админ: снова можно говорить (после «выключить» или правила входа)       // админ: новые участники — без микрофона

export type GroupCallServerFrame =
  | { op: 'groupCallState'; callId: string; chatId: Id; epoch: number; members: GroupCallMember[]; joinMuted?: boolean; title?: string; requests?: { id: Id; name: string }[]; startedBy?: Id }   // requests — заявки по ссылке (имя — у постороннего профиля не видно)
  | { op: 'groupCallInvited'; callId: string; from: Id; fromCall?: string; count: number }   // тебя зовут в звонок без группы
  | { op: 'groupCallApproved'; callId: string; chatId: Id }   // заявку по ссылке приняли — можно входить
  | { op: 'groupCallRefused'; callId: string }
  | { op: 'groupCallKeys'; callId: string; epoch: number; from: Id; userId: Id; data: string }
  | { op: 'groupCallEnded'; callId: string; chatId: Id }
  | { op: 'groupCallMuted'; callId: string; by: Id }       // админ выключил тебе микрофон
  | { op: 'groupCallKicked'; callId: string; by: Id };     // админ удалил тебя из звонка

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64U = /^[A-Za-z0-9_-]+$/;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const reqId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const b64u = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max && B64U.test(v);
const bool = (v: unknown): v is boolean => typeof v === 'boolean';

/** Разбор кадров группового звонка (часть parseClientFrame). null — не он или кадр неверен. */
export function parseGroupCallFrame(f: Record<string, unknown>): GroupCallClientFrame | null {
  const id = () => (f.callId as string).toLowerCase();
  switch (f.op) {
    case 'groupCallStart': return reqId(f.reqId) && int(f.chatId) ? { op: 'groupCallStart', reqId: f.reqId, chatId: f.chatId } : null;
    case 'groupCallJoin':
      return reqId(f.reqId) && uuid(f.callId) && b64u(f.pub, 43, 88) && bool(f.muted) && bool(f.video)
        ? { op: 'groupCallJoin', reqId: f.reqId, callId: id(), pub: f.pub as string, muted: f.muted, video: f.video } : null;
    case 'groupCallLeave': return uuid(f.callId) ? { op: 'groupCallLeave', callId: id() } : null;
    case 'groupCallKeys': {
      if (!uuid(f.callId) || !int(f.epoch) || !Array.isArray(f.to) || f.to.length === 0 || f.to.length > GROUP_CALL_MEMBERS_MAX) return null;
      const to: { session: Id; data: string }[] = [];
      for (const x of f.to as unknown[]) {
        const t = x as { session?: unknown; data?: unknown };
        if (!t || typeof t !== 'object' || !int(t.session) || !b64u(t.data, 16, GROUP_CALL_KEY_MAX)) return null;
        to.push({ session: t.session, data: t.data as string });
      }
      return { op: 'groupCallKeys', callId: id(), epoch: f.epoch, to };
    }
    case 'groupCallUpdate':
      return uuid(f.callId) && bool(f.muted) && bool(f.video) && bool(f.screen) && bool(f.hand)
        ? { op: 'groupCallUpdate', callId: id(), muted: f.muted, video: f.video, screen: f.screen, hand: f.hand } : null;
    case 'groupCallPing': return uuid(f.callId) ? { op: 'groupCallPing', callId: id() } : null;
    case 'groupCallGet': return reqId(f.reqId) && int(f.chatId) ? { op: 'groupCallGet', reqId: f.reqId, chatId: f.chatId } : null;
    case 'groupCallEnd': return reqId(f.reqId) && uuid(f.callId) ? { op: 'groupCallEnd', reqId: f.reqId, callId: id() } : null;
    case 'groupCallSettings': {
      const jm = f.joinMuted === undefined || bool(f.joinMuted), t = f.title === undefined || (typeof f.title === 'string' && f.title.length <= GROUP_CALL_TITLE_MAX * 4);
      if (!reqId(f.reqId) || !uuid(f.callId) || !jm || !t || (f.joinMuted === undefined && f.title === undefined)) return null;
      return { op: 'groupCallSettings', reqId: f.reqId, callId: id(), ...(f.joinMuted !== undefined ? { joinMuted: f.joinMuted as boolean } : {}), ...(f.title !== undefined ? { title: f.title as string } : {}) };
    }
    case 'groupCallConference': {
      if (!reqId(f.reqId) || !Array.isArray(f.invite) || f.invite.length === 0 || f.invite.length > 30 || !(f.invite as unknown[]).every(int)) return null;
      if (f.fromCall !== undefined && !uuid(f.fromCall)) return null;
      return { op: 'groupCallConference', reqId: f.reqId, invite: [...new Set(f.invite as number[])], ...(f.fromCall ? { fromCall: (f.fromCall as string).toLowerCase() } : {}) };
    }
    case 'groupCallInvite':
      return reqId(f.reqId) && uuid(f.callId) && Array.isArray(f.users) && f.users.length > 0 && f.users.length <= 30 && (f.users as unknown[]).every(int)
        ? { op: 'groupCallInvite', reqId: f.reqId, callId: id(), users: [...new Set(f.users as number[])] } : null;
    case 'groupCallLink':
      return reqId(f.reqId) && uuid(f.callId) && bool(f.approval) && (f.revoke === undefined || bool(f.revoke))
        ? { op: 'groupCallLink', reqId: f.reqId, callId: id(), approval: f.approval, ...(f.revoke ? { revoke: true } : {}) } : null;
    case 'groupCallLinkPreview': case 'groupCallLinkJoin':
      return reqId(f.reqId) && typeof f.token === 'string' && TOKEN.test(f.token) ? { op: f.op, reqId: f.reqId, token: f.token } : null;
    case 'groupCallDecide':
      return reqId(f.reqId) && uuid(f.callId) && int(f.userId) && bool(f.approve) ? { op: 'groupCallDecide', reqId: f.reqId, callId: id(), userId: f.userId, approve: f.approve } : null;
    case 'groupCallMute': case 'groupCallKick': case 'groupCallAllow':
      return reqId(f.reqId) && uuid(f.callId) && int(f.userId) ? { op: f.op, reqId: f.reqId, callId: id(), userId: f.userId } : null;
    default: return null;
  }
}
