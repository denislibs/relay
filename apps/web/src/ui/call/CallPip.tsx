import { Avatar, Icon, peerTone } from '@relay/ui';
import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { callStreams, hangup, toggleMic, type CallView } from '../../calls/callController';
import { callStatus } from '../../calls/callText';
import { groupTracks, leaveGroupCall, toggleGroupMic, type GroupCallView } from '../../calls/groupCall';
import { autoPip, closePip, openPip, pipOpen } from '../../calls/pip';
import { useGlobal } from '../../global';
import { useUser } from '../../settingsData';
import { useNow, usePeer } from './CallSlot';

/**
 * Окно «картинка в картинке» звонка (calls/pip.ts): видео собеседника (в группе — того, кто говорит, или первого с
 * видео), имя и время, «Микрофон» и «Завершить». Рисуется в окне PiP тем же Preact и тем же состоянием, что и страница.
 */

/** Свой MediaStream на окно: один и тот же поток в двух документах (страница и PiP) второй не показывает. */
function Video({ track }: { track: MediaStreamTrack | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cur = (el.srcObject as MediaStream | null)?.getVideoTracks()[0] ?? null;
    if (cur !== track) el.srcObject = track ? new MediaStream([track]) : null;
  }, [track]);
  return <video ref={ref} class="app-pip-video" autoplay playsInline muted />;
}

function PipButtons({ mic, onMic, onEnd, endLabel }: { mic: boolean; onMic: () => void; onEnd: () => void; endLabel: string }) {
  return (
    <div class="app-pip-controls">
      <button type="button" class={'app-pip-btn' + (mic ? '' : ' is-off')} aria-label={mic ? 'Выключить микрофон' : 'Включить микрофон'} onClick={onMic}><Icon name={mic ? 'mic' : 'micOff'} size={22} /></button>
      <button type="button" class="app-pip-btn is-danger" aria-label={endLabel} onClick={onEnd}><Icon name="phoneDown" size={22} /></button>
    </div>
  );
}

function DirectPip() {
  const v = useGlobal((s) => s.call) as CallView | null;
  const now = useNow(v?.phase === 'active');
  useEffect(() => { if (!v || v.phase === 'ended') closePip(); }, [v?.phase, !v]);
  if (!v) return null;
  return <DirectPipBody v={v} now={now} />;
}
function DirectPipBody({ v, now }: { v: CallView; now: number }) {
  const peer = usePeer(v);
  const video = v.peerCam && (v.phase === 'active' || v.phase === 'reconnecting');
  return (
    <div class={'app-pip-call' + (video ? ' has-video' : '')} data-phase={v.phase}>
      {video ? <Video track={callStreams().remote?.getVideoTracks()[0] ?? null} key={v.rev} /> : <Avatar name={peer.name} tone={peer.tone} size={72} {...peer.photo} />}
      <div class="app-pip-who"><b>{peer.name}</b><span>{callStatus(v, now)}</span></div>
      <PipButtons mic={v.mic} onMic={toggleMic} onEnd={hangup} endLabel="Завершить" />
    </div>
  );
}

function GroupPip() {
  const v = useGlobal((s) => s.groupCall) as GroupCallView | null;
  useEffect(() => { if (!v || v.phase === 'ended') closePip(); }, [v?.phase, !v]);
  if (!v) return null;
  const others = v.members.filter((m) => !m.me);
  const withVideo = (m: (typeof others)[number]) => { const t = groupTracks(m.identity); return t.screen ?? t.camera; };
  const main = others.find((m) => m.speaking && withVideo(m)) ?? others.find((m) => withVideo(m)) ?? others.find((m) => m.speaking) ?? others[0] ?? null;
  return <GroupPipBody v={v} main={main} track={main ? withVideo(main) : null} />;
}
function GroupPipBody({ v, main, track }: { v: GroupCallView; main: GroupCallView['members'][number] | null; track: MediaStreamTrack | null }) {
  const u = useUser(main?.userId ?? null);
  const name = String(u?.name ?? '') || 'Звонок';
  return (
    <div class={'app-pip-call' + (track ? ' has-video' : '')} data-phase={v.phase}>
      {track ? <Video track={track} key={v.rev} /> : <Avatar name={name} tone={peerTone(main?.userId ?? 0)} size={72} />}
      <div class="app-pip-who"><b>{main ? name : 'Вы одни'}</b><span>{v.members.length} в звонке</span></div>
      <PipButtons mic={v.mic} onMic={() => void toggleGroupMic()} onEnd={leaveGroupCall} endLabel="Выйти" />
    </div>
  );
}

const mountInto = (C: () => preact.JSX.Element | null) => (root: HTMLElement) => { render(<C />, root); return () => render(null, root); };

/** Кнопка в звонке и автоматический PiP: окно звонка 1:1 (или обычный PiP видео собеседника). */
export const openCallPip = () => openPip(mountInto(DirectPip), () => document.querySelector<HTMLVideoElement>('.app-call-remote')).catch((e) => { console.warn('pip:', e); return false; });
export const openGroupPip = () => openPip(mountInto(GroupPip), () => document.querySelector<HTMLVideoElement>('.app-gtile.has-video video')).catch((e) => { console.warn('pip:', e); return false; });

/** Пока идёт звонок, уход с вкладки открывает PiP сам; конец звонка — окно закрыть, обработчик снять. */
export function useAutoPip(active: boolean, open: () => Promise<boolean>): void {
  useEffect(() => {
    if (!active) return;
    autoPip(() => { if (!pipOpen()) void open(); });
    return () => { autoPip(null); closePip(); };
  }, [active]);
}
