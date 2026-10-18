import { requestMutation } from '@relay/ui';
import { useLayoutEffect, useState } from 'preact/hooks';
import { activeFrame, useGlobal } from '../global';
import { Chat } from './Chat';

/*
 * Стек чатов, как в Telegram Web: каждая колонка — свой чат (шапка, лента, композер), все лежат рядом.
 * На экране — верхний готовый; ниже него — уехавшие влево, выше (готовится или уходит) — справа.
 * Смена — CSS-переходом класса: новая колонка уже отрисована (лента встала на позицию до показа).
 */
export function ChatStack() {
  const stack = useGlobal((s) => s.chatStack);
  const leaving = useGlobal((s) => s.chatLeaving);
  const current = useGlobal((s) => activeFrame(s)?.key ?? null);
  const at = stack.findIndex((f) => f.key === current);
  return (
    <div class="app-chats">
      {stack.map((f, i) => <ChatColumn key={f.key} frame={f.key} chatId={f.chatId} place={i < at ? 'below' : i === at ? 'on' : 'above'} instant={!!f.instant} />)}
      {leaving.map((f) => <ChatColumn key={f.key} frame={f.key} chatId={f.chatId} place="above" instant={false} />)}
    </div>
  );
}

function ChatColumn({ frame, chatId, place, instant }: { frame: string; chatId: number; place: 'below' | 'on' | 'above'; instant: boolean }) {
  // первый кадр колонки — на исходной позиции, иначе переход не с чего начинать; нижний чат встаёт сразу
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    const r = requestAnimationFrame(() => requestMutation(() => setEntered(true)));
    return () => cancelAnimationFrame(r);
  }, []);
  const on = place === 'on' && (entered || instant);
  const cls = 'app-chatcol app-chatcol-' + (on ? 'on' : place === 'on' ? 'above' : place) + (instant && !entered ? ' app-chatcol-instant' : '');
  const hidden = on ? {} : { 'aria-hidden': true, inert: true };
  return (
    <div class={cls} data-current={on ? '' : undefined} {...hidden}>
      <Chat frameKey={frame} chatId={chatId} active={on} />
    </div>
  );
}
