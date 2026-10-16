import { Avatar, Bubble, Composer, DateDivider, GlassBar, IconButton, Menu, ScrollToBottom, requestMeasure, requestMutation } from '@relay/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { loadOlder, openChat, send } from '../data';
import { useGlobal } from '../global';
import { clock, dayKey, dayLabel } from './format';
import { useReadTracker } from './readTracker';

let closedAt = -Infinity; // когда закрылась прежняя лента: близко по времени — значит, переключение между чатами

export function Chat({ chatId }: { chatId: number }) {
  // при переключении чатов шапка остаётся на месте — въезжает только при первом открытии
  const switching = useRef(performance.now() - closedAt < 200).current;
  useEffect(() => () => { closedAt = performance.now(); }, []);
  const me = useGlobal((s) => s.me)!;
  const chat = useGlobal((s) => s.chats.find((c) => c.id === chatId));
  const messages = useGlobal((s) => s.messages);
  const feed = useRef<HTMLDivElement>(null);
  const stick = useRef(true);              // лента прижата к низу
  const olderFrom = useRef<number | null>(null); // высота до подгрузки истории — якорь прокрутки
  const initial = useRef<Set<string> | null>(null);
  const [away, setAway] = useState(false);
  const programmatic = useRef(0);          // сколько scroll-событий вызвали мы сами
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [replyKey, setReplyKey] = useState<string | null>(null);

  if (initial.current === null && messages.length) initial.current = new Set(messages.map((m) => m.key));

  useReadTracker(chatId, feed, messages);

  // высота композера (растёт с цитатой ответа) → --composer-h: лента уходит под него ровно на эту высоту
  useLayoutEffect(() => {
    const main = feed.current?.parentElement;
    const wrap = main?.querySelector<HTMLElement>('.rl-composer-wrap');
    if (!main || !wrap || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(([e]) => { const h = Math.round(e.borderBoxSize?.[0]?.blockSize ?? wrap.offsetHeight); requestMutation(() => main.style.setProperty('--composer-h', h + 'px')); });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // после рендера: держим низ или якорь истории (замер → запись в одном кадре)
  const placed = useRef(false);            // первая раскладка ленты уже прокручена вниз
  useLayoutEffect(() => {
    const el = feed.current;
    if (!el) return;
    if (!placed.current && messages.length) {
      // первый кадр чата — сразу внизу, до отрисовки: иначе мелькнёт верх ленты
      placed.current = true;
      const bottom = el.scrollHeight - el.clientHeight;
      if (bottom > el.scrollTop) { programmatic.current++; el.scrollTop = bottom; } // scroll-событие будет только если позиция меняется
      return;
    }
    requestMeasure(() => {
      const h = el.scrollHeight;
      const from = olderFrom.current;
      requestMutation(() => {
        if (from !== null) { programmatic.current++; el.scrollTop += h - from; olderFrom.current = null; }
        else if (stick.current && el.scrollTop + el.clientHeight < h) { programmatic.current++; el.scrollTop = h; }
      });
    });
  }, [messages]);

  function onScroll() {
    const el = feed.current!;
    if (programmatic.current > 0) { programmatic.current--; return; } // наша же прокрутка не меняет «прижата к низу»
    requestMeasure(() => {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stick.current = fromBottom < 80;
      setAway(fromBottom > el.clientHeight);
      if (el.scrollTop < 160 && olderFrom.current === null) { olderFrom.current = el.scrollHeight; loadOlder(); }
    });
  }

  const title = (chat?.title as string) || 'Чат №' + chatId;
  // как в Telegram: в норме подзаголовок — тип чата, а пока идёт подключение или обновление — стадия
  const phaseLabel = useGlobal((s) => s.syncLabel);
  const byId = new Map(messages.filter((m) => m.id != null).map((m) => [m.id as number, m]));
  const replyTo = replyKey ? messages.find((m) => m.key === replyKey) : undefined;
  const authorOf = (senderId: unknown) => (senderId === me.userId ? 'Вы' : title);
  const menuMsg = menu ? messages.find((m) => m.key === menu.key) : undefined;
  let prevDay = '', prevSender: number | null = null;

  return (
    <>
      <GlassBar class={switching ? 'app-steady' : undefined}>
        <IconButton class="app-back" icon="arrowLeft" label="К списку чатов" onClick={() => openChat(null)} />
        <Avatar name={title} size={40} />
        <div class="rl-glassbar-title">
          <b>{title}</b>
          <span key={phaseLabel ?? 'kind'} class={phaseLabel ? 'app-phase' : undefined}>{phaseLabel ?? (chat?.kind === 'group' ? 'Группа' : 'Личный чат')}</span>
        </div>
        <IconButton icon="search" label="Поиск по чату" />
        <IconButton icon="more" label="Ещё" />
      </GlassBar>
      <div class="rl-feed" ref={feed} onScroll={onScroll} aria-live="polite">
        {messages.map((m, i) => {
          const day = dayKey(m.createdAt as string);
          const out = m.senderId === me.userId;
          const start = prevSender !== m.senderId || day !== prevDay;
          const next = messages[i + 1];
          const end = !next || next.senderId !== m.senderId || dayKey(next.createdAt as string) !== day;
          const quoted = m.replyToId != null ? byId.get(m.replyToId as number) : undefined;
          const divider = day !== prevDay ? <DateDivider key={'d' + day}>{dayLabel(m.createdAt as string)}</DateDivider> : null;
          prevDay = day; prevSender = m.senderId as number;
          return [
            divider,
            <div class="app-msg" key={m.key} data-msg-id={m.id ?? undefined}>
              <Bubble
                from={out ? 'out' : 'in'}
                tail={end}
                groupStart={start}
                reply={quoted ? { author: authorOf(quoted.senderId), text: quoted.body, tone: quoted.senderId === me.userId ? 1 : 3 } : undefined}
                onContextMenu={(e: MouseEvent) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, key: m.key as string }); }}
                time={clock(m.createdAt as string)}
                status={out ? m.status : undefined}
                appear={initial.current !== null && !initial.current.has(m.key)}
              >
                {m.body}
              </Bubble>
            </div>,
          ];
        })}
      </div>
      <div class="rl-scrolldown-slot">
        <ScrollToBottom show={away} unread={chat?.unread as number} onClick={() => { const el = feed.current!; stick.current = true; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }} />
      </div>
      <Composer
        id="composer"
        placeholder="Сообщение"
        replyTo={replyTo ? { author: authorOf(replyTo.senderId), text: replyTo.body, tone: replyTo.senderId === me.userId ? 1 : 3 } : null}
        onCancelReply={() => setReplyKey(null)}
        onSend={(text: string) => { stick.current = true; send(chatId, text, (replyTo?.id as number) ?? null); setReplyKey(null); }}
      />
      {menu && menuMsg ? (
        <>
          <div class="rl-msgmenu-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div class="rl-msgmenu" style={{ left: Math.min(menu.x, innerWidth - 230), top: Math.min(menu.y, innerHeight - 110) }}>
            <Menu
              label="Действия с сообщением"
              onClose={() => setMenu(null)}
              items={[
                ...(menuMsg.id != null ? [{ icon: 'reply', label: 'Ответить', onClick: () => { setReplyKey(menuMsg.key as string); document.getElementById('composer')?.focus(); } }] : []),
                { icon: 'copy', label: 'Копировать', onClick: () => { navigator.clipboard?.writeText(menuMsg.body as string).catch(() => {}); } },
              ]}
            />
          </div>
        </>
      ) : null}
    </>
  );
}
