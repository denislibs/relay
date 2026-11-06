import type { ProfilePhoto } from '@relay/protocol';
import { Avatar, Icon, Presence } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { hangup, toggleMic, type CallView } from '../../calls/callController';
import { callStatus } from '../../calls/callText';
import { setGlobal, useGlobal } from '../../global';
import { avatarPhoto } from '../../profilePhoto';
import { chatTone } from '../format';

/**
 * Свёрнутый звонок — плашка над шапкой чата (как в Telegram Web): шапка плавно уезжает вниз, ничего не перекрыто.
 * Слева микрофон, в середине — собеседник и время на градиенте (цвет — по состоянию: говорю / микрофон выключен /
 * соединение), справа — «Завершить». Нажатие на середину разворачивает звонок. Механика появления — та же, что у
 * плеера (rl-playerslot): высота раскрывается, плашка съезжает сверху; уже показанная при смене чата — без выезда.
 */
export function CallSlot() {
  const call = useGlobal((s) => s.call);
  const min = useGlobal((s) => s.callMin);
  const show = !!call && min && call.phase !== 'incoming' && call.phase !== 'ended';
  const last = useRef<CallView | null>(null);
  if (call) last.current = call;
  const still = useRef(show);   // смонтировались с уже свёрнутым звонком (сменили чат) — без выезда
  if (!show) still.current = false;
  const v = last.current;
  return (
    <Presence show={show} exitMs={300}>
      {v ? (
        <div class={'rl-playerslot app-callslot' + (still.current ? ' rl-playerslot-still' : '')}>
          <div class="rl-playerclip"><CallPlate v={v} /></div>
        </div>
      ) : null}
    </Presence>
  );
}

/** Секундомер: раз в секунду, только пока идёт разговор. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function CallPlate({ v, floating = false }: { v: CallView; floating?: boolean }) {
  const chat = useGlobal((s) => s.chats.find((c) => c.id === v.chatId));
  const name = (chat?.title as string) || 'Собеседник';
  const now = useNow(v.phase === 'active');
  const state = v.phase === 'active' ? (v.mic ? 'is-talking' : 'is-muted') : 'is-connecting';
  return (
    <div class={'app-callplate ' + state + (floating ? ' app-callplate-float' : '')} role="region" aria-label="Звонок">
      <button type="button" class="app-callplate-side app-callplate-mic" aria-label={v.mic ? 'Выключить микрофон' : 'Включить микрофон'} onClick={toggleMic}>
        <Icon name={v.mic ? 'micFilled' : 'micOff'} size={22} />
      </button>
      <button type="button" class="app-callplate-center" aria-label="Открыть звонок" onClick={() => setGlobal({ callMin: false })}>
        <Avatar name={name} tone={chatTone(chat)} size={30} {...avatarPhoto((chat?.photo as ProfilePhoto | null) ?? null)} />
        <b>{name}</b>
        <span aria-live={v.phase === 'active' ? 'off' : 'polite'}>{callStatus(v, now)}</span>
      </button>
      <button type="button" class="app-callplate-side app-callplate-end" aria-label="Завершить" onClick={hangup}>
        <Icon name="phoneDown" size={24} />
      </button>
    </div>
  );
}
