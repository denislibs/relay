import { CALL_PING_MS, type CallEndReason, type CallInfo, type IceServer } from '@relay/protocol';
import type { CallEvent } from '@relay/sync-engine/src/engine';
import { getGlobal, setGlobal } from '../global';
import { getPrefs, setPref } from '../prefs';
import { CallCryptoError, commitOf, deriveSession, ephemeral, type Ephemeral, type Session } from './callCrypto';
import { failureOf, getCamera, getMic, stopStream, VIDEO_BITRATE } from './media';
import { soundSink, sounds, warmCallSounds } from './sounds';
import { loadUnseenCalls, noteMissedCall } from './callsList';
import { levelOf, sampleOf, smoother, videoCap, type NetLevel, type NetSample } from './quality';
import { closeCallNotification, parseCallHash, showCallNotification, type CallIntent } from './callNotify';
import { floodWait } from '../flood';

/**
 * Звонок 1:1 на странице (docs/plans/2026-11-06-relay-calls.md). RTCPeerConnection в воркере нет, поэтому звонок
 * ведёт вкладка: ключи (callCrypto), WebRTC, микрофон и камера. Сокет — у движка: кадры туда и обратно идут через
 * него (send / onCall). Сервер видит только шифротекст сигналинга.
 *
 * Звонок ведёт одна вкладка (Web Lock relay-call), входящий звонит мелодией в одной (relay-call-ring), показан —
 * во всех видимых. Состояние для интерфейса — global.call; потоки — callStreams().
 */

export type CallPhase = 'incoming' | 'requesting' | 'calling' | 'ringing' | 'exchanging' | 'connecting' | 'active' | 'reconnecting' | 'ended';
export type CallFailure = CallEndReason | 'security' | 'offline' | 'in_call' | 'flood' | 'no_mic' | 'gone';

export interface CallView {
  callId: string;
  chatId: number;
  peerId: number;
  outgoing: boolean;
  video: boolean;              // звонок начат как видеозвонок
  phase: CallPhase;
  startedAt: number | null;    // соединились (для таймера)
  emoji: string[] | null;      // 4 эмодзи сверки
  verified: boolean;           // отпечаток DTLS реального соединения совпал с полученным по шифру
  relay: boolean;              // идёт через TURN (кто-то из двоих не разрешил прямое соединение)
  mic: boolean; cam: boolean;  // мои
  peerMic: boolean; peerCam: boolean;
  net: NetLevel; peerNet: NetLevel;   // качество связи: моё и собеседника (calls/quality.ts)
  outPaused: boolean;          // моё видео на паузе: у собеседника очень слабый приём
  inPaused: boolean;           // видео собеседника на паузе по моей просьбе: у меня очень слабый приём
  reason: CallFailure | null;  // чем кончился (phase ended)
  duration?: number;
  rev: number;                 // потоки поменялись — перерисовать <video>
}

type Wire =
  | { hello: { fp: string | null; relay: boolean } }
  | { description: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit }
  | { media: { mic: boolean; cam: boolean } };

interface Active {
  view: CallView;
  commit: string;
  caller: number; callee: number;
  mine: Ephemeral | null;
  pubA?: string; pubB?: string;
  session: Session | null;
  inbox: string[];             // сигналы, пришедшие раньше ключа
  iceServers: IceServer[] | null;
  peerHello: { fp: string | null; relay: boolean } | null;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  cert: RTCCertificate | null;
  local: MediaStream;
  remote: MediaStream;
  audio: HTMLAudioElement | null;
  mic: MediaStreamTrack | null;
  cam: MediaStreamTrack | null;
  makingOffer: boolean; ignoreOffer: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  ping: ReturnType<typeof setInterval> | null;
  stats: ReturnType<typeof setInterval> | null;   // замер качества связи раз в STATS_MS
  smooth: (l: NetLevel) => NetLevel;
  counters: { lost: number; recv: number };
  bad: number; good: number;                      // замеров подряд: очень плохо / хорошо (пауза входящего видео)
  fakeNet?: NetSample | null;                     // dev: подменить замер (проверка плохой сети в Playwright)
  releaseLock: (() => void) | null;
  releaseRing: (() => void) | null;
  lastRestart: number;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectSince: number | null;
  ended: boolean;
  rung: boolean;               // адресату уже звонит (кадр мог прийти раньше ответа на запрос)
  moving?: boolean;            // разговор переходит в групповой: закончится тихо, без экрана «завершён»
}

type Send = (frame: Record<string, unknown> & { op: string }) => Promise<unknown>;

const TAB = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const CONNECT_MS = 30_000;       // ответили — на ключи и соединение
const RECONNECT_MS = 45_000;     // переподключение (как у Telegram)
const DISCONNECTED_MS = 2_000;   // «disconnected» дольше — перезапуск ICE
const RESTART_GAP_MS = 5_000;
const RING_LOCAL_MS = 50_000;    // страховка: сервер завершит «пропущен» через 45 с
const ENDED_SHOW_MS = 1_800;
const STATS_MS = 2_000;          // замер качества связи
const PAUSE_AFTER = 3;           // замеров подряд до паузы входящего видео и обратно

let send: Send = async () => { throw new Error('calls not started'); };
let me = 0;
let cur: Active | null = null;
let incoming: CallInfo | null = null;   // показанный здесь входящий, пока его не приняли в этой вкладке
// вкладку открыли из уведомления о звонке (#call=…): принять / показать этот звонок, когда сервер его отдаст
let intent: CallIntent | null = typeof location !== 'undefined' ? parseCallHash(location.hash) : null;
if (intent) history.replaceState(history.state, '', location.pathname + location.search);

const vol = () => getPrefs().calls.volume;
const view = (patch: Partial<CallView>) => {
  if (!cur) return;
  cur.view = { ...cur.view, ...patch };
  setGlobal({ call: cur.view });
};
const later = (a: Active, ms: number, fn: () => void) => { const t = setTimeout(() => { a.timers.delete(t); fn(); }, ms); a.timers.add(t); return t; };

declare const __DEV__: boolean;
// dev-сборка: звонок для проверок из консоли и Playwright (getStats, кандидаты)
if (typeof __DEV__ !== 'undefined' && __DEV__) (globalThis as { __relayCall?: () => Active | null }).__relayCall = () => cur;

/** Потоки текущего звонка — для <video> экрана звонка. */
export const callStreams = (): { local: MediaStream | null; remote: MediaStream | null } => ({ local: cur?.local ?? null, remote: cur?.remote ?? null });

/** Подключить к движку: кадры звонка и сверка после переподключения. */
export function bindCalls(opts: { userId: number; send: Send; onCall: (cb: (f: CallEvent) => void) => () => void }): void {
  me = opts.userId;
  send = opts.send;
  opts.onCall((f) => { void onEvent(f).catch((e) => console.warn('call:', e)); });
  addEventListener('pagehide', () => { if (cur && !cur.ended && cur.view.phase !== 'incoming') void send({ op: 'callHangup', callId: cur.view.callId }).catch(() => {}); });
  addEventListener('online', () => { if (cur?.pc && cur.view.outgoing) restartIce(cur); });
  void resync();
  // звуки звонка — посчитать заранее, в простое (первый звонок не ждёт синтеза)
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 2000));
  idle(warmCallSounds);
}

// ---------------------------------------------------------------------------------------------------------------
// Исходящий

/** Позвонить собеседнику личного чата. */
export async function startCall(chatId: number, peerId: number, video: boolean): Promise<void> {
  if (cur && !cur.ended) return;
  const release = await takeLock('relay-call');
  if (!release) { failToast('Вы уже разговариваете в другой вкладке'); return; }
  const callId = crypto.randomUUID();
  const a = fresh({ callId, chatId, peerId, outgoing: true, video, phase: 'requesting' }, me, peerId);
  a.releaseLock = release;
  cur = a;
  setGlobal({ call: a.view });
  if (!(await openMedia(a, video))) return;
  a.mine = await ephemeral();
  a.pubA = a.mine.pub;
  a.commit = await commitOf(callId, a.mine.pub);
  let r: { ok: boolean; reason?: string };
  try { r = await send({ op: 'callRequest', callId, chatId, video, commit: a.commit, tab: TAB }) as { ok: boolean; reason?: string }; }
  catch (e) { return finish(a, floodWait(e) != null ? 'flood' : 'offline', false); }
  if (a.ended) return;
  if (!r.ok) {
    if (r.reason === 'busy') sounds.busy(vol());
    return finish(a, (r.reason as CallFailure) ?? 'failed', false);
  }
  view({ phase: a.rung ? 'ringing' : 'calling' });
  if (a.rung) void ringback();
  later(a, RING_LOCAL_MS, () => { if (cur === a && (a.view.phase === 'calling' || a.view.phase === 'ringing')) hangup(); });
}

// ---------------------------------------------------------------------------------------------------------------
// Входящий

/** Ответить; withVideo — включить свою камеру (на видеозвонок можно ответить и без неё). */
export async function acceptCall(withVideo: boolean): Promise<void> {
  const inc = incoming;
  if (!inc || (cur && !cur.ended)) return;
  const release = await takeLock('relay-call');
  if (!release) return;   // ответила другая вкладка
  stopRing();
  closeCallNotification(inc.callId);
  const a = fresh({ callId: inc.callId, chatId: inc.chatId, peerId: inc.caller, outgoing: false, video: inc.video, phase: 'exchanging' }, inc.caller, me);
  a.commit = inc.commit;
  a.releaseLock = release;
  cur = a;
  incoming = null;
  setGlobal({ call: a.view });
  if (!(await openMedia(a, withVideo))) { void send({ op: 'callDecline', callId: inc.callId }).catch(() => {}); return; }
  a.mine = await ephemeral();
  a.pubB = a.mine.pub;
  let r: { ok: boolean; reason?: string };
  try { r = await send({ op: 'callAccept', callId: inc.callId, tab: TAB, pub: a.mine.pub }) as { ok: boolean; reason?: string }; }
  catch (e) { return finish(a, floodWait(e) != null ? 'flood' : 'offline', false); }
  if (!r.ok) return finish(a, r.reason === 'in_call' ? 'in_call' : 'gone', false);
  armConnectTimeout(a);
}

/** Отклонить входящий (на всех моих устройствах). */
export function declineCall(): void {
  const inc = incoming;
  if (!inc) return;
  void send({ op: 'callDecline', callId: inc.callId }).catch(() => {});
  dismissIncoming();
}

function showIncoming(c: CallInfo): void {
  if (cur && !cur.ended) return;                    // в этой вкладке уже разговор: входящий истечёт «пропущен»
  if (!getPrefs().calls.accept) return;             // на этом устройстве звонки не принимаются
  if (incoming?.callId === c.callId) return;
  incoming = c;
  void (async () => {
    if (await lockHeld('relay-call')) { incoming = null; return; }   // разговор в другой вкладке
    if (incoming !== c) return;
    setGlobal({ call: incomingView(c) });
    void send({ op: 'callReceived', callId: c.callId }).catch(() => {});
    if (intent?.callId === c.callId) {
      const { accept } = intent;
      intent = null;
      if (accept) { void acceptCall(c.video); return; }   // «Принять» в уведомлении
    } else if (document.hidden) showCallNotification(c, callerTitle(c));
    const release = await takeLock('relay-call-ring');
    if (incoming !== c) { release?.(); return; }
    if (release) { ringRelease = release; const p = getPrefs().calls; await soundSink(p.speaker); sounds.ringtone(p.ringtone, p.volume); }
  })();
}

/** Имя звонящего для уведомления: название личного чата; «скрывать текст в уведомлениях» — без имени. */
function callerTitle(c: CallInfo): string {
  if (getPrefs().screen.hideNotifyText) return 'Relay';
  return String(getGlobal().chats.find((x) => x.id === c.chatId)?.title ?? 'Relay');
}

/** Клик по уведомлению о звонке в уже открытой вкладке (sw.ts → сообщение { type: 'call' }). */
export function callIntent(callId: string, accept: boolean): void {
  if (incoming?.callId === callId && !(cur && !cur.ended)) {
    closeCallNotification(callId);
    if (accept) void acceptCall(incoming.video);
    return;
  }
  intent = { callId, accept };
  void resync();
}

let ringRelease: (() => void) | null = null;
function stopRing(): void { if (ringRelease) { sounds.stop(); ringRelease(); ringRelease = null; } }
function dismissIncoming(): void {
  if (incoming) closeCallNotification(incoming.callId);
  incoming = null;
  stopRing();
  if (!cur || cur.ended) setGlobal({ call: null });
}
const incomingView = (c: CallInfo): CallView => ({
  callId: c.callId, chatId: c.chatId, peerId: c.caller, outgoing: false, video: c.video, phase: 'incoming', startedAt: null, emoji: null,
  verified: false, relay: false, mic: true, cam: c.video, peerMic: true, peerCam: c.video, net: 3, peerNet: 3, outPaused: false, inPaused: false, reason: null, rev: 0,
});

// ---------------------------------------------------------------------------------------------------------------
// Во время звонка

export function hangup(): void {
  const a = cur;
  if (!a || a.ended) return;
  const ringing = a.view.phase === 'requesting' || a.view.phase === 'calling' || a.view.phase === 'ringing';
  void send(ringing ? { op: 'callDecline', callId: a.view.callId } : { op: 'callHangup', callId: a.view.callId }).catch(() => {});
  finish(a, ringing ? 'cancelled' : 'ended', true);
}

/** Разговор 1:1, который идёт сейчас (для «Добавить участника» и перехода собеседника в групповой). */
export const activeCallId = (): string | null => (cur && !cur.ended && cur.view.phase === 'active' ? cur.view.callId : null);

/**
 * Переход в групповой звонок (этап 8): Web Lock отдаём групповому, прямое соединение пока живёт — собеседник
 * слышен, пока оба не подключатся к групповому; потом finishMove закрывает его тихо.
 */
export function prepareMove(): boolean {
  const a = cur;
  if (!a || a.ended) return false;
  a.moving = true;
  a.releaseLock?.();
  a.releaseLock = null;
  return true;
}
export function finishMove(): void {
  const a = cur;
  if (!a || a.ended || !a.moving) return;
  void send({ op: 'callHangup', callId: a.view.callId }).catch(() => {});
  finish(a, 'ended', false);
}

export function toggleMic(): void {
  const a = cur;
  if (!a?.mic) return;
  a.mic.enabled = !a.mic.enabled;
  view({ mic: a.mic.enabled });
  shareMedia(a);
}

export async function toggleCam(): Promise<void> {
  const a = cur;
  if (!a || a.ended) return;
  const sender = videoSender(a);
  if (a.cam) {
    a.local.removeTrack(a.cam);
    a.cam.stop();
    a.cam = null;
    await sender?.replaceTrack(null);
    view({ cam: false, rev: a.view.rev + 1 });
  } else {
    let cam: MediaStreamTrack;
    try { cam = (await getCamera(getPrefs().calls)).track; }
    catch (e) { failToast(mediaText(failureOf(e), 'camera')); return; }
    if (cur !== a || a.ended) { cam.stop(); return; }
    a.cam = cam;
    a.local.addTrack(cam);
    if (!a.view.outPaused) await sender?.replaceTrack(cam);
    await capBitrate(a);
    view({ cam: true, rev: a.view.rev + 1 });
  }
  shareMedia(a);
}

/** Сменить устройство на лету (меню звонка, настройки). */
export async function switchDevice(kind: 'mic' | 'camera' | 'speaker'): Promise<void> {
  const a = cur;
  if (!a || a.ended) return;
  const p = getPrefs().calls;
  if (kind === 'speaker') { await sinkTo(a.audio, p.speaker); await soundSink(p.speaker); return; }
  if (kind === 'mic' && a.mic) {
    const { track } = await getMic(p);
    track.enabled = a.mic.enabled;
    await audioSender(a)?.replaceTrack(track);
    a.local.removeTrack(a.mic); a.mic.stop();
    a.mic = track; a.local.addTrack(track);
  }
  if (kind === 'camera' && a.cam) {
    const { track } = await getCamera(p);
    if (!a.view.outPaused) await videoSender(a)?.replaceTrack(track);
    a.local.removeTrack(a.cam); a.cam.stop();
    a.cam = track; a.local.addTrack(track);
    view({ rev: a.view.rev + 1 });
  }
}

/** «Размыть фон» в звонке: настройка сразу и для следующих звонков; камера включена — новая дорожка на лету. */
export async function setCallBackground(mode: 'none' | 'blur'): Promise<void> {
  setPref('calls.background', mode);
  const a = cur;
  if (!a || a.ended || !a.cam) return;
  try { await switchDevice('camera'); }
  catch (e) { failToast(mediaText(failureOf(e), 'camera')); }
}

// ---------------------------------------------------------------------------------------------------------------
// Кадры с сервера

async function onEvent(f: CallEvent): Promise<void> {
  switch (f.op) {
    case 'callResync': return resync();
    case 'callIncoming':
      if (f.call.callee === me) showIncoming(f.call);
      return;
    case 'callRinging':
      if (!cur || cur.view.callId !== f.callId || cur.rung) return;
      cur.rung = true;
      if (cur.view.phase === 'calling') { view({ phase: 'ringing' }); await ringback(); }
      return;
    case 'callAccepted': {
      // ответили не здесь (другая вкладка или устройство) — входящий гаснет
      if (incoming?.callId === f.callId && f.by.tab !== TAB) { dismissIncoming(); return; }
      const a = cur;
      if (!a || a.view.callId !== f.callId || a.ended) return;
      a.iceServers = f.iceServers;
      if (!a.view.outgoing) openPeer(a);
      if (a.view.outgoing && f.pub && a.mine) {
        sounds.stop();
        a.pubB = f.pub;
        view({ phase: 'exchanging' });
        void send({ op: 'callConfirm', callId: f.callId, pub: a.mine.pub }).catch(() => {});
        armConnectTimeout(a);
        await keyUp(a);
      }
      return;
    }
    case 'callConfirm': {
      const a = cur;
      if (!a || a.view.callId !== f.callId || a.view.outgoing || a.ended) return;
      a.pubA = f.pub;
      await keyUp(a);
      return;
    }
    case 'callSignal': {
      const a = cur;
      if (!a || a.view.callId !== f.callId || a.ended) return;
      if (!a.session) { if (a.inbox.length < 128) a.inbox.push(f.data); return; }
      await onSignal(a, f.data);
      return;
    }
    case 'callEnded': {
      if (incoming?.callId === f.callId) {
        if (f.reason === 'missed' || f.reason === 'cancelled') noteMissedCall();   // бейдж «Звонки» в меню
        dismissIncoming();
      }
      const a = cur;
      if (!a || a.view.callId !== f.callId || a.ended) return;
      finish(a, f.reason, true, f.duration);
      return;
    }
  }
}

async function ringback(): Promise<void> {
  const p = getPrefs().calls;
  await soundSink(p.speaker);
  sounds.ringback(p.volume);
}

/** Ключ звонка: у звонящего — после callAccepted, у адресата — после callConfirm. Подмена ключа — «ошибка безопасности». */
async function keyUp(a: Active): Promise<void> {
  if (a.session || !a.mine || !a.pubA || !a.pubB) return;
  try {
    a.session = await deriveSession({ role: a.view.outgoing ? 'caller' : 'callee', callId: a.view.callId, caller: a.caller, callee: a.callee, commit: a.commit, pubA: a.pubA, pubB: a.pubB, mine: a.mine });
  } catch (e) {
    if (e instanceof CallCryptoError) { securityFail(a); return; }
    throw e;
  }
  view({ emoji: a.session.emoji, phase: 'connecting' });
  a.cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' } as EcKeyGenParams);
  const fp = a.cert.getFingerprints().find((x) => x.algorithm === 'sha-256')?.value ?? null;
  await seal(a, { hello: { fp, relay: !p2pAllowed(a.view.peerId) } });
  for (const d of a.inbox.splice(0)) await onSignal(a, d);
}

async function onSignal(a: Active, data: string): Promise<void> {
  const m = await a.session!.open(data) as Wire | null;
  if (!m || typeof m !== 'object' || cur !== a || a.ended) return;   // подделка или повтор — молча мимо
  if ('hello' in m) {
    if (a.peerHello) return;
    const h = m.hello as { fp?: unknown; relay?: unknown };
    a.peerHello = { fp: typeof h.fp === 'string' && /^[0-9A-Fa-f:]{20,200}$/.test(h.fp) ? h.fp : null, relay: h.relay === true };
    openPeer(a);
    return;
  }
  if (!a.pc) return;
  if ('description' in m) return onDescription(a, m.description);
  if ('candidate' in m) {
    const c = m.candidate as RTCIceCandidateInit;
    if (!c || typeof c.candidate !== 'string' || c.candidate.length > 2048) return;
    try { await a.pc.addIceCandidate(c); } catch (e) { if (!a.ignoreOffer) console.warn('ice candidate:', e); }
    return;
  }
  if ('media' in m) onPeerMedia(a, m.media);
}

/** Описание от собеседника: строго SDP-строка разумного размера; встречные offer — perfect negotiation (вежлив адресат). */
async function onDescription(a: Active, d: RTCSessionDescriptionInit): Promise<void> {
  const pc = a.pc!;
  if (!d || (d.type !== 'offer' && d.type !== 'answer') || typeof d.sdp !== 'string' || d.sdp.length > 40_000 || !d.sdp.startsWith('v=0')) return;
  const polite = !a.view.outgoing;
  const collision = d.type === 'offer' && (a.makingOffer || pc.signalingState !== 'stable');
  a.ignoreOffer = !polite && collision;
  if (a.ignoreOffer) return;
  await pc.setRemoteDescription({ type: d.type, sdp: d.sdp });
  if (d.type === 'offer') {
    if (!a.view.outgoing) await attachToOffer(a);
    await pc.setLocalDescription();
    await seal(a, { description: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } });
  }
}

function onPeerMedia(a: Active, raw: unknown): void {
  const m = raw as { mic?: unknown; cam?: unknown };
  view({ peerMic: m.mic !== false, peerCam: m.cam === true, rev: a.view.rev + 1 });
}

// ---------------------------------------------------------------------------------------------------------------
// WebRTC

function openPeer(a: Active): void {
  if (a.pc || !a.peerHello || !a.cert || !a.iceServers) return;   // адресату серверы ICE приходят своим кадром
  const relay = !p2pAllowed(a.view.peerId) || a.peerHello.relay;
  const ice = a.iceServers!;
  if (relay && !ice.some((s) => s.username)) { failToast('Звонок через сервер-посредник недоступен'); hangupFailed(a); return; }
  view({ relay });
  const pc = new RTCPeerConnection({ iceServers: ice as RTCIceServer[], iceTransportPolicy: relay ? 'relay' : 'all', certificates: [a.cert], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  a.pc = pc;
  // состояние микрофона и камеры — отдельным каналом (DTLS); договорённый заранее id, без лишнего согласования
  a.dc = pc.createDataChannel('state', { negotiated: true, id: 0 });
  a.dc.onopen = () => shareMedia(a);
  a.dc.onmessage = (e) => {
    try {
      const m = JSON.parse(String(e.data));
      if (m?.media) onPeerMedia(a, m.media);
      if (typeof m?.net === 'number' && m.net >= 0 && m.net <= 3) { view({ peerNet: m.net as NetLevel }); void capBitrate(a); }
      if (typeof m?.pause === 'boolean') void pauseOut(a, m.pause);
    } catch { /* мусор */ }
  };
  pc.onicecandidate = (e) => { if (e.candidate) void seal(a, { candidate: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    a.remote.addTrack(e.track);
    e.track.onunmute = () => view({ rev: a.view.rev + 1 });
    view({ rev: a.view.rev + 1 });
  };
  pc.onnegotiationneeded = async () => {
    // первое предложение — всегда звонящего: канал данных адресата иначе сразу породил бы своё (только m=application),
    // и номера секций разъехались бы — канал данных отклонён, согласование по кругу
    if (!a.view.outgoing && !pc.remoteDescription) return;
    try {
      a.makingOffer = true;
      await pc.setLocalDescription();
      await seal(a, { description: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } });
    } catch (e) { console.warn('negotiation:', e); }
    finally { a.makingOffer = false; }
  };
  pc.onconnectionstatechange = () => onConnection(a);
  pc.oniceconnectionstatechange = () => onIce(a);
  if (a.view.outgoing) {
    // аудио и видео — сразу sendrecv: камеру можно включить посреди разговора без нового согласования. Без streams:
    // у видео без камеры поток при пустой дорожке заставлял Chrome пересогласовывать бесконечно, а собеседнику он
    // не нужен — свой поток он собирает из ontrack
    pc.addTransceiver(a.mic!, { direction: 'sendrecv' });
    const v = pc.addTransceiver(a.cam ?? 'video', { direction: 'sendrecv' });
    preferCodecs(v);
    void capBitrate(a);
  }
  // звук собеседника — через <audio> в выбранный динамик (видео рисует экран звонка, без звука)
  const el = new Audio();
  el.autoplay = true;
  el.srcObject = a.remote;
  a.audio = el;
  void sinkTo(el, getPrefs().calls.speaker);
  void el.play().catch(() => { addEventListener('pointerdown', () => void el.play().catch(() => {}), { once: true }); });
}

/** Адресат: к трансиверам из offer — свои дорожки, направление sendrecv. */
async function attachToOffer(a: Active): Promise<void> {
  for (const t of a.pc!.getTransceivers()) {
    const kind = t.receiver.track.kind;
    if (t.sender.track) continue;
    if (kind === 'audio' && a.mic) await t.sender.replaceTrack(a.mic);
    if (kind === 'video') { preferCodecs(t); if (a.cam) await t.sender.replaceTrack(a.cam); }
    t.direction = 'sendrecv';
  }
  void capBitrate(a);
}

function preferCodecs(t: RTCRtpTransceiver): void {
  const caps = typeof RTCRtpReceiver !== 'undefined' ? RTCRtpReceiver.getCapabilities?.('video') : null;
  if (!caps || !t.setCodecPreferences) return;
  const rank = (c: { mimeType: string }) => (/h264/i.test(c.mimeType) ? 0 : /vp8/i.test(c.mimeType) ? 1 : 2);
  try { t.setCodecPreferences([...caps.codecs].sort((x, y) => rank(x) - rank(y))); } catch { /* браузер не дал — по умолчанию */ }
}

async function capBitrate(a: Active): Promise<void> {
  const s = videoSender(a);
  if (!s) return;
  const p = s.getParameters();
  if (!p.encodings?.length) return;
  const cap = videoCap(Math.min(a.view.net, a.view.peerNet) as NetLevel, VIDEO_BITRATE[getPrefs().calls.video]);
  p.encodings[0].maxBitrate = cap.maxBitrate;
  p.encodings[0].scaleResolutionDownBy = cap.scale;
  await s.setParameters(p).catch(() => {});
}

/** Замер качества: свой уровень — на экран и собеседнику; очень плохой приём три замера подряд — попросить
 *  собеседника поставить видео на паузу (звук важнее), три хороших — снова включить. */
async function measure(a: Active): Promise<void> {
  if (!a.pc || cur !== a || a.ended) return;
  const report = await a.pc.getStats().catch(() => null);
  if (!report || cur !== a || a.ended) return;
  const real = sampleOf(report.values() as never, a.counters);
  const level = a.smooth(levelOf(typeof __DEV__ !== 'undefined' && __DEV__ && a.fakeNet ? a.fakeNet : real));
  if (level !== a.view.net) {
    view({ net: level });
    if (a.dc?.readyState === 'open') a.dc.send(JSON.stringify({ net: level }));
    void capBitrate(a);
  }
  a.bad = level === 0 ? a.bad + 1 : 0;
  a.good = level >= 2 ? a.good + 1 : 0;
  const ask = (pause: boolean) => { view({ inPaused: pause }); if (a.dc?.readyState === 'open') a.dc.send(JSON.stringify({ pause })); };
  if (!a.view.inPaused && a.bad >= PAUSE_AFTER && a.view.peerCam) ask(true);
  else if (a.view.inPaused && a.good >= PAUSE_AFTER) ask(false);
}

/** Собеседник просит паузу видео (у него очень слабый приём): дорожка снимается с отправителя, камера не гаснет. */
async function pauseOut(a: Active, pause: boolean): Promise<void> {
  if (a.view.outPaused === pause) return;
  view({ outPaused: pause });
  await videoSender(a)?.replaceTrack(pause ? null : a.cam).catch(() => {});
}

function onConnection(a: Active): void {
  const st = a.pc?.connectionState;
  if (cur !== a || a.ended) return;
  if (st === 'connected') {
    if (a.disconnectTimer) { clearTimeout(a.disconnectTimer); a.disconnectTimer = null; }
    if (a.reconnectSince != null) sounds.stop();   // переподключились — гудок переподключения стихает
    a.reconnectSince = null;
    const first = a.view.startedAt == null;
    view({ phase: 'active', startedAt: a.view.startedAt ?? Date.now() });
    if (first) {
      sounds.connected(vol());
      a.ping ??= setInterval(() => void send({ op: 'callPing', callId: a.view.callId }).catch(() => {}), CALL_PING_MS);
      a.stats ??= setInterval(() => void measure(a), STATS_MS);
      void verifyTransport(a);
    }
  }
  if (st === 'failed') beginReconnect(a, true);
}

function onIce(a: Active): void {
  const st = a.pc?.iceConnectionState;
  if (cur !== a || a.ended) return;
  if (st === 'disconnected' && !a.disconnectTimer) a.disconnectTimer = later(a, DISCONNECTED_MS, () => { a.disconnectTimer = null; if (a.pc?.iceConnectionState === 'disconnected') beginReconnect(a, false); });
  if (st === 'failed') beginReconnect(a, true);
}

function beginReconnect(a: Active, failed: boolean): void {
  if (a.view.startedAt == null) { if (failed) hangupFailed(a); return; }   // ни разу не соединились — таймер соединения решит
  if (a.view.phase !== 'reconnecting') { view({ phase: 'reconnecting' }); sounds.reconnecting(vol()); }
  a.reconnectSince ??= Date.now();
  later(a, RECONNECT_MS, () => { if (cur === a && !a.ended && a.reconnectSince != null && Date.now() - a.reconnectSince >= RECONNECT_MS - 50) hangupFailed(a); });
  // перезапускает звонящий; адресат ждёт его (как у Telegram), иначе встречные offer
  if (a.view.outgoing) restartIce(a);
}

function restartIce(a: Active): void {
  if (!a.pc || Date.now() - a.lastRestart < RESTART_GAP_MS) return;
  a.lastRestart = Date.now();
  a.pc.restartIce();
}

/**
 * Защита от подмены: отпечаток DTLS реального соединения — тот, что собеседник прислал по шифру, а наш — наш
 * сертификат. Браузер и так сверяет DTLS с SDP (а SDP пришёл по шифру); это вторая, независимая проверка.
 */
async function verifyTransport(a: Active): Promise<void> {
  const stats = await a.pc!.getStats().catch(() => null);
  if (!stats || cur !== a) return;
  let remoteFp: string | null = null, localFp: string | null = null;
  stats.forEach((r) => {
    if (r.type !== 'transport') return;
    const rc = r.remoteCertificateId && stats.get(r.remoteCertificateId), lc = r.localCertificateId && stats.get(r.localCertificateId);
    if (rc) remoteFp = String(rc.fingerprint);
    if (lc) localFp = String(lc.fingerprint);
  });
  const ownFp = a.cert?.getFingerprints().find((x) => x.algorithm === 'sha-256')?.value ?? null;
  const same = (x: string | null, y: string | null) => !!x && !!y && x.toLowerCase() === y.toLowerCase();
  if (remoteFp == null || a.peerHello?.fp == null) return;   // браузер не отдаёт сертификаты в статистике — остаются эмодзи
  if (!same(remoteFp, a.peerHello.fp) || (localFp && !same(localFp, ownFp))) { securityFail(a); return; }
  view({ verified: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Завершение

function hangupFailed(a: Active): void {
  void send({ op: 'callHangup', callId: a.view.callId, failed: true }).catch(() => {});
  finish(a, 'failed', true);
}

function securityFail(a: Active): void {
  void send({ op: 'callHangup', callId: a.view.callId, failed: true }).catch(() => {});
  finish(a, 'security', true);
}

function finish(a: Active, reason: CallFailure, sound: boolean, duration?: number): void {
  if (a.ended) return;
  a.ended = true;
  for (const t of a.timers) clearTimeout(t);
  a.timers.clear();
  if (a.ping) clearInterval(a.ping);
  if (a.stats) clearInterval(a.stats);
  if (a.disconnectTimer) clearTimeout(a.disconnectTimer);
  a.dc?.close();
  a.pc?.close();
  stopStream(a.local);
  if (a.audio) { a.audio.pause(); a.audio.srcObject = null; }
  sounds.stop();
  if (sound && !a.moving && (reason === 'failed' || reason === 'security')) sounds.failed(vol());
  else if (sound && !a.moving) sounds.ended(vol());
  a.releaseLock?.();
  a.releaseLock = null;
  if (a.moving) { cur = null; setGlobal({ call: null, callMin: false }); return; }   // ушли в групповой — он уже на экране
  const dur = duration ?? (a.view.startedAt ? Math.round((Date.now() - a.view.startedAt) / 1000) : undefined);
  view({ phase: 'ended', reason, duration: dur, rev: a.view.rev + 1 });
  setGlobal({ callMin: false });   // свёрнутый — разворачивается, чтобы было видно, чем кончился
  setTimeout(() => { if (cur === a) { cur = null; if (!incoming) setGlobal({ call: null, callMin: false }); } }, ENDED_SHOW_MS);
}

function armConnectTimeout(a: Active): void {
  later(a, CONNECT_MS, () => { if (cur === a && !a.ended && a.view.startedAt == null) hangupFailed(a); });
}

/** Сверка с сервером: новый сокет или вкладка открыта посреди звонка. */
async function resync(): Promise<void> {
  void loadUnseenCalls();
  let call: CallInfo | null;
  try { call = ((await send({ op: 'callGet' })) as { call: CallInfo | null }).call; } catch { return; }
  const a = cur;
  if (a && !a.ended && a.view.phase !== 'requesting') {
    if (!call || call.callId !== a.view.callId) finish(a, a.view.startedAt ? 'ended' : 'failed', true);   // сервер звонок уже закрыл
    return;
  }
  if (incoming && (!call || call.callId !== incoming.callId || call.state !== 'ringing')) dismissIncoming();
  if (call && call.state === 'ringing' && call.callee === me) showIncoming(call);
}

// ---------------------------------------------------------------------------------------------------------------
// Помощники

function fresh(v: Pick<CallView, 'callId' | 'chatId' | 'peerId' | 'outgoing' | 'video' | 'phase'>, caller: number, callee: number): Active {
  return {
    view: { ...v, startedAt: null, emoji: null, verified: false, relay: false, mic: true, cam: false, peerMic: true, peerCam: false, net: 3, peerNet: 3, outPaused: false, inPaused: false, reason: null, rev: 0 },
    commit: '', caller, callee, mine: null, session: null, inbox: [], iceServers: null, peerHello: null, pc: null, dc: null, cert: null,
    local: new MediaStream(), remote: new MediaStream(), audio: null, mic: null, cam: null, makingOffer: false, ignoreOffer: false,
    stats: null, smooth: smoother(), counters: { lost: 0, recv: 0 }, bad: 0, good: 0,
    timers: new Set(), ping: null, releaseLock: null, releaseRing: null, lastRestart: 0, disconnectTimer: null, reconnectSince: null, ended: false, rung: false,
  };
}

/** Микрофон обязателен, камера — по желанию (не дали — разговор голосом). */
async function openMedia(a: Active, video: boolean): Promise<boolean> {
  const p = getPrefs().calls;
  try {
    const { track, fellBack } = await getMic(p);
    a.mic = track; a.local.addTrack(track);
    if (fellBack) failToast('Выбранный микрофон не найден — используется системный');
  } catch (e) {
    failToast(mediaText(failureOf(e), 'mic'));
    finish(a, 'no_mic', false);
    return false;
  }
  if (video) {
    try { const { track } = await getCamera(p); a.cam = track; a.local.addTrack(track); }
    catch (e) { failToast(mediaText(failureOf(e), 'camera')); }
  }
  if (cur !== a || a.ended) { stopStream(a.local); return false; }
  view({ cam: !!a.cam, mic: true, rev: a.view.rev + 1 });
  return true;
}

function shareMedia(a: Active): void {
  const media = { mic: a.mic?.enabled ?? false, cam: !!a.cam };
  if (a.dc?.readyState === 'open') a.dc.send(JSON.stringify({ media }));
  else if (a.session) void seal(a, { media });
}

async function seal(a: Active, m: Wire): Promise<void> {
  if (!a.session || a.ended) return;
  const data = await a.session.seal(m);
  await send({ op: 'callSignal', callId: a.view.callId, data }).catch(() => {});
}

const audioSender = (a: Active) => a.pc?.getTransceivers().find((t) => t.receiver.track.kind === 'audio')?.sender;
const videoSender = (a: Active) => a.pc?.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender;

async function sinkTo(el: HTMLAudioElement | null, id: string | null): Promise<void> {
  const e = el as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
  if (e?.setSinkId) await e.setSinkId(id ?? '').catch(() => {});
}

/** Прямое соединение с собеседником: моё правило «Пиринговые соединения» (по умолчанию — контакты). */
export function p2pAllowed(peerId: number): boolean {
  const g = getGlobal();
  const r = g.settings.privacy.p2p;
  if (r.deny.includes(peerId)) return false;
  if (r.allow.includes(peerId)) return true;
  if (r.mode === 'everyone') return true;
  if (r.mode === 'contacts') return g.contacts.some((c) => c.userId === peerId);
  return false;
}

async function takeLock(name: string): Promise<(() => void) | null> {
  if (!navigator.locks) return () => {};
  return new Promise((resolve) => {
    void navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(null); return; }
      return new Promise<void>((release) => resolve(() => release()));
    });
  });
}

async function lockHeld(name: string): Promise<boolean> {
  if (!navigator.locks?.query) return false;
  const q = await navigator.locks.query().catch(() => null);
  return !!q?.held?.some((l) => l.name === name);
}

function mediaText(f: ReturnType<typeof failureOf>, what: 'mic' | 'camera'): string {
  const w = what === 'mic' ? 'микрофону' : 'камере';
  if (f === 'denied') return `Нет доступа к ${w} — разрешите его в настройках браузера`;
  if (f === 'missing') return what === 'mic' ? 'Микрофон не найден' : 'Камера не найдена';
  if (f === 'busy') return what === 'mic' ? 'Микрофон занят другим приложением' : 'Камера занята другим приложением';
  if (f === 'insecure') return 'Звонки работают только по защищённому соединению';
  if (f === 'blur') return 'Не удалось размыть фон — камера не включена';
  return what === 'mic' ? 'Не удалось включить микрофон' : 'Не удалось включить камеру';
}

let toastFn: (text: string) => void = (t) => console.warn(t);
export function bindCallToast(fn: (text: string) => void): void { toastFn = fn; }
function failToast(text: string): void { toastFn(text); }
