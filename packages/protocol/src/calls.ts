// Звонки 1:1 (docs/plans/2026-11-06-relay-calls.md). Сервер — арбитр состояния (кто принял, кто занят, когда
// истекло) и почтальон: ключи звонка и сигналинг WebRTC идут непрозрачными строками, зашифрованными на клиентах.

type Id = number;

/** Сколько звонит входящий без ответа (как у Telegram). */
export const CALL_RING_MS = 45_000;
/** Предел одного сигнального пакета (base64url шифротекста): SDP с запасом. */
export const CALL_SIGNAL_MAX = 48_000;
/** Как часто стороны подтверждают, что разговор жив; без подтверждения ~3 интервала сервер считает звонок брошенным. */
export const CALL_PING_MS = 20_000;

/** Как закончился звонок — для служебного сообщения и экрана. unavailable — адресату нельзя позвонить (приватность,
 *  блокировка), без объяснения причины. */
export type CallEndReason = 'missed' | 'declined' | 'cancelled' | 'busy' | 'ended' | 'failed' | 'unavailable';

/** Сервер ICE для RTCPeerConnection: STUN без учётки или TURN с временной учёткой на звонок. */
export interface IceServer { urls: string[]; username?: string; credential?: string }

/** Служебное сообщение о звонке: автор — звонящий (по нему клиент понимает, входящий или исходящий). */
export interface CallServiceData { video: boolean; reason: CallEndReason; duration?: number }

/** Какая вкладка какой сессии ведёт звонок со стороны адресата (у вкладок одного браузера сессия общая). */
export interface CallSide { session: Id; tab: string }

/** Звонок, который ещё идёт: для вкладки, открытой посреди звонка (уведомление, перезагрузка). */
export interface CallInfo { callId: string; chatId: Id; caller: Id; callee: Id; video: boolean; commit: string; state: 'ringing' | 'accepted'; at: number }

export type CallClientFrame =
  // commit — SHA-256(pubA ‖ callId) звонящего (обязательство: сам ключ — только после ответа); tab — вкладка звонящего
  | { op: 'callRequest'; reqId: string; callId: string; chatId: Id; video: boolean; commit: string; tab: string }
  | { op: 'callReceived'; callId: string }                                     // входящий показан — у звонящего «Звонок…»
  | { op: 'callAccept'; reqId: string; callId: string; tab: string; pub: string }   // pub — открытый ключ адресата
  | { op: 'callConfirm'; callId: string; pub: string }                         // звонящий раскрывает свой ключ
  | { op: 'callDecline'; callId: string }                                      // до ответа: адресат — «отклонить», звонящий — «отменить»
  | { op: 'callHangup'; callId: string; failed?: boolean }                     // failed — так и не соединились
  | { op: 'callSignal'; callId: string; data: string }                         // шифротекст (base64url), сервер не читает
  | { op: 'callPing'; callId: string }
  | { op: 'callGet'; reqId: string };                                          // мой текущий звонок (если есть)

export type CallServerFrame =
  | { op: 'callIncoming'; call: CallInfo }
  | { op: 'callRinging'; callId: string }
  | { op: 'callAccepted'; callId: string; by: CallSide; pub?: string; iceServers: IceServer[] }   // pub — только звонящему
  | { op: 'callConfirm'; callId: string; pub: string }
  | { op: 'callSignal'; callId: string; data: string }
  | { op: 'callEnded'; callId: string; reason: CallEndReason; duration?: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64U = /^[A-Za-z0-9_-]+$/;
const TAB = /^[a-z0-9]{8,32}$/;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const reqId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const b64u = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max && B64U.test(v);
const tab = (v: unknown): v is string => typeof v === 'string' && TAB.test(v);
// SHA-256 — 43 знака; открытый ключ X25519 (32 байта) — 43, P-256 без сжатия (65) — 87
const commit = (v: unknown) => b64u(v, 43, 43);
const pub = (v: unknown) => b64u(v, 43, 88);

/** Разбор кадров звонка (часть parseClientFrame). null — не звонок или кадр неверен. */
export function parseCallFrame(f: Record<string, unknown>): CallClientFrame | null {
  switch (f.op) {
    case 'callRequest':
      return reqId(f.reqId) && uuid(f.callId) && int(f.chatId) && typeof f.video === 'boolean' && commit(f.commit) && tab(f.tab)
        ? { op: 'callRequest', reqId: f.reqId, callId: f.callId.toLowerCase(), chatId: f.chatId, video: f.video, commit: f.commit as string, tab: f.tab } : null;
    case 'callReceived': return uuid(f.callId) ? { op: 'callReceived', callId: f.callId.toLowerCase() } : null;
    case 'callAccept':
      return reqId(f.reqId) && uuid(f.callId) && tab(f.tab) && pub(f.pub) ? { op: 'callAccept', reqId: f.reqId, callId: f.callId.toLowerCase(), tab: f.tab, pub: f.pub as string } : null;
    case 'callConfirm': return uuid(f.callId) && pub(f.pub) ? { op: 'callConfirm', callId: f.callId.toLowerCase(), pub: f.pub as string } : null;
    case 'callDecline': return uuid(f.callId) ? { op: 'callDecline', callId: f.callId.toLowerCase() } : null;
    case 'callHangup': return uuid(f.callId) ? { op: 'callHangup', callId: f.callId.toLowerCase(), ...(f.failed === true ? { failed: true } : {}) } : null;
    case 'callSignal': return uuid(f.callId) && b64u(f.data, 16, CALL_SIGNAL_MAX) ? { op: 'callSignal', callId: f.callId.toLowerCase(), data: f.data as string } : null;
    case 'callPing': return uuid(f.callId) ? { op: 'callPing', callId: f.callId.toLowerCase() } : null;
    case 'callGet': return reqId(f.reqId) ? { op: 'callGet', reqId: f.reqId } : null;
    default: return null;
  }
}
