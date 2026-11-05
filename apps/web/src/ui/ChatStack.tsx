import { requestMutation } from '@relay/ui';
import { useChatThemeStyle } from '../chatTheme';
import { memo } from 'preact/compat';
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
    ...stack.map((f, i) => ({ f, place: (i < at ? 'below' : i === at ? 'on' : 'above') as Place, instant: !!f.instant, pending: !f.ready || !!f.wake })),
    ...leaving.map((f) => ({ f, place: 'above' as Place, instant: false, pending: !!f.wake })),
  ];
  // Порядок узлов — по созданию кадра (ключ c<N>), а не по месту в стеке: колонка, переехавшая из стека в
  // припаркованные (смена чата из списка) или обратно, иначе переставлялась в DOM, а перестановка узла сбрасывает
  // прокрутку его ленты в 0 — вернувшийся чат вставал не там и сдвигал окно. Кто кого перекрывает, решают классы
  // (z-index у верхней и уходящей), а новее созданная и так позже
  cols.sort((a, b) => seq(a.f.key) - seq(b.f.key));
  return (
    <div class="app-chats">
      {cols.map(({ f, place, instant, pending }) => <ChatColumn key={f.key} frame={f.key} chatId={f.chatId} threadId={f.threadId} scheduled={f.scheduled} savedPeer={f.savedPeer} place={place} instant={instant} pending={pending} swap={!!f.swap} />)}
    </div>
  );
}

type Place = 'below' | 'on' | 'above';
const seq = (key: string) => Number(key.slice(1)) || 0;
const COVER_MS = 400;   // переход 250 мс + запас: накрываем, когда колонка уже не видна

/** Доиграть до конца конечные CSS-анимации внутри колонки (переходы и бесконечные — спиннер, «печатает…» — не трогаем). */
export function finishEntrances(el: Element): void {
  for (const a of el.getAnimations({ subtree: true })) {
    if (a instanceof CSSAnimation && a.effect?.getComputedTiming().iterations !== Infinity) a.finish();
  }
}

// memo: смена стека перерисовывает ChatStack, а рендер колонки — это рендер всего чата. Без memo каждая колонка
// (и нижние, и припаркованные) рендерилась заново на каждом «Назад» и открытии; пропсы — примитивы
const ChatColumn = memo(function ChatColumn({ frame, chatId, threadId, scheduled, savedPeer, place, instant, pending, swap }: { frame: string; chatId: number; threadId?: number; scheduled?: boolean; savedPeer?: string; place: Place; instant: boolean; pending: boolean; swap: boolean }) {
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
    // подмена: колонка собиралась скрытой, и анимации появления (закреп, реакции, текст закрепа) начались там —
    // показ застал бы их на середине: закреп полупрозрачным, лента просвечивает. Чат встаёт целиком, как шапка
    if (swap && pos === 'on') finishEntrances(el);
    el.classList.add('app-chatcol-moving');
    const t = setTimeout(() => requestMutation(() => el.classList.remove('app-chatcol-moving')), 320);
    return () => clearTimeout(t);
  }, [pos]);
  // Как в Telegram Web K (is-covered): колонка, доигравшая уход (ниже верхней или припаркованная), не рендерится
  // вовсе — content-visibility: hidden, раскладка и прокрутка ленты сохраняются, но смена темы, ширины окна и
  // новые сообщения в ней больше не стоят ни стилей, ни раскладки. Снимается в том же коммите, что и возврат на экран.
  // Готовящаяся колонка (pending, wake) не накрывается: её как раз раскладывают до показа. Класс — напрямую в DOM,
  // без состояния: рендер колонки — это рендер всего чата, лишний такой рендер лёг бы в кадр «Назад»
  const settled = pos !== 'on' && !pending;
  const coveredRef = useRef(false);
  // swap — подмена нижнего чата: собранная скрытой колонка встаёт на место без перехода
  const cls = 'app-chatcol app-chatcol-' + pos + ((instant && !entered) || swap ? ' app-chatcol-instant' : '') + (pending && !swap ? ' app-chatcol-moving' : '');
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (!settled) { coveredRef.current = false; el.classList.remove('app-chatcol-covered'); return; }
    // смена cls перезаписывает class целиком — уже накрытой колонке класс вернуть сразу
    if (coveredRef.current) { el.classList.add('app-chatcol-covered'); return; }
    const t = setTimeout(() => requestMutation(() => { coveredRef.current = true; el.classList.add('app-chatcol-covered'); }), COVER_MS);
    return () => clearTimeout(t);
  }, [settled, cls]);
  const hidden = on ? {} : { 'aria-hidden': true, inert: true };
  // тема чата (chatTheme.ts): акцент и свои пузыри — переменными на колонке, поверх темы страницы
  const themed = useChatThemeStyle(chatId);
  return (
    <div ref={box} class={cls} data-current={on ? '' : undefined} style={themed?.style} data-out-filled={themed?.filled ? '' : undefined} {...hidden}>
      <Chat frameKey={frame} chatId={chatId} threadId={threadId} scheduled={scheduled} savedPeer={savedPeer} active={on} />
    </div>
  );
});
