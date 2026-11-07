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
export interface GroupCallSummary { callId: string; count: number; startedAt: number; faces: Id[] }

/** Участник звонка. session — сессия, которая ведёт звонок (ключи адресуются ей); pub — открытый ключ ECDH этой эпохи. */
export interface GroupCallMember { userId: Id; session: Id; pub: string; muted: boolean; video: boolean; screen: boolean; hand: number | null; joinedAt: number; mutedByAdmin?: boolean }

/** Служебное «X начал(а) звонок» / «Звонок завершён (N мин)». */
export interface GroupCallServiceData { callId: string; state: 'started' | 'ended'; duration?: number }

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
  | { op: 'groupCallKick'; reqId: string; callId: string; userId: Id };                   // админ: удалить из звонка

export type GroupCallServerFrame =
  | { op: 'groupCallState'; callId: string; chatId: Id; epoch: number; members: GroupCallMember[] }
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
    case 'groupCallMute': case 'groupCallKick':
      return reqId(f.reqId) && uuid(f.callId) && int(f.userId) ? { op: f.op, reqId: f.reqId, callId: id(), userId: f.userId } : null;
    default: return null;
  }
}
