import { Avatar, Button, MediaPolicy, peerTone, ChatSearchBar, Highlight, ripple, useMinVisible, requestMeasure, Composer, DropOverlay, GlassBar, IconButton, Menu, Modal, Presence, ReactionPicker, requestMutation, applyMarkdown, emptyValue, sameValue } from '@relay/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { deleteMessage, editMessage, ensureNames, focusMessage, sendFile, openChat, react, saveDraft, searchMessages, send, typing, typingDone } from '../data';
import type { Item, SearchHit } from '@relay/sync-engine/src/types';
import type { Entity } from '@relay/protocol';

type Value = { text: string; entities: Entity[] };
type ComposerApi = { getValue(): Value; setValue(v: Value, opts?: { focus?: boolean; instant?: boolean }): void; focus(opts?: { end?: boolean }): void };
import { setGlobal, useGlobal } from '../global';
import { unblockUser, useUser } from '../settingsData';
import { Feed } from './Feed';
import { chatKindFor, mediaPolicy } from '../autoload';
import { chatTime, chatTone, fileSize, lastSeenText, snippet } from './format';


export function Chat({ chatId }: { chatId: number }) {
  const me = useGlobal((s) => s.me)!;
  const chat = useGlobal((s) => s.chats.find((c) => c.id === chatId));
  const messages = useGlobal((s) => s.messages);
  // «Автозагрузка медиа» / автовоспроизведение для ленты этого чата (MediaBubble кита читает контекст)
  const isContact = useGlobal((s) => chat?.peerId != null && s.contacts.some((c) => c.userId === chat.peerId));
  const autoload = useGlobal((s) => s.prefs.autoload);
  const anim = useGlobal((s) => s.prefs.anim);
  const policy = useMemo(() => mediaPolicy({ autoload, anim }, chatKindFor(chat, new Set(isContact ? [chat!.peerId as number] : []))), [autoload, anim, chat?.kind, chat?.peerId, isContact]);
  const shell = useRef<HTMLSpanElement>(null);
  const stick = useRef(true);              // лента прижата к низу (Feed ведёт, отправка выставляет)
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [replyKey, setReplyKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; original: Value; draft: Value } | null>(null);   // правка своего сообщения
  const api = useRef<ComposerApi | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: number } | null>(null);
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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) closeFind(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [finding]);

  // вложения: выбор файла (скрепка), перетаскивание, вставка; перед отправкой — окно с превью и подписью
  const picker = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: File; url: string | null; caption: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const offer = (file: File | null | undefined) => {
    if (!file) return;
    setPending({ file, url: /^image\//.test(file.type) ? URL.createObjectURL(file) : null, caption: latest.current.text });
  };
  const closePending = () => { if (pending?.url) URL.revokeObjectURL(pending.url); setPending(null); };
  const sendPending = () => {
    if (!pending) return;
    stick.current = true;
    typingDone(chatId);
    sendFile(chatId, pending.file, pending.caption.trim(), (replyTo?.id as number) ?? null).catch(() => {});
    if (pending.caption === latest.current.text) { api.current?.setValue(emptyValue()); latest.current = saved.current = emptyValue(); }
    setReplyKey(null);
    closePending();
  };
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; depth++; setDragging(true); };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; setDragging(false); offer(e.dataTransfer!.files[0]); };
    const paste = (e: ClipboardEvent) => { const f = [...(e.clipboardData?.files ?? [])][0]; if (f) { e.preventDefault(); offer(f); } };
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
  const onType = (v: Value) => {
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
    if (latest.current.text) api.current?.focus({ end: true }); // курсор — в конец черновика
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

  // высота композера (растёт с цитатой ответа) → --composer-h: лента уходит под него ровно на эту высоту
  useLayoutEffect(() => {
    const main = shell.current?.closest<HTMLElement>('.rl-shell-main');
    const wrap = main?.querySelector<HTMLElement>('.rl-composer-wrap');
    if (!main || !wrap || typeof ResizeObserver !== 'function') return;
    const feed = main.querySelector<HTMLElement>('.rl-feed');
    // композер растёт или сжимается (каждый кадр анимации) — лента, прижатая к низу, остаётся прижатой
    const ro = new ResizeObserver(([e]) => {
      const h = Math.round(e.borderBoxSize?.[0]?.blockSize ?? wrap.offsetHeight);
      requestMutation(() => { main.style.setProperty('--composer-h', h + 'px'); if (stick.current && feed) feed.scrollTop = 1e9; });
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [plate]);   // плашка вместо поля ввода — другой элемент

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
  const subtitle = isTyping ? 'печатает…' : chat?.kind === 'group' ? 'Группа' : myPeer ? lastSeenText(online, myPeer.lastSeen as string | null) : '';
  const replyTo = replyKey ? messages.find((m) => m.key === replyKey) : undefined;
  const authorOf = (senderId: unknown) => (senderId === me.userId ? 'Вы' : title);
  const menuMsg = menu ? messages.find((m) => m.key === menu.key) : undefined;

  return (
    <>
      <span ref={shell} hidden />
      <GlassBar class={finding ? 'app-finding' : ''}>
        <IconButton class="app-back" icon="arrowLeft" label="К списку чатов" onClick={() => openChat(null)} />
        <button type="button" class="rl-glassbar-who" aria-label="Информация о чате" onClick={() => setGlobal({ infoOpen: !infoOpen })}>
          <Avatar name={title} tone={chatTone(chat)} size={40} />
          <span class="rl-glassbar-title">
            <b>{title}</b>
            <span key={phaseLabel ?? (isTyping ? 'typing' : online ? 'on' : 'off')} class={phaseLabel ? 'app-phase' : isTyping || online ? 'app-online' : undefined}>{phaseLabel ?? (subtitle || '\u00a0')}</span>
          </span>
        </button>
        <IconButton icon="search" label="Поиск по чату" onClick={() => setFinding(true)} />
        <IconButton icon="more" label="Информация" onClick={() => setGlobal({ infoOpen: !infoOpen })} />
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
                      <Avatar name={who} tone={peerTone(x.senderId)} size={40} />
                      <span class="app-findrow-text">
                        <span class="app-findrow-top"><b>{who}</b><time>{chatTime(x.createdAt)}</time></span>
                        <span class="app-findrow-body"><Highlight text={snippet(x.body, found.q)} query={found.q} /></span>
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
        <Feed chatId={chatId} meId={me.userId} peerName={title} stick={stick} highlight={found?.q} onMenu={(key, x, y) => setMenu({ key, x, y })} />
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
      ) : <Composer
        id="composer"
        apiRef={api}
        initialValue={initial}
        captureTyping
        sendKey={sendKey}
        placeholder="Сообщение"
        editing={!!editing}
        replyTo={editing ? { author: 'Редактирование', text: editing.original.text, tone: peerTone(me.userId), icon: 'pencil' } : replyTo ? { author: authorOf(replyTo.senderId), text: replyTo.body, tone: peerTone(replyTo.senderId) } : null}
        onCancelReply={() => {
          if (editing) { endEdit(editing.draft); return; } // правку отменили — вернуть черновик
          setReplyKey(null);
        }}
        onChange={onType}
        onEditLast={editLast}
        onReplyNav={replyNav}
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
          const sent = send(chatId, out.text, (replyTo?.id as number) ?? null, out.entities);
          setReplyKey(null);
          return sent;   // поле очистится, когда сообщение встанет в ленту
        }}
      />}
      {menu && menuMsg ? (() => {
        const own = menuMsg.senderId === me.userId && !menuMsg.deleted && menuMsg.id != null;
        const myReaction = ((menuMsg.reactions as { userId: number; emoji: string }[] | undefined) ?? []).find((r) => r.userId === me.userId)?.emoji;
        return (
          <>
            <div class="rl-msgmenu-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
            <div class="rl-msgmenu" style={{ left: Math.min(menu.x, innerWidth - 300), top: Math.min(menu.y, innerHeight - 240) }}>
              {menuMsg.id != null && !menuMsg.deleted ? (
                <ReactionPicker selected={myReaction} onPick={(emoji: string) => { react(chatId, menuMsg.id as number, myReaction === emoji ? null : emoji); setMenu(null); }} />
              ) : null}
              <Menu
                label="Действия с сообщением"
                onClose={() => setMenu(null)}
                items={[
                  ...(menuMsg.id != null && !menuMsg.deleted ? [{ icon: 'reply', label: 'Ответить', onClick: () => { if (editing) endEdit(editing.draft); setReplyKey(menuMsg.key as string); api.current?.focus({ end: true }); } }] : []),
                  ...(own ? [{ icon: 'pencil', label: 'Изменить', onClick: () => startEdit(menuMsg) }] : []),
                  ...(!menuMsg.deleted ? [{ icon: 'copy', label: 'Копировать', onClick: () => { navigator.clipboard?.writeText(menuMsg.body as string).catch(() => {}); } }] : []),
                  ...(own ? ['-' as const, { icon: 'trash', label: 'Удалить', danger: true, onClick: () => setConfirmDelete({ id: menuMsg.id as number }) }] : []),
                ]}
              />
            </div>
          </>
        );
      })() : null}
      <input ref={picker} type="file" hidden onChange={(e) => offer((e.target as HTMLInputElement).files?.[0])} />
      <Presence show={dragging} exitMs={160}><div class="app-drop"><DropOverlay title="Отпустите, чтобы отправить" text="Фото и документы до 50 МБ" /></div></Presence>
      {pending ? (
        <Modal title={pending.url ? 'Отправить фото' : 'Отправить файл'} onClose={closePending} actions={[
          <Button key="c" variant="ghost" onClick={closePending}>Отмена</Button>,
          <Button key="s" onClick={sendPending}>Отправить</Button>,
        ]}>
          {pending.url ? <img class="app-send-preview" src={pending.url} alt="" /> : (
            <div class="app-send-file"><b>{pending.file.name}</b><span>{fileSize(pending.file.size)}</span></div>
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
      {confirmDelete ? (
        <Modal
          title="Удалить сообщение?"
          icon="trash"
          onClose={() => setConfirmDelete(null)}
          actions={[
            <Button key="c" variant="ghost" onClick={() => setConfirmDelete(null)}>Отмена</Button>,
            <Button key="d" variant="danger" onClick={() => { deleteMessage(chatId, confirmDelete.id).catch(() => {}); setConfirmDelete(null); }}>Удалить у всех</Button>,
          ]}
        >
          <p class="app-modal-text">Сообщение исчезнет у всех участников чата.</p>
        </Modal>
      ) : null}
    </>
  );
}
