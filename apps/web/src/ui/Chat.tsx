import { Avatar, Composer, GlassBar, IconButton, Menu, requestMutation } from '@relay/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { openChat, saveDraft, send } from '../data';
import { setGlobal, useGlobal } from '../global';
import { Feed } from './Feed';
import { lastSeenText } from './format';

let closedAt = -Infinity; // когда закрылась прежняя лента: близко по времени — значит, переключение между чатами

export function Chat({ chatId }: { chatId: number }) {
  // при переключении чатов шапка остаётся на месте — въезжает только при первом открытии
  const switching = useRef(performance.now() - closedAt < 200).current;
  useEffect(() => () => { closedAt = performance.now(); }, []);
  const me = useGlobal((s) => s.me)!;
  const chat = useGlobal((s) => s.chats.find((c) => c.id === chatId));
  const messages = useGlobal((s) => s.messages);
  const shell = useRef<HTMLSpanElement>(null);
  const stick = useRef(true);              // лента прижата к низу (Feed ведёт, отправка выставляет)
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [replyKey, setReplyKey] = useState<string | null>(null);


  // черновик (как в Telegram): восстановить при открытии, сохранять через 2.5 с после ввода,
  // сразу — при уходе из чата и закрытии вкладки; после отправки движок сам его очищает
  const [text, setText] = useState(() => (chat?.draft as string) ?? '');
  const saved = useRef(text);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushDraft = () => {
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    if (latest.current !== saved.current) { saved.current = latest.current; saveDraft(chatId, latest.current); }
  };
  const latest = useRef(text);
  const onType = (v: string) => {
    setText(v);
    latest.current = v;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(flushDraft, 2500);
  };
  useEffect(() => {
    const input = document.getElementById('composer') as HTMLInputElement | null;
    if (input && text) input.setSelectionRange(text.length, text.length); // курсор — в конец текста
    addEventListener('pagehide', flushDraft);
    return () => { removeEventListener('pagehide', flushDraft); flushDraft(); };
  }, []);

  // высота композера (растёт с цитатой ответа) → --composer-h: лента уходит под него ровно на эту высоту
  useLayoutEffect(() => {
    const main = shell.current?.closest<HTMLElement>('.rl-shell-main');
    const wrap = main?.querySelector<HTMLElement>('.rl-composer-wrap');
    if (!main || !wrap || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(([e]) => { const h = Math.round(e.borderBoxSize?.[0]?.blockSize ?? wrap.offsetHeight); requestMutation(() => main.style.setProperty('--composer-h', h + 'px')); });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  const title = (chat?.title as string) || 'Чат №' + chatId;
  // как в Telegram: в норме подзаголовок — тип чата, а пока идёт подключение или обновление — стадия
  const phaseLabel = useGlobal((s) => s.syncLabel);
  const infoOpen = useGlobal((s) => s.infoOpen);
  const peer = useGlobal((s) => s.peer);
  const [, tick] = useState(0);              // «5 мин. назад» должно стареть само
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  const myPeer = peer && chat?.peerId === peer.userId && peer.known ? peer : null;
  const online = !!myPeer?.online;
  const subtitle = chat?.kind === 'group' ? 'Группа' : myPeer ? lastSeenText(online, myPeer.lastSeen as string | null) : '';
  const replyTo = replyKey ? messages.find((m) => m.key === replyKey) : undefined;
  const authorOf = (senderId: unknown) => (senderId === me.userId ? 'Вы' : title);
  const menuMsg = menu ? messages.find((m) => m.key === menu.key) : undefined;

  return (
    <>
      <span ref={shell} hidden />
      <GlassBar class={switching ? 'app-steady' : undefined}>
        <IconButton class="app-back" icon="arrowLeft" label="К списку чатов" onClick={() => openChat(null)} />
        <button type="button" class="rl-glassbar-who" aria-label="Информация о чате" onClick={() => setGlobal({ infoOpen: !infoOpen })}>
          <Avatar name={title} size={40} />
          <span class="rl-glassbar-title">
            <b>{title}</b>
            <span key={phaseLabel ?? (online ? 'on' : 'off')} class={phaseLabel ? 'app-phase' : online ? 'app-online' : undefined}>{phaseLabel ?? (subtitle || '\u00a0')}</span>
          </span>
        </button>
        <IconButton icon="search" label="Поиск по чату" />
        <IconButton icon="more" label="Информация" onClick={() => setGlobal({ infoOpen: !infoOpen })} />
      </GlassBar>
      <Feed chatId={chatId} meId={me.userId} peerName={title} stick={stick} onMenu={(key, x, y) => setMenu({ key, x, y })} />
      <Composer
        id="composer"
        placeholder="Сообщение"
        replyTo={replyTo ? { author: authorOf(replyTo.senderId), text: replyTo.body, tone: replyTo.senderId === me.userId ? 1 : 3 } : null}
        onCancelReply={() => setReplyKey(null)}
        value={text}
        onChange={onType}
        onSend={(body: string) => {
          stick.current = true;
          if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
          saved.current = latest.current = '';   // черновик очищает сам движок вместе с отправкой
          setText('');
          send(chatId, body, (replyTo?.id as number) ?? null);
          setReplyKey(null);
        }}
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
