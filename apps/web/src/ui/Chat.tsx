import { PinnedBar } from './PinnedBar';
import { senderAvatar } from '../profilePhoto';
import { firstUrl, loadPreview } from '../linkUrl';
import type { LinkPreview } from '@relay/protocol';
import { membersStatus, useMembers } from '../members';
import { Playlist } from './Playlist';
import { inProfile, toggleProfileMusic, type Track } from '../music';
import { Avatar, Button, Icon, MediaPolicy, peerTone, ChatSearchBar, Highlight, ripple, useMinVisible, requestMeasure, Composer, DropOverlay, GlassBar, IconButton, Menu, Modal, ConfirmDialog, Presence, ReactionPicker, plural, requestMutation, SelectionBar, isHeavyAnimating, onHeavyAnimationEnd, applyMarkdown, emptyValue, sameValue, voiceSupported, PlayerBar, roundSupported, startRound, Verified } from '@relay/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { closeChat, deleteMessage, editMessage, ensureNames, focusMessage, openChat, openUserChat, pinMessage, unpinMessage, sendFile, sendFiles, sendRound, sendVoice, react, saveDraft, searchMessages, send, typing, typingDone } from '../data';
import type { Item, SearchHit } from '@relay/sync-engine/src/types';
import type { Entity } from '@relay/protocol';

type Value = { text: string; entities: Entity[] };
type ComposerApi = { getValue(): Value; setValue(v: Value, opts?: { focus?: boolean; instant?: boolean }): void; focus(opts?: { end?: boolean }): void };
import { frameByKey, setGlobal, useGlobal } from '../global';
import { showToast, unblockUser, useUser } from '../settingsData';
import { Feed } from './Feed';
import { chatKindFor, mediaPolicy } from '../autoload';
import { chatTime, chatTone, fileSize, isSystemChat, lastSeenText, shownBody, snippet } from './format';
import type { ProfilePhoto } from '@relay/protocol';
import { avatarPhoto } from '../profilePhoto';
import { cancelForwardDraft, endSelect, forwardElsewhere, patchForwardDraft, sendForwardDraft, startForward, startSelect } from '../forward';


const NO_MESSAGES: Item[] = [];

/** Чат в стеке. active — он на экране: только он ловит ввод, файлы и Esc; остальные живут тихо. */
export function Chat({ chatId, frameKey, active }: { chatId: number; frameKey: string; active: boolean }) {
  const me = useGlobal((s) => s.me)!;
  const chat = useGlobal((s) => s.chats.find((c) => c.id === chatId));
  const messages = useGlobal((s) => frameByKey(s, frameKey)?.messages ?? NO_MESSAGES);
  const depth = useGlobal((s) => s.chatStack.length);
  const activeRef = useRef(active); activeRef.current = active;
  // служебный чат «Relay»: только чтение — без поля ввода, реакций, ответов и вложений
  const system = isSystemChat(chat);
  const systemRef = useRef(system); systemRef.current = system;
  // «Автозагрузка медиа» / автовоспроизведение для ленты этого чата (MediaBubble кита читает контекст)
  const isContact = useGlobal((s) => chat?.peerId != null && s.contacts.some((c) => c.userId === chat.peerId));
  const autoload = useGlobal((s) => s.prefs.autoload);
  const anim = useGlobal((s) => s.prefs.anim);
  const policy = useMemo(() => mediaPolicy({ autoload, anim }, chatKindFor(chat, new Set(isContact ? [chat!.peerId as number] : []))), [autoload, anim, chat?.kind, chat?.peerId, isContact]);
  const shell = useRef<HTMLSpanElement>(null);
  const stick = useRef(true);              // лента прижата к низу (Feed ведёт, отправка выставляет)
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [fwdMenu, setFwdMenu] = useState<{ x: number; y: number } | null>(null);   // опции пересылки в поле ввода
  const [replyKey, setReplyKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; original: Value; draft: Value } | null>(null);   // правка своего сообщения
  const api = useRef<ComposerApi | null>(null);
  // запись: голосовое — если браузер умеет Opus через WebCodecs, кружок — если умеет MP4 из canvas (не Safari)
  const [recordModes, setRecordModes] = useState<string[]>([]);
  useEffect(() => { let live = true; voiceSupported().then((ok: boolean) => { if (live) setRecordModes([...(ok ? ['voice'] : []), ...(roundSupported() ? ['round'] : [])]); }); return () => { live = false; }; }, []);
  const [recordMode, setRecordMode] = useState<string>(() => { try { return localStorage.getItem('relay.recordMode') || 'voice'; } catch { return 'voice'; } });
  const [confirmDelete, setConfirmDelete] = useState<{ ids: number[] } | null>(null);
  // поиск по чату: строка вместо шапки, совпадения новые → старые, Enter — к более старому
  const [finding, setFinding] = useState(false);
  const [findQ, setFindQ] = useState('');
  const [found, setFound] = useState<{ q: string; hits: SearchHit[]; at: number } | null>(null);
  // список совпадений под строкой поиска (как в Telegram): открыт, пока печатаем; выбор или ↑↓ — сворачивает
  const [listOpen, setListOpen] = useState(true);
  const names = useGlobal((s) => s.names);
  useEffect(() => {
    const q = findQ.trim();
    if (!finding || q.length < 2) { setFound(null); return; }
    let live = true;
    const t = setTimeout(() => searchMessages(q, chatId).then((r) => {
      if (!live) return;
      setFound({ q, hits: r.hits, at: 0 });
      ensureNames([...new Set(r.hits.map((x) => x.senderId))]);
    }).catch(() => {}), 300);
    return () => { live = false; clearTimeout(t); };
  }, [findQ, finding]);
  const pick = (at: number) => setFound((f) => {
    if (!f || !f.hits[at]) return f;
    setListOpen(false);
    focusMessage({ id: f.hits[at].id, sort: f.hits[at].sort });
    return { ...f, at };
  });
  const step = (d: 1 | -1) => setFound((f) => {
    if (!f || !f.hits.length) return f;
    setListOpen(false);
    // первый Enter после ввода — к самому новому совпадению, дальше — по шагам
    const at = listOpen ? f.at : (f.at + d + f.hits.length) % f.hits.length;
    focusMessage({ id: f.hits[at].id, sort: f.hits[at].sort });
    return { ...f, at };
  });
  const closeFind = () => { setFinding(false); setFindQ(''); setFound(null); setListOpen(true); };
  // лоадер в строке поиска: запрос ушёл, ответа на эту строку ещё нет (с задержкой и минимумом — не мигает)
  const findWant = findQ.trim();
  const searching = useMinVisible(finding && findWant.length >= 2 && found?.q !== findWant, { delay: 120, min: 450 });
  // высота списка — плавно: меряем содержимое, ставим высоту коробке (переход по height)
  const listBox = useRef<HTMLDivElement>(null);
  const listInner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = listBox.current, inner = listInner.current;
    if (!box || !inner || !listOpen) return;
    requestMeasure(() => {
      const h = Math.min(inner.scrollHeight, 360, Math.round(innerHeight * 0.55));
      requestMutation(() => { box.style.height = h + 'px'; });
    });
  }, [found, listOpen, names]);
  // Esc закрывает поиск, даже если фокус ушёл из поля (после выбора результата)
  useEffect(() => {
    if (!finding) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && activeRef.current) { e.preventDefault(); closeFind(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [finding]);

  // вложения: выбор файла (скрепка), перетаскивание, вставка; перед отправкой — окно с превью и подписью
  const picker = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: File; files: File[]; url: string | null; caption: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  // несколько файлов разом — одной группой (в ленте один пузырь); превью — только у одиночного фото
  const offer = (list: File | FileList | File[] | null | undefined) => {
    const files = !list ? [] : list instanceof File ? [list] : [...list];
    if (!files.length) return;
    const file = files[0];
    setPending({ file, files, url: files.length === 1 && /^image\//.test(file.type) ? URL.createObjectURL(file) : null, caption: latest.current.text });
  };
  const closePending = () => { if (pending?.url) URL.revokeObjectURL(pending.url); setPending(null); };
  const sendPending = () => {
    if (!pending) return;
    stick.current = true;
    typingDone(chatId);
    sendFiles(chatId, pending.files, pending.caption.trim(), (replyTo?.id as number) ?? null).catch(() => {});
    if (pending.caption === latest.current.text) { api.current?.setValue(emptyValue()); latest.current = saved.current = emptyValue(); }
    setReplyKey(null);
    closePending();
  };
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => { if (!activeRef.current || !hasFiles(e)) return; depth++; setDragging(true); };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const over = (e: DragEvent) => { if (activeRef.current && hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => { if (!activeRef.current || !hasFiles(e)) return; e.preventDefault(); depth = 0; setDragging(false); offer(e.dataTransfer!.files); };
    const paste = (e: ClipboardEvent) => { if (!activeRef.current) return; const fs = [...(e.clipboardData?.files ?? [])]; if (fs.length) { e.preventDefault(); offer(fs); } };
    addEventListener('dragenter', enter); addEventListener('dragleave', leave); addEventListener('dragover', over); addEventListener('drop', drop); addEventListener('paste', paste);
    return () => { removeEventListener('dragenter', enter); removeEventListener('dragleave', leave); removeEventListener('dragover', over); removeEventListener('drop', drop); removeEventListener('paste', paste); };
  }, []);
  useEffect(() => { if (finding) (document.getElementById('chat-find') as HTMLInputElement | null)?.focus(); }, [finding]);


  // черновик (как в Telegram): восстановить при открытии, сохранять через 2.5 с после ввода,
  // сразу — при уходе из чата и закрытии вкладки; после отправки движок сам его очищает
  // в элементе списка черновик — строка, оформление рядом
  const draftOf = (c: Item | undefined): Value => ({ text: (c?.draft as string | null) ?? '', entities: (c?.draftEntities as Entity[] | null) ?? [] });
  const initial = useMemo<Value>(() => draftOf(chat), []);
  const saved = useRef<Value>(initial);
  const latest = useRef<Value>(initial);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushDraft = () => {
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    if (editing) return;   // в поле — правка сообщения, а не черновик
    if (!sameValue(latest.current, saved.current)) { saved.current = latest.current; saveDraft(chatId, latest.current.text, latest.current.entities); }
  };
  // превью ссылки в поле ввода, как в Telegram: первая ссылка текста → через 400 мс спросить сервер; крестик — отправить без превью
  const [lp, setLp] = useState<{ url: string; link: LinkPreview | null; off: boolean } | null>(null);
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpUrl = useRef<string | null>(null);
  const watchLink = (v: Value) => {
    const url = firstUrl(v.text, v.entities as Entity[] | undefined);
    if (url === lpUrl.current) return;
    lpUrl.current = url;
    if (lpTimer.current) clearTimeout(lpTimer.current);
    if (!url) { setLp(null); return; }
    lpTimer.current = setTimeout(() => { void loadPreview(url).then((link) => { if (lpUrl.current === url) setLp((cur) => ({ url, link, off: cur?.url === url ? cur.off : false })); }); }, 400);
  };
  useEffect(() => { lpUrl.current = null; setLp(null); }, [chatId]);
  const onType = (v: Value) => {
    if (!editing) watchLink(v);
    if (v.text.trim() && v.text.length > latest.current.text.length && !editing) typing(chatId); // набирают (а не стирают) — «печатает…» у собеседника
    latest.current = v;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (!editing) draftTimer.current = setTimeout(flushDraft, 2500);
  };
  // черновик поменяли на другом устройстве (или стёрли отправкой там): здесь ничего не набирали — подхватываем
  const remoteDraft = draftOf(chat);
  const remoteKey = JSON.stringify(remoteDraft);
  useEffect(() => {
    if (editing || draftTimer.current || !sameValue(latest.current, saved.current) || sameValue(remoteDraft, latest.current)) return;
    saved.current = latest.current = remoteDraft;
    api.current?.setValue(latest.current, { instant: true });
  }, [remoteKey]);
  useEffect(() => {
    if (latest.current.text && activeRef.current) api.current?.focus({ end: true }); // курсор — в конец черновика
    addEventListener('pagehide', flushDraft);
    const hidden = () => { if (document.visibilityState === 'hidden') flushDraft(); };   // вкладку увели в фон — тоже сохранить
    document.addEventListener('visibilitychange', hidden);
    return () => { removeEventListener('pagehide', flushDraft); document.removeEventListener('visibilitychange', hidden); flushDraft(); };
  }, []);

  // правка: в поле — текст сообщения, черновик откладываем и возвращаем после
  const startEdit = (m: Item) => {
    flushDraft();
    setReplyKey(null);
    const original: Value = { text: m.body as string, entities: (m.entities as Entity[] | undefined) ?? [] };
    setEditing({ id: m.id as number, original, draft: latest.current });
    api.current?.setValue(original, { focus: true });
  };
  const endEdit = (draft: Value) => {
    setEditing(null);
    latest.current = draft;
    api.current?.setValue(draft, { focus: true });
  };
  // ↑ в пустом поле — последнее своё сообщение, которое можно править
  const editLast = () => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.senderId === me.userId && m.id != null && !m.deleted && (m.kind ?? 'text') === 'text') { startEdit(m); return; }
    }
  };
  // ⌘↑ / ⌘↓ в пустом поле — выбрать сообщение для ответа (дальше конца — отменить ответ)
  const replyNav = (dir: 'older' | 'newer') => {
    const list = messages.filter((m) => m.id != null && !m.deleted);
    if (!list.length) return;
    const at = replyKey ? list.findIndex((m) => m.key === replyKey) : list.length;
    const next = dir === 'older' ? Math.max(0, at - 1) : at + 1;
    if (next >= list.length) { setReplyKey(null); return; }
    setEditing(null);
    setReplyKey(list[next].key as string);
    focusMessage({ id: list[next].id as number, sort: list[next].sort as number });
  };

  // личный чат и чёрный список: я заблокировал собеседника или он меня (флаг blocksMe считает сервер) — вместо поля ввода плашка
  const iBlocked = useGlobal((s) => chat?.kind === 'direct' && chat.peerId != null && s.blocked.some((b) => b.userId === chat.peerId));
  const peerUser = useUser(chat?.kind === 'direct' ? (chat.peerId as number | null) : null);
  const theyBlocked = !!peerUser?.blocksMe;
  const plate = iBlocked ? 'mine' : theyBlocked ? 'theirs' : null;

  // режим выбора сообщений (панель вместо поля ввода)
  const selKeys = useGlobal((s) => (s.selecting?.chatId === chatId ? s.selecting.keys : null));
  // высота композера (растёт с цитатой ответа) → --composer-h: лента уходит под него ровно на эту высоту
  useLayoutEffect(() => {
    const main = shell.current?.closest<HTMLElement>('.app-chatcol');   // своя колонка стека
    const wrap = main?.querySelector<HTMLElement>('.rl-composer-wrap > .rl-composer');   // в потоке обёртка фиксированной высоты — меряем само поле
    if (!main || !wrap || typeof ResizeObserver !== 'function') return;
    const feed = main.querySelector<HTMLElement>('.rl-feed');
    // композер растёт или сжимается. Во время анимации (панель ответа/правки) отступ ленты не трогаем — иначе
    // каждый кадр перестраивается вся лента: прижатую к низу ленту только сдвигаем transform'ом (композитор),
    // а настоящий отступ ставим один раз, когда анимация кончилась (сдвиг снимаем в том же кадре — без скачка)
    let committed = parseFloat(main.style.getPropertyValue('--composer-h')) || 0, target = 0, waiting = false;
    const commit = () => {
      waiting = false;
      committed = target;
      main.style.setProperty('--composer-h', target + 'px');
      if (feed) { feed.style.transform = ''; if (stick.current) feed.scrollTop = 1e9; }
    };
    const ro = new ResizeObserver(([e]) => {
      target = Math.round(e.borderBoxSize?.[0]?.blockSize ?? wrap.offsetHeight);
      if (!target) return;   // поле убрали из дерева (замена панелью выбора) — ноль не настоящая высота
      if (!committed || !isHeavyAnimating()) { requestMutation(commit); return; }
      // сдвиг — сразу, в этом же кадре (наблюдатель срабатывает до отрисовки): лента идёт ровно вместе с полем
      if (feed && stick.current) feed.style.transform = target === committed ? '' : `translateY(${committed - target}px)`;
      if (!waiting) { waiting = true; onHeavyAnimationEnd(() => requestMutation(commit)); }
    });
    ro.observe(wrap);
    return () => { ro.disconnect(); if (feed) feed.style.transform = ''; };
  }, [plate, system]);   // плашка вместо поля ввода — другой элемент

  const title = (chat?.title as string) || 'Чат №' + chatId;
  // как в Telegram: в норме подзаголовок — тип чата, а пока идёт подключение или обновление — стадия
  const phaseLabel = useGlobal((s) => s.syncLabel);
  const sendKey = useGlobal((s) => s.prefs.sendKey);
  const infoOpen = useGlobal((s) => s.infoOpen);
  const peer = useGlobal((s) => s.peer);
  const [, tick] = useState(0);              // «5 мин. назад» должно стареть само
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  const myPeer = peer && chat?.peerId === peer.userId && peer.known ? peer : null;
  const online = !!myPeer?.online;
  const isTyping = !!chat?.typing;
  const members = useMembers(chatId, chat?.kind === 'group');
  const subtitle = system ? 'служебные уведомления' : isTyping ? 'печатает…' : chat?.kind === 'group' ? (members ? membersStatus(members, true) : 'Группа') : myPeer ? lastSeenText(online, myPeer.lastSeen as string | null) : '';
  const replyTo = replyKey ? messages.find((m) => m.key === replyKey) : undefined;
  const authorOf = (senderId: unknown) => (senderId === me.userId ? 'Вы' : title);
  const menuMsg = menu ? messages.find((m) => m.key === menu.key) : undefined;
  // пересылка, ждущая в поле ввода: «От: …» (или «Имена отправителей скрыты») и что пересылаем
  const fwd = useGlobal((s) => s.fwdDraft[chatId]) ?? null;
  const fwdQuote = fwd && !editing ? {
    icon: 'forward',
    author: fwd.hideSender ? 'Имена отправителей скрыты' : 'От: ' + fwd.preview.senders.map((s) => (s.id === me.userId ? me.name : s.name)).join(', '),
    text: fwd.preview.count > 1 ? `${fwd.preview.count} ${plural(fwd.preview.count, 'пересланное сообщение', 'пересланных сообщения', 'пересланных сообщений')}` : fwd.preview.text,
    tone: fwd.hideSender || !fwd.preview.senders.length ? peerTone(me.userId) : peerTone(fwd.preview.senders[0].id),
    onClick: (e: MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setFwdMenu({ x: r.left + 16, y: r.top }); },
  } : null;
  const nameOf = (id: number) => (id === me.userId ? me.name : names[id] ?? (chat?.kind === 'direct' ? title : ''));
  // «Переслать» из меню: у альбома — весь альбом
  const groupOf = (m: Item) => (m.groupId ? messages.filter((x) => x.groupId === m.groupId && x.senderId === m.senderId) : [m]);
  const forwardMenuMsg = (m: Item) => startForward(chatId, groupOf(m), nameOf);
  // режим выбора: вместо поля ввода — панель «Выбрано: N» (Переслать / Копировать / Удалить, если все свои)
  const selected = selKeys ? messages.filter((m) => selKeys.includes(m.key as string)) : [];
  useEffect(() => endSelect, [chatId]);   // ушли из чата — выбор сбрасывается
  useEffect(() => {
    if (!selKeys) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); endSelect(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [!!selKeys]);

  return (
    <>
      <span ref={shell} hidden />
      {/* плеер — остров над шапкой (как в Telegram): шапка плавно уезжает вниз, пока он открыт */}
      <PlayerBar
        onTitle={(t: Track) => { if (t.msgId != null && t.chatId) { if (t.chatId === chatId) focusMessage({ id: t.msgId, sort: t.msgId }); else openChat(t.chatId, { id: t.msgId, sort: t.msgId }); } }}
        onPlaylist={() => setGlobal({ playlistOpen: true })}
        inProfile={inProfile}
        onToggleProfile={(t: Track) => { if (t.msgId != null || inProfile(t)) void toggleProfileMusic(t); else showToast('В профиль можно добавить трек из чата'); }}
      />
      <Playlist />
      <GlassBar class={finding ? 'app-finding' : ''}>
        {/* поверх другого чата — «Назад» к нему (и на широком экране), нижний — к списку на узком */}
        <IconButton class={depth > 1 ? 'app-back app-back-inner' : 'app-back'} icon="arrowLeft" label={depth > 1 ? 'Назад' : 'К списку чатов'} onClick={closeChat} />
        <button type="button" class="rl-glassbar-who" aria-label="Информация о чате" onClick={() => setGlobal({ infoOpen: !infoOpen })}>
          <Avatar name={title} tone={chatTone(chat)} size={40} logo={system} {...avatarPhoto(chat?.photo as ProfilePhoto | null)} />
          <span class="rl-glassbar-title">
            <b>{title}{system ? <Verified size={16} /> : null}</b>
            <span key={phaseLabel ?? (isTyping ? 'typing' : online ? 'on' : 'off')} class={phaseLabel ? 'app-phase' : isTyping || online ? 'app-online' : undefined}>{phaseLabel ?? (subtitle || '\u00a0')}</span>
          </span>
        </button>
        <IconButton icon="search" label="Поиск по чату" onClick={() => setFinding(true)} />
        <IconButton icon="more" label="Информация" onClick={() => setGlobal({ infoOpen: !infoOpen })} />
        {/* закреплённые — под шапкой, как в Telegram (плеер — над ней) */}
        {!system ? <PinnedBar chatId={chatId} /> : null}
        {/* поиск по чату — карточка внутри шапки, как в Telegram: аватар и правая кнопка остаются видны */}
        {finding ? (
          <div class={'app-findcard' + (listOpen && found ? ' app-findcard-open' : '')}>
            <ChatSearchBar
              id="chat-find"
              value={findQ}
              total={found?.hits.length ?? 0}
              index={found?.at ?? 0}
              onQuery={(q: string) => { setFindQ(q); setListOpen(true); }}
              onFocus={() => setListOpen(true)}
              onNext={() => step(1)}
              onPrev={() => step(-1)}
              onClose={closeFind}
              busy={searching}
            />
            <Presence show={listOpen && !!found} exitMs={140}>
              <div class="app-findlist" ref={listBox} role="listbox" aria-label="Найденные сообщения"><div class="app-findlist-in" ref={listInner}>
                {found && found.hits.length ? found.hits.map((x, k) => {
                  const who = names[x.senderId] ?? (x.senderId === me.userId ? me.name : chat?.kind === 'direct' ? title : '');
                  return (
                    <button type="button" role="option" aria-selected={k === found.at} key={x.id} class={'app-findrow' + (k === found.at ? ' app-findrow-on' : '')} onPointerDown={ripple} onClick={() => pick(k)}>
                      <Avatar name={who} tone={peerTone(x.senderId)} size={40} {...senderAvatar(x.senderId)} />
                      <span class="app-findrow-text">
                        <span class="app-findrow-top"><b>{who}</b><time>{chatTime(x.createdAt)}</time></span>
                        <span class="app-findrow-body"><Highlight text={snippet(shownBody(x), found.q)} query={found.q} /></span>
                      </span>
                    </button>
                  );
                }) : <div class="app-findempty">Ничего не найдено</div>}
              </div></div>
            </Presence>
          </div>
        ) : null}
      </GlassBar>
      <MediaPolicy.Provider value={policy}>
        <Feed frameKey={frameKey} active={active} chatId={chatId} meId={me.userId} peerName={title} group={chat?.kind === 'group'} onAuthor={openUserChat} stick={stick} highlight={found?.q} onMenu={(key, x, y) => setMenu({ key, x, y })} />
      </MediaPolicy.Provider>
      {plate ? (
        <div class="rl-composer-wrap app-plate-wrap">
          <div class="rl-composer app-plate" role="status" key={plate}>
            {plate === 'mine' ? (
              <>
                <span>Вы заблокировали этого пользователя</span>
                <Button variant="ghost" onClick={() => { if (chat?.peerId != null) void unblockUser(chat.peerId as number); }}>Разблокировать</Button>
              </>
            ) : <span>Вы не можете отправлять сообщения этому пользователю</span>}
          </div>
        </div>
      ) : <div class={'app-composer-host' + (selKeys ? ' is-selecting' : '')}><Composer
        id="composer"
        apiRef={api}
        initialValue={initial}
        captureTyping={active}
        sendKey={sendKey}
        placeholder="Сообщение"
        editing={!!editing}
        sendEmpty={!!fwdQuote}
        replyTo={editing ? { author: 'Редактирование', text: editing.original.text, tone: peerTone(me.userId), icon: 'pencil' } : fwdQuote ? fwdQuote : !replyTo && lp?.link && !lp.off ? {
          icon: 'link', author: lp.link.siteName || lp.link.title || lp.url, text: lp.link.description || lp.link.title || lp.url, tone: 5,
          thumbSrc: lp.link.photo ? `/files/${lp.link.photo.id}` : undefined,
        } : replyTo ? { author: authorOf(replyTo.senderId), text: replyTo.body, tone: peerTone(replyTo.senderId) } : null}
        onCancelReply={() => {
          if (editing) { endEdit(editing.draft); return; } // правку отменили — вернуть черновик
          if (fwd) { cancelForwardDraft(chatId); return; }
          if (!replyTo && lp?.link && !lp.off) { setLp({ ...lp, off: true }); api.current?.focus({ end: true }); return; }   // крестик у превью — отправить без него; фокус — обратно в поле
          setReplyKey(null);
        }}
        onChange={onType}
        onEditLast={editLast}
        onReplyNav={replyNav}
        chatKey={chatId}
        recordModes={recordModes}
        startRound={startRound}
        recordMode={recordMode}
        onRecordModeChange={(m: string) => { setRecordMode(m); try { localStorage.setItem('relay.recordMode', m); } catch { /* без хранилища — до перезагрузки */ } }}
        onRecordError={(err: { name?: string }, mode: string) => showToast(err?.name === 'NotAllowedError' || err?.name === 'NotFoundError'
          ? (mode === 'round' ? 'Разрешите доступ к камере и микрофону, чтобы записывать видеосообщения' : 'Разрешите доступ к микрофону, чтобы записывать голосовые')
          : mode === 'round' ? 'Не удалось записать видеосообщение' : 'Не удалось записать голосовое')}
        onSendVoice={(r: { blob: Blob; duration: number; waveform: Uint8Array }) => { stick.current = true; sendVoice(chatId, r, (replyTo?.id as number) ?? null).catch(() => {}); setReplyKey(null); }}
        onSendRound={(r: { blob: Blob; duration: number; size: number; thumb: string | null }) => { stick.current = true; sendRound(chatId, r, (replyTo?.id as number) ?? null).catch(() => {}); setReplyKey(null); }}
        onAttach={(k: string) => { const el = picker.current!; el.accept = k === 'media' || k === 'camera' ? 'image/*,video/*' : ''; el.value = ''; el.click(); }}
        onSend={(v: Value) => {
          if (editing) {
            const next = applyMarkdown(v);
            if (!sameValue(next, editing.original)) editMessage(chatId, editing.id, next.text, next.entities).catch(() => {});
            endEdit(editing.draft);
            return false;   // в поле уже черновик — композер его не трогает
          }
          stick.current = true;
          if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
          saved.current = latest.current = emptyValue();   // черновик очищает сам движок вместе с отправкой
          typingDone(chatId);
          const out = applyMarkdown(v);   // **жирный**, `код`, [текст](ссылка)… — в оформление
          if (fwd) return sendForwardDraft(chatId, out.text, out.entities);   // комментарий первым, затем пересланное
          // превью: убрали крестиком — без него; уже загружено для этой ссылки — сразу в ленте, до ответа сервера
          const url = firstUrl(out.text, out.entities);
          const pv = lp && url === lp.url ? (lp.off ? { noLinkPreview: true } : { link: lp.link }) : {};
          lpUrl.current = null; setLp(null);
          const sent = send(chatId, out.text, (replyTo?.id as number) ?? null, out.entities, pv);
          setReplyKey(null);
          return sent;   // поле очистится, когда сообщение встанет в ленту
        }}
      />
        {/* режим выбора: панель «Выбрано: N» проявляется поверх поля ввода (поле остаётся на месте и гаснет), как в Telegram */}
        <Presence show={!!selKeys} exitMs={200}>
          <div class="app-selbar-layer">
            <SelectionBar count={selected.length} onCancel={endSelect}
              onForward={() => { const list = selected; endSelect(); startForward(chatId, list, nameOf); }}
              onCopy={() => { navigator.clipboard?.writeText(selected.filter((m) => m.body).map((m) => m.body as string).join('\n\n')).catch(() => {}); showToast('Скопировано'); endSelect(); }}
              onDelete={selected.length && selected.every((m) => m.senderId === me.userId) ? () => setConfirmDelete({ ids: selected.map((m) => m.id as number) }) : undefined} />
          </div>
        </Presence>
      </div>}
      {menu && menuMsg ? (() => {
        const own = menuMsg.senderId === me.userId && !menuMsg.deleted && menuMsg.id != null;
        const myReaction = ((menuMsg.reactions as { userId: number; emoji: string }[] | undefined) ?? []).find((r) => r.userId === me.userId)?.emoji;
        return (
          <>
            <div class="rl-msgmenu-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
            <div class="rl-msgmenu" style={{ left: Math.min(menu.x, innerWidth - 300), top: Math.min(menu.y, innerHeight - 240) }}>
              {menuMsg.id != null && !menuMsg.deleted && !system ? (
                <ReactionPicker selected={myReaction} onPick={(emoji: string) => { react(chatId, menuMsg.id as number, myReaction === emoji ? null : emoji); setMenu(null); }} />
              ) : null}
              <Menu
                label="Действия с сообщением"
                onClose={() => setMenu(null)}
                items={[
                  ...(menuMsg.id != null && !menuMsg.deleted && !system ? [{ icon: 'reply', label: 'Ответить', onClick: () => { if (editing) endEdit(editing.draft); setReplyKey(menuMsg.key as string); api.current?.focus({ end: true }); } }] : []),
                  ...(menuMsg.id != null && !menuMsg.deleted && !menuMsg.service ? [{ icon: 'forward', label: 'Переслать', onClick: () => forwardMenuMsg(menuMsg) }] : []),
                  ...(menuMsg.id != null && !menuMsg.deleted && !menuMsg.service ? [{ icon: 'checkCircle', label: 'Выбрать', onClick: () => startSelect(chatId, groupOf(menuMsg).map((x) => x.key as string)) }] : []),
                  ...(own && !system ? [{ icon: 'pencil', label: 'Изменить', onClick: () => startEdit(menuMsg) }] : []),
                  ...(menuMsg.id != null && !menuMsg.deleted && !system && !menuMsg.service ? [((chat?.pinned as number[] | undefined) ?? []).includes(menuMsg.id as number)
                    ? { icon: 'pin', label: 'Открепить', onClick: () => void unpinMessage(chatId, menuMsg.id as number) }
                    : { icon: 'pin', label: 'Закрепить', onClick: () => void pinMessage(chatId, menuMsg.id as number) }] : []),
                  ...(!menuMsg.deleted ? [{ icon: 'copy', label: 'Копировать', onClick: () => { navigator.clipboard?.writeText(menuMsg.body as string).catch(() => {}); } }] : []),
                  ...(own ? ['-' as const, { icon: 'trash', label: 'Удалить', danger: true, onClick: () => setConfirmDelete({ ids: [menuMsg.id as number] }) }] : []),
                ]}
              />
            </div>
          </>
        );
      })() : null}
      {fwdMenu && fwd ? (
        <>
          <div class="rl-msgmenu-scrim" onClick={() => setFwdMenu(null)} />
          <div class="rl-msgmenu app-fwdmenu" style={{ left: Math.min(fwdMenu.x, innerWidth - 260), bottom: innerHeight - fwdMenu.y + 6 }}>
            <Menu
              label="Параметры пересылки"
              onClose={() => setFwdMenu(null)}
              items={[
                fwd.hideSender
                  ? { icon: 'eye', label: 'Показать отправителя', onClick: () => patchForwardDraft(chatId, { hideSender: false }) }
                  : { icon: 'eyeOff', label: 'Скрыть отправителя', onClick: () => patchForwardDraft(chatId, { hideSender: true }) },
                ...(fwd.preview.captions ? [fwd.hideCaption
                  ? { icon: 'eye', label: 'Показать подписи', onClick: () => patchForwardDraft(chatId, { hideCaption: false }) }
                  : { icon: 'eyeOff', label: 'Скрыть подписи', onClick: () => patchForwardDraft(chatId, { hideCaption: true }) }] : []),
                { icon: 'forward', label: 'Другой чат…', onClick: () => forwardElsewhere(chatId) },
              ]}
            />
          </div>
        </>
      ) : null}
      <input ref={picker} type="file" multiple hidden onChange={(e) => offer((e.target as HTMLInputElement).files)} />
      <Presence show={dragging} exitMs={160}><div class="app-drop"><DropOverlay title="Отпустите, чтобы отправить" text="Фото и документы до 50 МБ" /></div></Presence>
      {pending ? (
        <Modal size="slim" title={pending.files.length > 1 ? `Отправить файлы: ${pending.files.length}` : pending.url ? 'Отправить фото' : 'Отправить файл'} onClose={closePending} actions={[
          <Button key="c" variant="ghost" onClick={closePending}>Отмена</Button>,
          <Button key="s" onClick={sendPending}>Отправить</Button>,
        ]}>
          {pending.url ? <img class="app-send-preview" src={pending.url} alt="" /> : (
            <div class="app-send-files">{pending.files.map((f, i) => <div key={i} class="app-send-file"><b>{f.name}</b><span>{fileSize(f.size)}</span></div>)}</div>
          )}
          <input
            class="app-field app-send-caption"
            placeholder="Подпись"
            value={pending.caption}
            onInput={(e) => setPending({ ...pending, caption: (e.target as HTMLInputElement).value })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendPending(); } }}
            autoFocus
          />
        </Modal>
      ) : null}
      <ConfirmDialog open={!!confirmDelete} danger title={confirmDelete && confirmDelete.ids.length > 1 ? `Удалить ${confirmDelete.ids.length} ${plural(confirmDelete.ids.length, 'сообщение', 'сообщения', 'сообщений')}?` : 'Удалить сообщение?'}
        text={confirmDelete && confirmDelete.ids.length > 1 ? 'Сообщения исчезнут у всех участников чата.' : 'Сообщение исчезнет у всех участников чата.'} confirm="Удалить у всех"
        onCancel={() => setConfirmDelete(null)} onConfirm={() => { if (confirmDelete) for (const id of confirmDelete.ids) deleteMessage(chatId, id).catch(() => {}); setConfirmDelete(null); endSelect(); }} />
    </>
  );
}
