import type { GroupCallSummary, ProfilePhoto } from '@relay/protocol';
import { Avatar, Icon, peerTone, Presence, ripple } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  adminGroupAction, CALL_CHAT_MAX, CALL_REACTIONS, endGroupCallForAll, readCallChat, sendCallChat, sendCallReaction, setJoinMuted, groupTracks, joinGroupCall, leaveGroupCall, setGroupBackground, toggleGroupCam, toggleGroupHand, toggleGroupMic, toggleGroupScreen,
  type GroupCallView, type GroupMemberView, type GroupReaction,
} from '../../calls/groupCall';
import { callClock } from '../../calls/callText';
import { setGlobal, useGlobal } from '../../global';
import { avatarPhoto } from '../../profilePhoto';
import { useUser } from '../../settingsData';
import { chatTone } from '../format';
import { useNow } from './CallSlot';
import { openGroupPip, useAutoPip } from './CallPip';
import { pipKind } from '../../calls/pip';

/**
 * Групповой звонок (docs/plans/2026-11-07-relay-group-calls.md): экран с плитками и списком участников, плашка над
 * шапкой группы — «Идёт звонок · N · Присоединиться» или, если я в звонке и свернул его, мой звонок с микрофоном и
 * «Выйти». Появление — только opacity и transform; плашка — тем же механизмом, что у плеера (rl-playerslot).
 */

const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'участник' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'участника' : 'участников');

/** Слой поверх приложения: экран звонка (развёрнут) или плашка сверху, если чат не открыт. */
export function GroupCallLayer() {
  const gc = useGlobal((s) => s.groupCall);
  const min = useGlobal((s) => s.groupCallMin);
  useAutoPip(!!gc && (gc.phase === 'active' || gc.phase === 'reconnecting'), openGroupPip);
  const last = useRef<GroupCallView | null>(null);
  if (gc) last.current = gc;
  const v = gc ?? last.current;
  return <Presence show={!!gc && !min} exitMs={220}>{v ? <GroupCallScreen v={v} /> : null}</Presence>;
}

/** Над шапкой группы: звонок идёт — плашка «Присоединиться»; я в нём и свернул — мой звонок. */
export function GroupCallSlot({ chatId }: { chatId: number }) {
  const summary = useGlobal((s) => (s.chats.find((c) => c.id === chatId)?.groupCall as GroupCallSummary | null | undefined) ?? null);
  const gc = useGlobal((s) => s.groupCall);
  const min = useGlobal((s) => s.groupCallMin);
  const mine = !!gc && gc.chatId === chatId && gc.phase !== 'ended';
  const show = (mine && min) || (!!summary && !mine);
  const still = useRef(show);
  if (!show) still.current = false;
  const lastSummary = useRef(summary);
  if (summary) lastSummary.current = summary;
  return (
    <Presence show={show} exitMs={300}>
      <div class={'rl-playerslot app-callslot' + (still.current ? ' rl-playerslot-still' : '')}>
        <div class="rl-playerclip">
          {mine && gc ? <MyGroupPlate v={gc} /> : lastSummary.current ? <JoinPlate chatId={chatId} s={lastSummary.current} /> : null}
        </div>
      </div>
    </Presence>
  );
}

function JoinPlate({ chatId, s }: { chatId: number; s: GroupCallSummary }) {
  const now = useNow(true);
  return (
    <div class="app-callplate app-gcjoin" role="region" aria-label="Идёт звонок">
      <button type="button" class="app-callplate-center app-gcjoin-center" onClick={() => void joinGroupCall(chatId, s.callId)}>
        <span class="app-gcfaces">{s.faces.map((id) => <Face key={id} userId={id} size={22} />)}</span>
        <b>Идёт звонок</b>
        <span>{s.count ? `${s.count} ${plural(s.count)}` : 'пока никого'} · {callClock((now - s.startedAt) / 1000)}</span>
      </button>
      <button type="button" class="app-callplate-side app-gcjoin-btn" onClick={() => void joinGroupCall(chatId, s.callId)}>Войти</button>
    </div>
  );
}

function MyGroupPlate({ v }: { v: GroupCallView }) {
  const chat = useGlobal((s) => s.chats.find((c) => c.id === v.chatId));
  const state = v.phase === 'active' ? (v.mic ? 'is-talking' : 'is-muted') : 'is-connecting';
  return (
    <div class={'app-callplate ' + state} role="region" aria-label="Групповой звонок">
      <button type="button" class="app-callplate-side app-callplate-mic" aria-label={v.mic ? 'Выключить микрофон' : 'Включить микрофон'} onClick={() => void toggleGroupMic()}>
        <Icon name={v.mic ? 'micFilled' : 'micOff'} size={22} />
      </button>
      <button type="button" class="app-callplate-center" aria-label="Открыть звонок" onClick={() => setGlobal({ groupCallMin: false })}>
        <Avatar name={(chat?.title as string) || 'Группа'} tone={chatTone(chat)} size={30} {...avatarPhoto((chat?.photo as ProfilePhoto | null) ?? null)} />
        <b>{(chat?.title as string) || 'Группа'}</b>
        <span>{v.members.length} {plural(v.members.length)}</span>
      </button>
      <button type="button" class="app-callplate-side app-callplate-end" aria-label="Выйти из звонка" onClick={leaveGroupCall}>
        <Icon name="phoneDown" size={24} />
      </button>
    </div>
  );
}

function Face({ userId, size }: { userId: number; size: number }) {
  const u = useUser(userId);
  return <Avatar name={String(u?.name ?? '')} tone={peerTone(userId)} size={size} {...avatarPhoto((u?.photo as ProfilePhoto | null) ?? null)} />;
}

function GroupCallScreen({ v }: { v: GroupCallView }) {
  const chat = useGlobal((s) => s.chats.find((c) => c.id === v.chatId));
  const meId = useGlobal((s) => s.me?.userId ?? 0);
  const admin = !!(chat?.me as { admin?: { calls?: boolean } } | null)?.admin?.calls;
  const [list, setList] = useState(true);
  const [side, setSide] = useState<'list' | 'chat'>('list');   // правая панель: участники или чат звонка
  const [reacting, setReacting] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const bg = useGlobal((s) => s.prefs.calls.background);
  const title = (chat?.title as string) || 'Группа';
  const tiles = pinned ? v.members.filter((m) => m.identity === pinned) : v.members;
  const cols = tiles.length <= 1 ? 1 : tiles.length <= 4 ? 2 : 3;
  return (
    <div class={'app-call app-gcall' + (v.phase === 'ended' ? ' app-call-ended' : '')} role="dialog" aria-label="Групповой звонок" data-phase={v.phase}>
      <div class="app-call-top">
        <button type="button" class="app-call-icon" aria-label="Свернуть" onClick={() => setGlobal({ groupCallMin: true })}><Icon name="chevronDown" size={24} /></button>
        <div class="app-gcall-title">
          <b>{title}</b>
          <span>{v.phase === 'joining' ? 'Подключение…' : v.phase === 'reconnecting' ? 'Переподключение…' : v.phase === 'ended' ? 'Звонок завершён' : `${v.members.length} ${plural(v.members.length)}`}</span>
        </div>
        <div class="app-gcall-topright">
          {v.emoji ? <button type="button" class="app-call-emoji" aria-label="Ключ шифрования" onClick={() => setHint((x) => !x)}>{v.emoji.map((e, i) => <span key={i}>{e}</span>)}</button> : null}
          {pipKind() && v.phase !== 'ended' ? <button type="button" class="app-call-icon" aria-label="Картинка в картинке" onClick={() => void openGroupPip()}><Icon name="pip" size={22} /></button> : null}
          <button type="button" class="app-call-icon" aria-label={list ? 'Скрыть участников' : 'Показать участников'} onClick={() => setList((x) => !x)}><Icon name="users" size={22} /></button>
        </div>
      </div>
      {hint && v.emoji ? (
        <div class="app-call-hint" role="note">
          <div class="app-call-hint-emoji">{v.emoji.join(' ')}</div>
          <p>Сверьте эмодзи с кем-нибудь из участников: если у вас одинаковые, звонок защищён сквозным шифрованием — его не слышит никто, включая серверы Relay.</p>
          <p>Эмодзи меняются, когда кто-то входит или выходит.</p>
          <button type="button" class="app-call-hint-ok" onClick={() => setHint(false)}>Понятно</button>
        </div>
      ) : null}
      {v.phase === 'active' && (v.members.find((m) => m.me)?.net ?? 3) <= 1 ? <span class="app-call-note app-call-net app-gcall-badnet"><Icon name="signal" size={16} /> Плохое соединение</span> : null}
      <div class={'app-gcall-body' + (list ? ' with-list' : '')}>
        <div class="app-gcall-grid" style={{ '--cols': cols }}>
          {tiles.map((m) => <Tile key={m.identity} m={m} rev={v.rev} pinned={pinned === m.identity} reactions={v.reactions.filter((r) => r.identity === m.identity)} onPin={() => setPinned((p) => (p === m.identity ? null : m.identity))} />)}
        </div>
        {list && side === 'chat' ? <CallChat v={v} /> : list ? (
          <div class="app-gcall-list" aria-label="Участники">
            {admin ? (
              <label class="app-gcall-setting">
                <input type="checkbox" checked={v.joinMuted} onChange={(e) => void setJoinMuted((e.target as HTMLInputElement).checked)} />
                <span>Новые участники — без микрофона</span>
              </label>
            ) : null}
            {[...v.members].sort((a, b) => (b.hand ?? 0) - (a.hand ?? 0)).map((m) => <Row key={m.identity} m={m} admin={admin && m.userId !== meId} />)}
          </div>
        ) : null}
      </div>
      {reacting ? (
        <div class="app-gcall-reactbar" role="toolbar" aria-label="Реакции">
          {CALL_REACTIONS.map((e) => <button key={e} type="button" aria-label={'Реакция ' + e} onClick={() => void sendCallReaction(e)}>{e}</button>)}
        </div>
      ) : null}
      <div class="app-call-controls">
        {v.cam ? <Btn icon="blur" label={bg === 'blur' ? 'Обычный фон' : 'Размыть фон'} on={bg === 'blur'} onClick={() => void setGroupBackground(bg === 'blur' ? 'none' : 'blur')} /> : null}
        <Btn icon={v.cam ? 'video' : 'videoOff'} label={v.cam ? 'Камера' : 'Камера выкл.'} on={v.cam} onClick={() => void toggleGroupCam()} />
        <Btn icon={v.mic ? 'mic' : 'micOff'} label={v.mutedByAdmin && !v.mic ? 'Выключен админом' : v.mic ? 'Микрофон' : 'Микрофон выкл.'} on={v.mic} onClick={() => void toggleGroupMic()} />
        {typeof navigator !== 'undefined' && navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices
          ? <Btn icon="screen" label={v.screen ? 'Остановить показ' : 'Экран'} on={v.screen} onClick={() => void toggleGroupScreen()} /> : null}
        <Btn icon="raiseHand" label={v.hand ? 'Опустить руку' : 'Поднять руку'} on={v.hand} onClick={toggleGroupHand} />
        <Btn icon="smile" label="Реакция" on={reacting} onClick={() => setReacting((x) => !x)} />
        <Btn icon="chats" label="Чат" on={list && side === 'chat'} badge={v.chatUnread} onClick={() => { const open = !(list && side === 'chat'); setSide(open ? 'chat' : 'list'); if (open) { setList(true); readCallChat(); } }} />
        <Btn icon="phoneDown" label="Выйти" danger onClick={leaveGroupCall} />
        {admin || v.startedBy === meId ? <Btn icon="close" label="Завершить для всех" danger onClick={() => void endGroupCallForAll()} /> : null}
      </div>
    </div>
  );
}

function Btn({ icon, label, onClick, on, danger, badge }: { icon: string; label: string; onClick: () => void; on?: boolean; danger?: boolean; badge?: number }) {
  return (
    <div class="app-call-btn">
      <button type="button" class={'app-call-round' + (danger ? ' is-danger' : on === false ? ' is-off' : '')} aria-label={badge ? `${label}, новых: ${badge}` : label} aria-pressed={on} onPointerDown={ripple} onClick={onClick}>
        <Icon name={icon} size={26} />
        {badge ? <span class="app-call-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span> : null}
      </button>
      <span>{label}</span>
    </div>
  );
}

/** Плитка: видео (экран — главнее камеры) или аватар; говорящий — с рамкой. */
function Tile({ m, rev, pinned, onPin, reactions }: { m: GroupMemberView; rev: number; pinned: boolean; onPin: () => void; reactions: GroupReaction[] }) {
  const u = useUser(m.userId);
  const meName = useGlobal((s) => s.me?.name ?? '');
  const real = m.me ? meName : String(u?.name ?? '');   // аватар — по настоящему имени, подпись у своей плитки — «Вы»
  const name = m.me ? 'Вы' : real;
  const ref = useRef<HTMLVideoElement>(null);
  const [hasVideo, setHasVideo] = useState(false);
  useEffect(() => {
    const t = groupTracks(m.identity);
    const track = t.screen ?? t.camera;
    const el = ref.current;
    setHasVideo(!!track);
    if (!el) return;
    const cur = (el.srcObject as MediaStream | null)?.getVideoTracks()[0];
    if (track && cur !== track) el.srcObject = new MediaStream([track]);
    if (!track) el.srcObject = null;
  }, [rev, m.identity, m.video, m.screen]);
  return (
    <button type="button" class={'app-gtile' + (m.speaking ? ' is-speaking' : '') + (hasVideo ? ' has-video' : '') + (pinned ? ' is-pinned' : '')} onClick={onPin} aria-label={name + (pinned ? ' — открепить' : ' — на весь экран')}>
      <video ref={ref} autoplay playsInline muted class={m.me && !m.screen ? 'is-mirror' : ''} />
      {hasVideo ? null : <Avatar name={real} tone={peerTone(m.userId)} size={88} {...avatarPhoto((u?.photo as ProfilePhoto | null) ?? null)} />}
      {reactions.length ? <span class="app-gtile-reacts" aria-live="polite">{reactions.map((r) => <span key={r.id} class="app-gtile-react">{r.emoji}</span>)}</span> : null}
      <span class="app-gtile-name">{m.net <= 1 ? <Icon name="signal" size={14} class="app-gtile-net" title="Слабый сигнал" /> : null}{m.muted ? <Icon name="micOff" size={14} /> : null}{m.hand ? <Icon name="raiseHand" size={14} /> : null}{name}</span>
    </button>
  );
}

function Row({ m, admin }: { m: GroupMemberView; admin: boolean }) {
  const u = useUser(m.userId);
  const meName = useGlobal((s) => s.me?.name ?? '');
  const real = m.me ? meName : String(u?.name ?? '');
  const name = m.me ? 'Вы' : real;
  const status = m.hand ? 'хочет сказать' : m.mutedByAdmin ? 'микрофон выключен админом' : m.muted ? 'микрофон выключен' : m.speaking ? 'говорит' : 'слушает';
  return (
    <div class={'app-gcall-row' + (m.speaking ? ' is-speaking' : '')}>
      <Avatar name={real} tone={peerTone(m.userId)} size={40} {...avatarPhoto((u?.photo as ProfilePhoto | null) ?? null)} />
      <span class="app-gcall-row-text"><b>{name}</b><span>{status}</span></span>
      <Icon name={m.hand ? 'raiseHand' : m.muted ? 'micOff' : 'mic'} size={20} />
      {admin ? (
        <span class="app-gcall-row-admin">
          {!m.mutedByAdmin ? <button type="button" aria-label={`Выключить микрофон: ${name}`} onClick={() => void adminGroupAction('mute', m.userId)}><Icon name="micOff" size={18} /></button>
            : <button type="button" aria-label={`Разрешить говорить: ${name}`} onClick={() => void adminGroupAction('allow', m.userId)}><Icon name="mic" size={18} /></button>}
          <button type="button" aria-label={`Удалить из звонка: ${name}`} onClick={() => void adminGroupAction('kick', m.userId)}><Icon name="userX" size={18} /></button>
        </span>
      ) : null}
    </div>
  );
}

/** Чат звонка: только пока идёт звонок, у вошедших позже прошлого нет; шифр — ключом отправителя (как кадры). */
function CallChat({ v }: { v: GroupCallView }) {
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { readCallChat(); const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [v.chat.length]);
  const submit = async (e: Event) => {
    e.preventDefault();
    const value = (box.current?.parentElement?.querySelector('input') as HTMLInputElement | null)?.value ?? text;   // Enter раньше перерисовки — берём из поля
    if (await sendCallChat(value)) setText('');
  };
  return (
    <div class="app-gcall-chat" aria-label="Чат звонка">
      <p class="app-gcall-chat-note">Сообщения видят только участники и только пока идёт звонок.</p>
      <div class="app-gcall-chat-list" ref={box} role="log">
        {v.chat.map((l) => <ChatLine key={l.id} l={l} />)}
      </div>
      <form class="app-gcall-chat-form" onSubmit={(e) => void submit(e)}>
        <input type="text" value={text} maxLength={CALL_CHAT_MAX} placeholder="Сообщение" aria-label="Сообщение в чат звонка" onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.isComposing) void submit(e); }} />
        <button type="submit" aria-label="Отправить" disabled={!text.trim()}><Icon name="send" size={20} /></button>
      </form>
    </div>
  );
}

function ChatLine({ l }: { l: GroupCallView['chat'][number] }) {
  const u = useUser(l.me ? null : l.userId);
  return (
    <div class={'app-gcall-line' + (l.me ? ' is-me' : '')}>
      {l.me ? null : <b>{String(u?.name ?? '')}</b>}
      <span>{l.text}</span>
    </div>
  );
}
