import { GROUP_CALL_PING_MS, type GroupCallMember } from '@relay/protocol';
import type { CallEvent } from '@relay/sync-engine/src/engine';
import { asset } from '../assets';
import { getGlobal, setGlobal } from '../global';
import { getPrefs, setPref } from '../prefs';
import { ephemeral, type Ephemeral } from './callCrypto';
import { membersEmoji, openSenderKey, sealSenderKey, senderKey } from './groupCrypto';
import { audioConstraints, failureOf, videoConstraints } from './media';
import { blurProcessor } from './background';
import type { NetLevel } from './quality';
import { sounds } from './sounds';

/**
 * Групповой звонок на странице (docs/plans/2026-11-07-relay-group-calls.md). Медиа — комната LiveKit (livekit-client,
 * грузится при первом звонке), кадры шифруются в потоке E2EE ключом отправителя. Свой ключ на эпоху раздаём каждому
 * участнику адресно (groupCrypto), чужие кладём в провайдер ключей под их идентичность. Эпоха растёт при каждом входе
 * и выходе — старые ключи становятся бесполезны новым и ушедшим. Звонок ведёт одна вкладка (Web Lock relay-call —
 * общий со звонками 1:1).
 */

type LK = typeof import('livekit-client');

export interface GroupMemberView extends GroupCallMember { identity: string; me: boolean; speaking: boolean; net: NetLevel }
export interface GroupCallView {
  callId: string;
  chatId: number;
  phase: 'joining' | 'active' | 'reconnecting' | 'ended';
  epoch: number;
  members: GroupMemberView[];
  emoji: string[] | null;
  mic: boolean; cam: boolean; screen: boolean; hand: boolean;
  mutedByAdmin: boolean;
  startedBy: number | null;
  reason: 'left' | 'ended' | 'kicked' | 'failed' | 'no_mic' | 'busy' | null;
  rev: number;   // дорожки поменялись — перерисовать видео
}

type Send = (frame: Record<string, unknown> & { op: string }) => Promise<unknown>;

interface Active {
  view: GroupCallView;
  mine: Ephemeral;
  session: number;
  identity: string;
  lk: LK;
  room: import('livekit-client').Room;
  keys: SenderKeys;
  myKeys: Map<number, Uint8Array>;      // эпоха → мой ключ отправителя
  sent: Set<number>;                     // эпохи, ключ которых я уже раздал
  pending: Map<string, { epoch: number; from: number; userId: number; data: string }[]>;   // ключи, пришедшие раньше состава
  ping: ReturnType<typeof setInterval> | null;
  releaseLock: (() => void) | null;
  ended: boolean;
  audios: Map<string, HTMLMediaElement>;
}

const KEYRING = 16;
const SWITCH_MS = 400;   // свой новый ключ — в дело чуть позже раздачи: у получателей он уже есть, кадры не теряются

let send: Send = async () => { throw new Error('group calls not started'); };
let me = 0;
let cur: Active | null = null;
/** Входим в этот звонок: кадры состава и ключей могут прийти раньше ответа на вход — копим и применяем после. */
let joining: { callId: string; early: CallEvent[] } | null = null;
let toast: (t: string) => void = (t) => console.warn(t);

let SenderKeys: new () => SenderKeys;
interface SenderKeys { set(identity: string, raw: Uint8Array, index: number): Promise<void> }

const view = (patch: Partial<GroupCallView>) => {
  if (!cur) return;
  cur.view = { ...cur.view, ...patch };
  setGlobal({ groupCall: cur.view });
};

/** Дорожки текущего звонка по идентичности участника — для плиток видео. */
export function groupTracks(identity: string): { camera: MediaStreamTrack | null; screen: MediaStreamTrack | null } {
  const a = cur;
  if (!a) return { camera: null, screen: null };
  const p = identity === a.identity ? a.room.localParticipant : a.room.remoteParticipants.get(identity);
  if (!p) return { camera: null, screen: null };
  const pick = (src: string) => [...p.trackPublications.values()].find((t) => t.source === src && t.track && !t.isMuted)?.track?.mediaStreamTrack ?? null;
  return { camera: pick(a.lk.Track.Source.Camera), screen: pick(a.lk.Track.Source.ScreenShare) };
}

export function bindGroupCalls(opts: { userId: number; send: Send; onCall: (cb: (f: CallEvent) => void) => () => void; toast: (t: string) => void }): void {
  me = opts.userId;
  send = opts.send;
  toast = opts.toast;
  opts.onCall((f) => { void onEvent(f).catch((e) => console.warn('group call:', e)); });
  addEventListener('pagehide', () => { if (cur && !cur.ended) void send({ op: 'groupCallLeave', callId: cur.view.callId }).catch(() => {}); });
}

/** Начать звонок в группе (или войти в идущий). */
export async function startGroupCall(chatId: number): Promise<void> {
  let r: { callId: string };
  try { r = await send({ op: 'groupCallStart', chatId }) as { callId: string }; }
  catch (e) { toast(String((e as { code?: string })?.code ?? e).includes('forbidden') ? 'Начинать звонки в этой группе могут только администраторы' : 'Не удалось начать звонок'); return; }
  await joinGroupCall(chatId, r.callId);
}

/** Войти в идущий звонок группы. */
export async function joinGroupCall(chatId: number, callId: string): Promise<void> {
  if (cur && !cur.ended) { if (cur.view.callId === callId) setGlobal({ groupCallMin: false }); return; }
  if (getGlobal().call) { toast('Сначала завершите текущий звонок'); return; }
  const release = await takeLock('relay-call');
  if (!release) { toast('Вы уже в звонке в другой вкладке'); return; }
  const p = getPrefs().calls;
  // микрофон — сразу (и проверка разрешения); дальше его публикует LiveKit с теми же настройками
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(p) }); s.getTracks().forEach((t) => t.stop()); }
  catch (e) { release(); toast(failureOf(e) === 'denied' ? 'Нет доступа к микрофону — разрешите его в настройках браузера' : 'Не удалось включить микрофон'); return; }
  const lk = await import('livekit-client');
  SenderKeys ??= makeKeyProvider(lk);
  const mine = await ephemeral();
  let j: { token: string; identity: string; epoch: number };
  joining = { callId, early: [] };
  try { j = await send({ op: 'groupCallJoin', callId, pub: mine.pub, muted: false, video: false }) as { token: string; identity: string; epoch: number }; }
  catch { joining = null; release(); toast('Звонок уже закончился'); return; }
  const session = Number(/-s(\d+)$/.exec(j.identity)?.[1] ?? 0);
  const keys = new SenderKeys();
  const room = new lk.Room({
    adaptiveStream: true, dynacast: true,   // качество под размер плитки, ненужные слои не отправляются
    encryption: { keyProvider: keys as unknown as import('livekit-client').BaseKeyProvider, worker: new Worker(asset('lkE2ee.worker.js'), { type: 'module' }) },
    audioCaptureDefaults: audioConstraints(p) as never,
    videoCaptureDefaults: { resolution: lk.VideoPresets.h720.resolution },
  });
  const a: Active = {
    view: { callId, chatId, phase: 'joining', epoch: j.epoch, members: [], emoji: null, mic: true, cam: false, screen: false, hand: false, mutedByAdmin: false, startedBy: null, reason: null, rev: 0 },
    mine, session, identity: j.identity, lk, room, keys, myKeys: new Map(), sent: new Set(), pending: new Map(), ping: null, releaseLock: release, ended: false, audios: new Map(),
  };
  cur = a;
  const early = joining?.callId === callId ? joining.early : [];
  joining = null;
  setGlobal({ groupCall: a.view, groupCallMin: false });
  wireRoom(a);
  for (const f of early) await onEvent(f).catch((e) => console.warn('group call:', e));
  // свой ключ первой эпохи — до того, как пойдёт микрофон: иначе первые кадры шифровать нечем
  const first = senderKey();
  a.myKeys.set(j.epoch, first);
  await keys.set(a.identity, first, j.epoch % KEYRING);
  try {
    await room.setE2EEEnabled(true);
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/livekit';
    await room.connect(url, j.token, { autoSubscribe: true });
    await room.localParticipant.setMicrophoneEnabled(true);
  } catch (e) {
    console.warn('livekit connect:', e);
    toast('Не удалось подключиться к звонку');
    return finish(a, 'failed');
  }
  view({ phase: 'active' });
  sounds.connected(p.volume);
  a.ping = setInterval(() => void send({ op: 'groupCallPing', callId }).catch(() => {}), GROUP_CALL_PING_MS);
}

export function leaveGroupCall(): void {
  const a = cur;
  if (!a || a.ended) return;
  void send({ op: 'groupCallLeave', callId: a.view.callId }).catch(() => {});
  finish(a, 'left');
}

export async function endGroupCallForAll(): Promise<void> {
  const a = cur;
  if (!a) return;
  try { await send({ op: 'groupCallEnd', callId: a.view.callId }); } catch { toast('Завершить звонок для всех может начавший или администратор'); }
}

export async function toggleGroupMic(): Promise<void> {
  const a = cur;
  if (!a) return;
  if (a.view.mutedByAdmin && !a.view.mic) { toast('Администратор выключил вам микрофон — поднимите руку, чтобы попросить слово'); return; }
  const on = !a.view.mic;
  await a.room.localParticipant.setMicrophoneEnabled(on);
  view({ mic: on });
  pushState(a);
}

export async function toggleGroupCam(): Promise<void> {
  const a = cur;
  if (!a) return;
  const on = !a.view.cam;
  try {
    await a.room.localParticipant.setCameraEnabled(on, on ? videoConstraints(getPrefs().calls) as never : undefined);
    if (on) await applyBackground(a);
  } catch (e) {
    if (on) await a.room.localParticipant.setCameraEnabled(false).catch(() => {});   // фон не скрылся — камеру не показываем
    toast(failureOf(e) === 'denied' ? 'Нет доступа к камере' : failureOf(e) === 'blur' ? 'Не удалось размыть фон — камера не включена' : 'Не удалось включить камеру');
    return;
  }
  view({ cam: on, rev: a.view.rev + 1 });
  pushState(a);
}

/** «Размыть фон» (настройка calls.background): обработчик на дорожке камеры LiveKit — до того, как кадры уйдут. */
async function applyBackground(a: Active): Promise<void> {
  const track = a.room.localParticipant.getTrackPublication(a.lk.Track.Source.Camera)?.videoTrack;
  if (!track) return;
  const want = getPrefs().calls.background === 'blur';
  const has = track.getProcessor()?.name === 'relay-blur';
  try {
    if (want && !has) await track.setProcessor(blurProcessor() as never);
    else if (!want && has) await track.stopProcessor();
  } catch (e) { console.warn('background blur:', e); throw Object.assign(new Error('blur'), { name: 'BlurError' }); }
}

/** Переключатель фона в групповом звонке: настройка сразу и для следующих звонков. */
export async function setGroupBackground(mode: 'none' | 'blur'): Promise<void> {
  setPref('calls.background', mode);
  const a = cur;
  if (!a || !a.view.cam) return;
  try { await applyBackground(a); }
  catch { await toggleGroupCam(); toast('Не удалось размыть фон — камера выключена'); }
}

export async function toggleGroupScreen(): Promise<void> {
  const a = cur;
  if (!a) return;
  const on = !a.view.screen;
  try { await a.room.localParticipant.setScreenShareEnabled(on, { audio: false }); }
  catch { if (on) toast('Демонстрация экрана отменена'); return; }
  view({ screen: on, rev: a.view.rev + 1 });
  pushState(a);
}

export function toggleGroupHand(): void {
  const a = cur;
  if (!a) return;
  view({ hand: !a.view.hand });
  pushState(a);
}

/** Админ: выключить микрофон / удалить из звонка. */
export async function adminGroupAction(kind: 'mute' | 'kick', userId: number): Promise<void> {
  const a = cur;
  if (!a) return;
  try { await send({ op: kind === 'mute' ? 'groupCallMute' : 'groupCallKick', callId: a.view.callId, userId }); }
  catch { toast('Нужно право «Управление звонками»'); }
}

// ---------------------------------------------------------------------------------------------------------------

function pushState(a: Active): void {
  void send({ op: 'groupCallUpdate', callId: a.view.callId, muted: !a.view.mic, video: a.view.cam, screen: a.view.screen, hand: a.view.hand }).catch(() => {});
}

function wireRoom(a: Active): void {
  const E = a.lk.RoomEvent;
  a.room.on(E.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind === 'audio') {
      const el = track.attach();
      el.style.display = 'none';
      document.body.appendChild(el);
      const sink = getPrefs().calls.speaker;
      const e = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
      if (sink && e.setSinkId) void e.setSinkId(sink).catch(() => {});
      a.audios.set(track.sid ?? participant.identity, el);
    }
    view({ rev: a.view.rev + 1 });
  });
  a.room.on(E.TrackUnsubscribed, (track) => {
    for (const el of track.detach()) el.remove();
    a.audios.delete(track.sid ?? '');
    view({ rev: a.view.rev + 1 });
  });
  a.room.on(E.TrackMuted, () => view({ rev: a.view.rev + 1 }));
  a.room.on(E.TrackUnmuted, () => view({ rev: a.view.rev + 1 }));
  a.room.on(E.LocalTrackPublished, () => view({ rev: a.view.rev + 1 }));
  a.room.on(E.LocalTrackUnpublished, (pub) => {
    // демонстрацию остановили кнопкой браузера «Прекратить показ»
    if (pub.source === a.lk.Track.Source.ScreenShare && a.view.screen) { view({ screen: false }); pushState(a); }
    view({ rev: a.view.rev + 1 });
  });
  a.room.on(E.ActiveSpeakersChanged, (speakers) => {
    const ids = new Set(speakers.map((s) => s.identity));
    view({ members: a.view.members.map((m) => ({ ...m, speaking: ids.has(m.identity) })) });
  });
  // качество связи каждого (и своё) — от LiveKit: значок на плитке, «Плохое соединение» у себя (calls/quality.ts)
  a.room.on(E.ConnectionQualityChanged, (q, p) => {
    const level = lkLevel(String(q));
    view({ members: a.view.members.map((m) => (m.identity === p.identity ? { ...m, net: level } : m)) });
  });
  a.room.on(E.Reconnecting, () => view({ phase: 'reconnecting' }));
  a.room.on(E.Reconnected, () => view({ phase: 'active' }));
  a.room.on(E.Disconnected, () => { if (!a.ended) finish(a, 'failed'); });
  a.room.on(E.EncryptionError, (e) => console.warn('group call e2ee:', e));
}

async function onEvent(f: CallEvent): Promise<void> {
  const a = cur;
  if (f.op === 'callResync') { if (a && !a.ended) await rejoin(a); return; }
  if (!a && joining && 'callId' in f && f.callId === joining.callId) { if (joining.early.length < 64) joining.early.push(f); return; }
  if (!a || a.ended || !('callId' in f) || f.callId !== a.view.callId) return;
  switch (f.op) {
    case 'groupCallState': return onState(a, f.epoch, f.members);
    case 'groupCallKeys': return onKeys(a, f);
    case 'groupCallEnded': return finish(a, 'ended');
    case 'groupCallMuted':
      await a.room.localParticipant.setMicrophoneEnabled(false);
      view({ mic: false, mutedByAdmin: true, hand: false });
      toast('Администратор выключил вам микрофон');
      return;
    case 'groupCallKicked': toast('Администратор удалил вас из звонка'); return finish(a, 'kicked');
  }
}

/** ConnectionQuality LiveKit → наш уровень 0–3 (calls/quality.ts). */
const lkLevel = (q: string): NetLevel => (q === 'excellent' ? 3 : q === 'good' ? 2 : q === 'poor' ? 1 : q === 'lost' ? 0 : 3);

/** Новый состав: эмодзи, флаги, и если эпоха выросла — новый свой ключ всем. */
async function onState(a: Active, epoch: number, members: GroupCallMember[]): Promise<void> {
  const speaking = new Set(a.view.members.filter((m) => m.speaking).map((m) => m.identity));
  const net = new Map(a.view.members.map((m) => [m.identity, m.net]));
  const list: GroupMemberView[] = members.map((m) => {
    const identity = `u${m.userId}-s${m.session}`;
    return { ...m, identity, me: m.session === a.session, speaking: speaking.has(identity), net: net.get(identity) ?? 3 };
  });
  const mine = list.find((m) => m.me);
  view({ members: list, epoch, mutedByAdmin: !!mine?.mutedByAdmin, emoji: await membersEmoji(a.view.callId, members) });
  // ключи, пришедшие раньше состава (отправитель ещё не был известен)
  for (const [id, waiting] of a.pending) { a.pending.delete(id); for (const k of waiting) await onKeys(a, k); }
  if (!a.sent.has(epoch)) await rekey(a, epoch);
}

/** Свой ключ отправителя эпохи: каждому участнику — адресно, себе — в провайдер чуть позже (у получателей уже будет). */
async function rekey(a: Active, epoch: number): Promise<void> {
  a.sent.add(epoch);
  const fresh = !a.myKeys.has(epoch);   // ключ первой эпохи уже стоит (поставлен до подключения) — только раздать
  const key = a.myKeys.get(epoch) ?? senderKey();
  a.myKeys.set(epoch, key);
  for (const e of [...a.sent]) if (e < epoch - 2) a.sent.delete(e);
  for (const e of [...a.myKeys.keys()]) if (e < epoch - 2) a.myKeys.delete(e);
  const others = a.view.members.filter((m) => !m.me);
  const to = await Promise.all(others.map(async (m) => ({ session: m.session, data: await sealSenderKey({ mine: a.mine, theirPub: m.pub, callId: a.view.callId, epoch, from: a.session, to: m.session, key }) })));
  if (to.length) await send({ op: 'groupCallKeys', callId: a.view.callId, epoch, to }).catch(() => {});
  if (fresh) setTimeout(() => { if (cur === a && !a.ended && a.view.epoch === epoch) void a.keys.set(a.identity, key, epoch % KEYRING); }, others.length ? SWITCH_MS : 0);
}

async function onKeys(a: Active, f: { epoch: number; from: number; userId: number; data: string }): Promise<void> {
  const sender = a.view.members.find((m) => m.session === f.from);
  if (!sender) {
    const id = String(f.from);
    const q = a.pending.get(id) ?? [];
    if (q.length < 8) q.push({ epoch: f.epoch, from: f.from, userId: f.userId, data: f.data });
    a.pending.set(id, q);
    return;
  }
  if (sender.userId !== f.userId) return;   // сервер прислал ключ «от» другой сессии — не верим
  const key = await openSenderKey({ mine: a.mine, theirPub: sender.pub, callId: a.view.callId, epoch: f.epoch, from: f.from, to: a.session, data: f.data });
  if (!key) return;
  await a.keys.set(sender.identity, key, f.epoch % KEYRING);
}

/** Сокет переподключился: сервер мог нас забыть — войти снова той же сессией (эпоха вырастет, ключи разойдутся заново). */
async function rejoin(a: Active): Promise<void> {
  try { await send({ op: 'groupCallJoin', callId: a.view.callId, pub: a.mine.pub, muted: !a.view.mic, video: a.view.cam }); }
  catch { finish(a, 'ended'); }
}

function finish(a: Active, reason: NonNullable<GroupCallView['reason']>): void {
  if (a.ended) return;
  a.ended = true;
  if (a.ping) clearInterval(a.ping);
  void a.room.disconnect().catch(() => {});
  for (const el of a.audios.values()) el.remove();
  a.audios.clear();
  a.releaseLock?.();
  sounds.ended(getPrefs().calls.volume);
  view({ phase: 'ended', reason });
  setTimeout(() => { if (cur === a) { cur = null; setGlobal({ groupCall: null, groupCallMin: false }); } }, 1500);
}

/** Провайдер ключей LiveKit: ключ на каждого отправителя (sharedKey: false), без авторатчета — ключи меняем эпохами. */
function makeKeyProvider(lk: LK): new () => SenderKeys {
  return class extends lk.BaseKeyProvider implements SenderKeys {
    constructor() { super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 10, keyringSize: KEYRING }); }
    async set(identity: string, raw: Uint8Array, index: number): Promise<void> {
      const material = await lk.createKeyMaterialFromBuffer(raw.slice().buffer as ArrayBuffer);
      this.onSetEncryptionKey(material, identity, index);
    }
  };
}

async function takeLock(name: string): Promise<(() => void) | null> {
  if (!navigator.locks) return () => {};
  return new Promise((resolve) => {
    void navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(null); return; }
      return new Promise<void>((done) => resolve(() => done()));
    });
  });
}

// dev-сборка: звонок для проверок из Playwright
declare const __DEV__: boolean;
if (typeof __DEV__ !== 'undefined' && __DEV__) (globalThis as { __relayGroupCall?: () => Active | null }).__relayGroupCall = () => cur;
