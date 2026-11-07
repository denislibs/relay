import { Avatar, Icon, Presence, ripple } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { acceptCall, callStreams, declineCall, hangup, setCallBackground, toggleCam, toggleMic, type CallView } from '../../calls/callController';
import { callStatus } from '../../calls/callText';
import { setGlobal, useGlobal } from '../../global';
import { CallPlate, useNow, usePeer } from './CallSlot';
import { openCallPip, useAutoPip } from './CallPip';
import { pipKind } from '../../calls/pip';

/**
 * Звонок поверх приложения (docs/plans/2026-11-06-relay-calls.md): входящий — карточкой, разговор — экраном
 * с видео и кнопками, свёрнутый — полоской сверху (чаты остаются доступны). Появление и уход — только opacity и
 * transform (Presence), экран собирается один раз и живёт до конца звонка.
 */
export function CallLayer() {
  const call = useGlobal((s) => s.call);
  const min = useGlobal((s) => s.callMin);
  const chatOpen = useGlobal((s) => s.openChatId != null);
  // и свёрнутый звонок: уход с вкладки открывает PiP (слой смонтирован всегда, экран звонка — нет)
  useAutoPip(!!call && call.phase !== 'incoming' && call.phase !== 'ended' && call.phase !== 'requesting', openCallPip);
  const last = useRef<CallView | null>(null);
  if (call) last.current = call;
  const v = call ?? last.current;
  // свёрнут: плашка над шапкой открытого чата (CallSlot в Chat); чата нет — та же плашка сверху средней колонки
  const floating = !!call && min && !chatOpen && call.phase !== 'incoming' && call.phase !== 'ended';
  return (
    <>
      <Presence show={!!call && (!min || call.phase === 'incoming')} exitMs={220}>{v ? <CallScreen v={v} onMin={() => setGlobal({ callMin: true })} /> : null}</Presence>
      <Presence show={floating} exitMs={180}>{v ? <div class="app-callfloat"><CallPlate v={v} floating /></div> : null}</Presence>
    </>
  );
}


function CallScreen({ v, onMin }: { v: CallView; onMin: () => void }) {
  const peer = usePeer(v);
  const now = useNow(v.phase === 'active');
  const bg = useGlobal((s) => s.prefs.calls.background);
  const remoteVideo = useRef<HTMLVideoElement>(null), localVideo = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const { local, remote } = callStreams();
    if (remoteVideo.current && remoteVideo.current.srcObject !== remote) remoteVideo.current.srcObject = remote;
    if (localVideo.current && localVideo.current.srcObject !== local) localVideo.current.srcObject = local;
  }, [v.rev, v.callId]);
  const incoming = v.phase === 'incoming';
  const ended = v.phase === 'ended';
  const showRemote = v.peerCam && !v.inPaused && (v.phase === 'active' || v.phase === 'reconnecting');
  const live = v.phase === 'active';
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
        {!incoming && !ended && pipKind() ? <button type="button" class="app-call-icon" aria-label="Картинка в картинке" onClick={() => void openCallPip()}><Icon name="pip" size={22} /></button> : <span />}
      </div>
      {emojiHint && v.emoji ? (
        <div class="app-call-hint" role="note">
          <div class="app-call-hint-emoji">{v.emoji.join(' ')}</div>
          <p>Сверьте их с собеседником: если у него такие же, звонок защищён сквозным шифрованием и его не может прослушать никто, включая сервер Relay.</p>
          {v.relay ? <p>Звонок идёт через сервер-посредник — ваш IP-адрес собеседнику не виден.</p> : null}
          <button type="button" class="app-call-hint-ok" onClick={() => setEmojiHint(false)}>Понятно</button>
        </div>
      ) : null}
      <div class={'app-call-who' + (showRemote ? ' app-call-who-small' : '')}>
        <Avatar name={peer.name} tone={peer.tone} size={showRemote ? 48 : 120} {...peer.photo} />
        <b>{peer.name}</b>
        <span class="app-call-status" aria-live="polite">{callStatus(v, now)}</span>
        {!v.peerMic && live ? <span class="app-call-note"><Icon name="micOff" size={16} /> {peer.name}: микрофон выключен</span> : null}
        {live && v.inPaused ? <span class="app-call-note app-call-net"><Icon name="signal" size={16} /> Видео приостановлено из-за слабой связи</span>
          : live && v.net <= 1 ? <span class="app-call-note app-call-net"><Icon name="signal" size={16} /> Плохое соединение</span>
          : live && v.peerNet <= 1 ? <span class="app-call-note app-call-net"><Icon name="signal" size={16} /> Слабый сигнал у собеседника</span> : null}
        {live && v.outPaused ? <span class="app-call-note"><Icon name="videoOff" size={16} /> Ваше видео на паузе: у собеседника слабая связь</span> : null}
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
            {v.cam ? <CallButton icon="blur" label={bg === 'blur' ? 'Обычный фон' : 'Размыть фон'} on={bg === 'blur'} disabled={ended} onClick={() => void setCallBackground(bg === 'blur' ? 'none' : 'blur')} /> : null}
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
