import type { ProfilePhoto } from '@relay/protocol';
import { Avatar, Icon, Presence, ripple } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { acceptCall, callStreams, declineCall, hangup, toggleCam, toggleMic, type CallView } from '../../calls/callController';
import { callStatus } from '../../calls/callText';
import { useGlobal } from '../../global';
import { avatarPhoto } from '../../profilePhoto';
import { chatTone } from '../format';

/**
 * Звонок поверх приложения (docs/plans/2026-11-06-relay-calls.md): входящий — карточкой, разговор — экраном
 * с видео и кнопками, свёрнутый — полоской сверху (чаты остаются доступны). Появление и уход — только opacity и
 * transform (Presence), экран собирается один раз и живёт до конца звонка.
 */
export function CallLayer() {
  const call = useGlobal((s) => s.call);
  const last = useRef<CallView | null>(null);
  if (call) last.current = call;
  const v = call ?? last.current;
  const [min, setMin] = useState(false);
  useEffect(() => { if (!call) setMin(false); }, [!!call]);
  useEffect(() => { if (call?.phase === 'incoming') setMin(false); }, [call?.phase]);
  return (
    <>
      <Presence show={!!call && !min} exitMs={220}>{v ? <CallScreen v={v} onMin={() => setMin(true)} /> : null}</Presence>
      <Presence show={!!call && min} exitMs={180}>{v ? <CallBar v={v} onOpen={() => setMin(false)} /> : null}</Presence>
    </>
  );
}

function usePeer(v: CallView) {
  const chat = useGlobal((s) => s.chats.find((c) => c.id === v.chatId));
  return { name: (chat?.title as string) || 'Собеседник', tone: chatTone(chat), photo: avatarPhoto((chat?.photo as ProfilePhoto | null) ?? null) };
}

/** Секундомер: перерисовка раз в секунду только во время разговора. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function CallScreen({ v, onMin }: { v: CallView; onMin: () => void }) {
  const peer = usePeer(v);
  const now = useNow(v.phase === 'active');
  const remoteVideo = useRef<HTMLVideoElement>(null), localVideo = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const { local, remote } = callStreams();
    if (remoteVideo.current && remoteVideo.current.srcObject !== remote) remoteVideo.current.srcObject = remote;
    if (localVideo.current && localVideo.current.srcObject !== local) localVideo.current.srcObject = local;
  }, [v.rev, v.callId]);
  const incoming = v.phase === 'incoming';
  const ended = v.phase === 'ended';
  const showRemote = v.peerCam && (v.phase === 'active' || v.phase === 'reconnecting');
  const [emojiHint, setEmojiHint] = useState(false);
  return (
    <div class={'app-call' + (showRemote ? ' app-call-video' : '') + (ended ? ' app-call-ended' : '')} role="dialog" aria-label={incoming ? 'Входящий звонок' : 'Звонок'} data-phase={v.phase}>
      <video ref={remoteVideo} class="app-call-remote" autoplay playsInline muted aria-hidden="true" />
      <div class="app-call-top">
        {incoming ? <span /> : <button type="button" class="app-call-icon" aria-label="Свернуть" onClick={onMin}><Icon name="chevronDown" size={24} /></button>}
        {v.emoji ? (
          <button type="button" class="app-call-emoji" aria-label="Ключ шифрования" onClick={() => setEmojiHint((x) => !x)}>
            {v.emoji.map((e, i) => <span key={i}>{e}</span>)}
          </button>
        ) : <span />}
        <span />
      </div>
      {emojiHint && v.emoji ? (
        <div class="app-call-hint" role="note">
          <div class="app-call-hint-emoji">{v.emoji.join(' ')}</div>
          <p>Если у {peer.name} такие же эмодзи, звонок защищён сквозным шифрованием: его не может прослушать никто, включая сервер Relay.</p>
          {v.relay ? <p>Звонок идёт через сервер-посредник — ваш IP-адрес собеседнику не виден.</p> : null}
          <button type="button" class="app-call-hint-ok" onClick={() => setEmojiHint(false)}>Понятно</button>
        </div>
      ) : null}
      <div class={'app-call-who' + (showRemote ? ' app-call-who-small' : '')}>
        <Avatar name={peer.name} tone={peer.tone} size={showRemote ? 48 : 120} {...peer.photo} />
        <b>{peer.name}</b>
        <span class="app-call-status" aria-live="polite">{callStatus(v, now)}</span>
        {!v.peerMic && v.phase === 'active' ? <span class="app-call-note"><Icon name="micOff" size={16} /> У {peer.name} выключен микрофон</span> : null}
      </div>
      <video ref={localVideo} class={'app-call-local' + (v.cam && !incoming ? ' is-on' : '')} autoplay playsInline muted aria-hidden="true" />
      <div class="app-call-controls">
        {incoming ? (
          <>
            <CallButton icon="phoneDown" label="Отклонить" danger onClick={declineCall} />
            {v.video ? <CallButton icon="phone" label="Голосом" onClick={() => void acceptCall(false)} /> : null}
            <CallButton icon={v.video ? 'video' : 'phone'} label="Принять" accept onClick={() => void acceptCall(v.video)} />
          </>
        ) : (
          <>
            <CallButton icon={v.cam ? 'video' : 'videoOff'} label={v.cam ? 'Выключить камеру' : 'Включить камеру'} on={v.cam} disabled={ended} onClick={() => void toggleCam()} />
            <CallButton icon={v.mic ? 'mic' : 'micOff'} label={v.mic ? 'Выключить микрофон' : 'Включить микрофон'} on={v.mic} disabled={ended} onClick={toggleMic} />
            <CallButton icon="phoneDown" label="Завершить" danger disabled={ended} onClick={hangup} />
          </>
        )}
      </div>
    </div>
  );
}

function CallButton({ icon, label, onClick, danger, accept, on, disabled }: { icon: string; label: string; onClick: () => void; danger?: boolean; accept?: boolean; on?: boolean; disabled?: boolean }) {
  return (
    <div class="app-call-btn">
      <button type="button" class={'app-call-round' + (danger ? ' is-danger' : accept ? ' is-accept' : on === false ? ' is-off' : '')} aria-label={label} disabled={disabled} onPointerDown={ripple} onClick={onClick}>
        <Icon name={icon} size={28} />
      </button>
      <span>{label}</span>
    </div>
  );
}

/** Свёрнутый звонок: полоска сверху — имя, время, микрофон, завершить; нажатие — развернуть. */
function CallBar({ v, onOpen }: { v: CallView; onOpen: () => void }) {
  const peer = usePeer(v);
  const now = useNow(v.phase === 'active');
  return (
    <div class="app-callbar" role="region" aria-label="Звонок">
      <button type="button" class="app-callbar-open" onClick={onOpen}>
        <Icon name="phone" size={18} /><b>{peer.name}</b><span>{callStatus(v, now)}</span>
      </button>
      <button type="button" class="app-callbar-btn" aria-label={v.mic ? 'Выключить микрофон' : 'Включить микрофон'} onClick={toggleMic}><Icon name={v.mic ? 'mic' : 'micOff'} size={20} /></button>
      <button type="button" class="app-callbar-btn is-danger" aria-label="Завершить" onClick={hangup}><Icon name="phoneDown" size={20} /></button>
    </div>
  );
}
