import { Avatar, Bubble, Composer, DateDivider, GlassBar, IconButton, ScrollToBottom, SyncIndicator, requestMeasure, requestMutation } from '@relay/ui';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { loadOlder, openChat, send } from '../data';
import { useGlobal } from '../global';
import { clock, dayKey, dayLabel } from './format';
import { useReadTracker } from './readTracker';

export function Chat({ chatId }: { chatId: number }) {
  const me = useGlobal((s) => s.me)!;
  const chat = useGlobal((s) => s.chats.find((c) => c.id === chatId));
  const messages = useGlobal((s) => s.messages);
  const status = useGlobal((s) => s.status);
  const feed = useRef<HTMLDivElement>(null);
  const stick = useRef(true);              // лента прижата к низу
  const olderFrom = useRef<number | null>(null); // высота до подгрузки истории — якорь прокрутки
  const initial = useRef<Set<string> | null>(null);
  const [away, setAway] = useState(false);

  if (initial.current === null && messages.length) initial.current = new Set(messages.map((m) => m.key));

  useReadTracker(chatId, feed, messages);

  // после рендера: держим низ или якорь истории (замер → запись в одном кадре)
  useLayoutEffect(() => {
    const el = feed.current;
    if (!el) return;
    requestMeasure(() => {
      const h = el.scrollHeight;
      const from = olderFrom.current;
      requestMutation(() => {
        if (from !== null) { el.scrollTop += h - from; olderFrom.current = null; }
        else if (stick.current) el.scrollTop = h;
      });
    });
  }, [messages]);

  function onScroll() {
    const el = feed.current!;
    requestMeasure(() => {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stick.current = fromBottom < 80;
      setAway(fromBottom > el.clientHeight);
      if (el.scrollTop < 160 && olderFrom.current === null) { olderFrom.current = el.scrollHeight; loadOlder(); }
    });
  }

  const title = (chat?.title as string) || 'Чат №' + chatId;
  const sync = !status.online ? 'offline' : !status.synced || status.outbox ? 'syncing' : 'synced';
  let prevDay = '', prevSender: number | null = null;

  return (
    <>
      <GlassBar>
        <IconButton class="app-back" icon="arrowLeft" label="К списку чатов" onClick={() => openChat(null)} />
        <Avatar name={title} size={40} />
        <div class="rl-glassbar-title">
          <b>{title}</b>
          <span>{chat?.kind === 'group' ? 'Группа' : 'Личный чат'}</span>
        </div>
        <SyncIndicator state={sync} />
      </GlassBar>
      <div class="rl-feed" ref={feed} onScroll={onScroll} aria-live="polite">
        {messages.map((m) => {
          const day = dayKey(m.createdAt as string);
          const out = m.senderId === me.userId;
          const start = prevSender !== m.senderId || day !== prevDay;
          const divider = day !== prevDay ? <DateDivider key={'d' + day}>{dayLabel(m.createdAt as string)}</DateDivider> : null;
          prevDay = day; prevSender = m.senderId as number;
          return [
            divider,
            <div class="app-msg" key={m.key} data-msg-id={m.id ?? undefined}>
              <Bubble
                from={out ? 'out' : 'in'}
                tail={start}
                groupStart={start}
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
      <div style={{ position: 'absolute', right: 24, bottom: 96, zIndex: 3 }}>
        <ScrollToBottom show={away} unread={chat?.unread as number} onClick={() => { const el = feed.current!; stick.current = true; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }} />
      </div>
      <Composer id="composer" placeholder="Сообщение" onSend={(text: string) => { stick.current = true; send(chatId, text); }} />
    </>
  );
}
