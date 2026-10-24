import { requestMutation } from '@relay/ui';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
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
  // Один массив с ключами: снятый со стека чат переходит в «уходящие» тем же узлом на том же месте. Два отдельных
  // .map — два разных списка для Preact: колонка размонтировалась бы и собралась заново (вся лента) в начале «Назад»
  const cols = [
    ...stack.map((f, i) => ({ f, place: (i < at ? 'below' : i === at ? 'on' : 'above') as Place, instant: !!f.instant, pending: !f.ready })),
    ...leaving.map((f) => ({ f, place: 'above' as Place, instant: false, pending: false })),
  ];
  return (
    <div class="app-chats">
      {cols.map(({ f, place, instant, pending }) => <ChatColumn key={f.key} frame={f.key} chatId={f.chatId} threadId={f.threadId} place={place} instant={instant} pending={pending} />)}
    </div>
  );
}

type Place = 'below' | 'on' | 'above';

function ChatColumn({ frame, chatId, threadId, place, instant, pending }: { frame: string; chatId: number; threadId?: number; place: Place; instant: boolean; pending: boolean }) {
  // первый кадр колонки — на исходной позиции, иначе переход не с чего начинать; нижний чат встаёт сразу.
  // Колонка, смонтированная справа (готовится поверх), уже стоит на исходной — ей ждать нечего: иначе она
  // въезжала позже, чем уезжал нижний чат (ожидание кадра + длинный рендер переключения ≈ 70 мс рассинхрона)
  const [entered, setEntered] = useState(place !== 'on');
  useLayoutEffect(() => {
    const r = requestAnimationFrame(() => requestMutation(() => setEntered(true)));
    return () => cancelAnimationFrame(r);
  }, []);
  const on = place === 'on' && (entered || instant);
  const pos = on ? 'on' : place === 'on' ? 'above' : place;
  // слой заранее (will-change): у готовящейся колонки — до переключения; у сдвинувшейся — на время перехода,
  // потом снимаем: постоянный слой на весь экран у каждой колонки — лишняя память видеокарты
  const box = useRef<HTMLDivElement>(null);
  const prev = useRef(pos);
  useLayoutEffect(() => {
    if (prev.current === pos) return;
    prev.current = pos;
    const el = box.current;
    if (!el) return;
    el.classList.add('app-chatcol-moving');
    const t = setTimeout(() => requestMutation(() => el.classList.remove('app-chatcol-moving')), 320);
    return () => clearTimeout(t);
  }, [pos]);
  const cls = 'app-chatcol app-chatcol-' + pos + (instant && !entered ? ' app-chatcol-instant' : '') + (pending ? ' app-chatcol-moving' : '');
  const hidden = on ? {} : { 'aria-hidden': true, inert: true };
  return (
    <div ref={box} class={cls} data-current={on ? '' : undefined} {...hidden}>
      <Chat frameKey={frame} chatId={chatId} threadId={threadId} active={on} />
    </div>
  );
}
