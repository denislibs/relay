import { beginHeavyAnimation, nudgeWallpaper, toBase64 } from '@relay/ui';
import { connectEngine, EngineClient, Mirror } from '@relay/sync-engine/src/client';
import type { Item, Patch, Query, SearchResult } from '@relay/sync-engine/src/types';
import { hideSpoilers, type Entity } from '@relay/protocol';
import { activeFrame, frameByKey, getGlobal, setGlobal, type ChatFrame, type FeedMeta, type Me, type Status } from './global';
import { bindChatDepth, popChats, pushChat } from './nav';
import { notifyIncoming, startNotify } from './notify';
import { isSystemChat } from './ui/format';

declare const __BUILD__: string;

let engine: EngineClient;
// порция ленты — два экрана сообщений (строка-бабл ≈ 40 px), не меньше 30: как и страница диалогов, от высоты окна
const FEED_PAGE = Math.max(30, Math.ceil(innerHeight / 40) * 2);

/** Подписки движка → GlobalState. Несрочное применяем после тяжёлых анимаций. */
export function startData(me: Me): void {
  engine = connectEngine({
    build: __BUILD__,
    config: {
      userId: me.userId,
      dbName: 'relay-' + me.userId,
      httpBase: location.origin,
      wsUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
      // страница диалогов — два экрана строк (как в Telegram: от высоты окна), не меньше 20
      dialogsPage: Math.max(20, Math.ceil(innerHeight / 72) * 2),
      historyPage: FEED_PAGE,   // история с сервера — той же порцией
    },
    sharedUrl: '/shared.worker.js',
    dedicatedUrl: '/dedicated.worker.js',
  });
  engine.onReload(() => location.reload());

  const chats = new Mirror();
  let seen: Map<number, number> | null = null;
  engine.watch({ kind: 'chatList', limit: 1000 }, (p) => {
    const before = seen;
    chats.apply(p);
    seen = new Map(chats.list().map((c) => [c.id as number, ((c.last as { id?: number } | null)?.id ?? 0)]));
    // новое чужое сообщение в чате, который уже знали (первый снимок из IndexedDB — не новость)
    if (before) for (const c of chats.list()) {
      const last = c.last as { id: number | null; senderId: number; body: string; kind?: string; attachment?: { name: string } | null; createdAt: string; service?: { type: string } } | null;
      if (!last?.id || last.senderId === me.userId || last.id <= (before.get(c.id as number) ?? 0)) continue;
      if (c.id === getGlobal().openChatId && document.visibilityState === 'visible') continue;
      notifyIncoming({ id: c.id as number, title: (c.title as string) || 'Чат №' + c.id, muted: getGlobal().muted.includes(c.id as number), system: isSystemChat(c) },
        { id: last.id, body: hideSpoilers(last.body, (last as { entities?: Entity[] }).entities), kind: last.kind, attachmentName: last.attachment?.name, createdAt: last.createdAt, service: last.service });
    }
    // сразу, не дожидаясь конца анимаций: список виртуальный (≈20 строк), а отложенный подъём чата
    // после отправки выглядит как запоздалый рывок
    setGlobal({ chats: chats.list(), chatsLoaded: true });
    const seed: Record<number, string> = { [me.userId]: me.name };
    for (const c of chats.list()) if (c.kind === 'direct' && c.peerId && c.title) seed[c.peerId as number] = c.title as string;
    rememberNames(seed);
    // открытый чат появился в списке — теперь известен собеседник: подписываемся на его статус
    const g = getGlobal(), current = g.pendingChatId ?? g.openChatId;
    if (current && peerFor !== current) watchPeer(current);
  });
  const counters = new Mirror();
  engine.watch({ kind: 'counters' }, (p) => { counters.apply(p); const c = counters.list()[0]; if (c) setGlobal({ counters: { unreadChats: c.unreadChats as number, unreadMessages: c.unreadMessages as number } }); });
  const status = new Mirror();
  engine.watch({ kind: 'status' }, (p) => { status.apply(p); const s = status.list()[0] as unknown as Status | undefined; if (s) { setGlobal({ status: s }); showPhase(s); } });

  bindChatDepth(onChatDepth);
  startNotify((id) => { focus(); openChat(id); });
  const open = Number(new URLSearchParams(location.hash.slice(1)).get('chat')) || null;
  if (open) openChat(open);
}

const PHASE_LABEL: Record<string, string> = {
  connecting: 'Подключение…',
  loading: 'Загрузка чатов…',
  updating: 'Обновление…',
  offline: 'Ожидание сети…',
};
const MIN_LABEL_MS = 600;
let labelSince = 0;
let labelTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Надпись стадии в поле поиска. Ведётся здесь, на каждом патче статуса, а не в рендере:
 * «Обновление…» бывает короче кадра и в рендер бы не попало. Новая стадия сменяет прежнюю сразу,
 * а последняя держится не меньше MIN_LABEL_MS — её успевают прочитать, и она не мигает.
 */
function showPhase(s: Status): void {
  const want = s.phase === 'ready' ? null : PHASE_LABEL[s.phase] + (s.phase === 'offline' && s.outbox ? ` В очереди: ${s.outbox}` : '');
  const shown = getGlobal().syncLabel;
  if (labelTimer) { clearTimeout(labelTimer); labelTimer = null; }
  if (want === shown) return;
  if (want !== null) { labelSince = performance.now(); setGlobal({ syncLabel: want }); return; }
  labelTimer = setTimeout(() => { labelTimer = null; setGlobal({ syncLabel: null }); }, Math.max(0, MIN_LABEL_MS - (performance.now() - labelSince)));
}

let peerWatch: { close(): void } | null = null;
let peerFor: number | null = null;   // для какого чата подписка уже решена (есть собеседник или это группа)

/** Присутствие собеседника личного чата — отдельная маленькая подписка, живёт, пока чат открыт. */
function watchPeer(chatId: number | null): void {
  peerWatch?.close();
  peerWatch = null;
  peerFor = null;
  const chat = chatId ? getGlobal().chats.find((c) => c.id === chatId) : undefined;
  // чата ещё нет в списке (открыт по #chat= до загрузки списка) — решим, когда список придёт
  if (chat) peerFor = chatId;
  // у служебного чата «Relay» присутствия нет — подзаголовок постоянный, подписка не нужна
  const peerId = isSystemChat(chat) ? null : chat?.peerId as number | null | undefined;
  if (!peerId) { setGlobal({ peer: null }); return; }
  const m = new Mirror();
  peerWatch = engine.watch({ kind: 'presence', userId: peerId }, (p: Patch) => { m.apply(p); setGlobal({ peer: (m.list()[0] as Item) ?? null }); });
}

type Anchor = { sort: number; side: 'end' | 'start' | 'center' };
const WINDOW = FEED_PAGE * 2;                  // сообщений в DOM: две порции (как окно viewport в Telegram)
/** Позиция прокрутки чата при уходе: первый видимый бабл и его отступ (нет записи — чат был внизу). */
const positions = new Map<number, { key: string; sort: number; offset: number }>();

export function savePosition(chatId: number, pos: { key: string; sort: number; offset: number } | null): void {
  if (pos) positions.set(chatId, pos); else positions.delete(chatId);
}
export function savedPosition(chatId: number) { return positions.get(chatId) ?? null; }

/* ---------- стек чатов ----------
 * Как в Telegram Web: openChat (клик в списке) — нижний чат, стек сбрасывается; openInner (переход
 * изнутри чата) — новый чат поверх, прежний остаётся живым в DOM (вернуться — мгновенно, на том же месте).
 * У каждого кадра — своя подписка на окно ленты. */

interface Session { chatId: number; watch: { update(q: Query): void; close(): void }; mirror: Mirror; anchor: Anchor | undefined; moving: boolean; first: boolean; timer: ReturnType<typeof setTimeout> | null }
const sessions = new Map<string, Session>();
let frameSeq = 0;
let pendingBottom: { frame: ChatFrame; target?: { id: number; sort: number } } | null = null;   // новый нижний чат, лента ещё не готова
const LEAVE_MS = 350;   // уход снятого чата: анимация 250 мс + запас

const stack = () => getGlobal().chatStack;
const topReady = () => activeFrame(getGlobal());

function patchFrame(key: string, patch: Partial<ChatFrame>): void {
  if (pendingBottom?.frame.key === key) { pendingBottom.frame = { ...pendingBottom.frame, ...patch }; return; }
  setGlobal((s) => ({ chatStack: s.chatStack.map((f) => (f.key === key ? { ...f, ...patch } : f)) }));
}

function closeSession(key: string): void {
  const s = sessions.get(key);
  if (!s) return;
  s.watch.close();
  if (s.timer) clearTimeout(s.timer);
  sessions.delete(key);
}

/** Окно ленты кадра; onFirst — первый снимок (или 700 мс без него: не держим пользователя на прежнем чате). */
function startFeed(frame: ChatFrame, anchor: Anchor | undefined, onFirst: (patch: Partial<ChatFrame>) => void): void {
  const s: Session = { chatId: frame.chatId, mirror: new Mirror(), anchor, moving: true, first: true, timer: null, watch: null as never };
  sessions.set(frame.key, s);
  const first = (patch: Partial<ChatFrame>) => { s.first = false; if (s.timer) { clearTimeout(s.timer); s.timer = null; } onFirst(patch); };
  // лента — срочная: свои сообщения должны появляться в тот же кадр
  s.watch = engine.watch({ kind: 'messages', chatId: frame.chatId, limit: WINDOW, anchor }, (p: Patch) => {
    s.mirror.apply(p);
    s.moving = false;
    const meta = (s.mirror.meta('~window') as unknown as FeedMeta) ?? null;
    const patch = { messages: s.mirror.list() as Item[], feedMeta: meta };
    if (s.first) first(patch); else patchFrame(frame.key, patch);
    // окно дошло до последних сообщений — снова живой хвост (новые сообщения появятся сами)
    if (s.anchor && meta?.live && !meta.hasNewer) { s.anchor = undefined; s.watch.update({ kind: 'messages', chatId: frame.chatId, limit: WINDOW }); }
  });
  s.timer = setTimeout(() => { if (s.first) first({}); }, 700);
}

function newFrame(chatId: number, target?: { id: number; sort: number }): { frame: ChatFrame; anchor: Anchor | undefined } {
  const chat = getGlobal().chats.find((c) => c.id === chatId);
  const pos = positions.get(chatId);
  const unread = (chat?.unread as number) > 0 ? (chat!.lastReadId as number) : null;
  // открыть на найденном сообщении; иначе: ушли из середины истории — туда же; непрочитанное; низ
  const anchor: Anchor | undefined = target ? { sort: target.sort, side: 'center' } : pos ? { sort: pos.sort, side: 'center' } : unread != null ? { sort: unread + 0.5, side: 'center' } : undefined;
  const frame: ChatFrame = {
    key: 'c' + ++frameSeq, chatId, ready: false, messages: [], feedMeta: null,
    unreadFrom: target ? null : unread,
    focus: target ? { ...target, nonce: Date.now(), replaced: true } : null,
  };
  return { frame, anchor };
}

/** Адрес и присутствие — по чату на экране. */
function syncShown(): void {
  const top = topReady();
  history.replaceState(history.state, '', top ? '#chat=' + top.chatId : location.pathname);
  if ((top?.chatId ?? null) !== peerFor) watchPeer(top?.chatId ?? null);
}

/** Отменить ещё не показанный чат (новый нижний или поверх): его лента не дождалась. */
function cancelPending(): void {
  if (pendingBottom) { closeSession(pendingBottom.frame.key); pendingBottom = null; }
  const half = stack().filter((f) => !f.ready);
  if (half.length) {
    half.forEach((f) => closeSession(f.key));
    setGlobal((s) => ({ chatStack: s.chatStack.filter((f) => f.ready) }));
  }
  if (getGlobal().pendingChatId != null) setGlobal({ pendingChatId: null });
}

/** Снять со стека всё выше index (анимация ухода). */
function popTo(index: number): void {
  const st = stack();
  const removed = st.slice(index + 1);
  if (!removed.length || index < 0) return;
  removed.forEach((f) => closeSession(f.key));
  beginHeavyAnimation(LEAVE_MS + 50);
  setGlobal((s) => ({ chatStack: s.chatStack.slice(0, index + 1), chatLeaving: [...s.chatLeaving, ...removed], openChatId: s.chatStack[index].chatId, pendingChatId: null }));
  setTimeout(() => setGlobal((s) => ({ chatLeaving: s.chatLeaving.filter((f) => !removed.includes(f)) })), LEAVE_MS);
  popChats(index);
  syncShown();
}

/** «Назад» браузера / Esc сменили глубину стека. */
function onChatDepth(depth: number): void {
  cancelPending();
  if (depth < stack().length - 1) popTo(depth);
  else syncShown();   // запись истории вернула прежний адрес — поправить на чат на экране
}

/** Чат из списка (или из адреса, уведомления): нижний кадр, стек сбрасывается. */
export function openChat(chatId: number | null, target?: { id: number; sort: number }): void {
  const g = getGlobal(), st = g.chatStack, top = topReady();
  if (chatId != null && (g.pendingChatId ?? top?.chatId) === chatId && (st.length <= 1 || top?.chatId === chatId)) {
    if (target) focusMessage(target);
    return;
  }
  cancelPending();
  if (!chatId) {
    for (const f of st) closeSession(f.key);
    popChats(0);
    setGlobal({ chatStack: [], chatLeaving: [], openChatId: null, pendingChatId: null });
    syncShown();
    return;
  }
  // нижний чат стека и есть этот — просто вернуться к нему (с анимацией), как в Telegram
  if (st.length > 1 && st[0].chatId === chatId) {
    popTo(0);
    if (target) focusMessage(target);
    return;
  }
  const { frame, anchor } = newFrame(chatId, target);
  pendingBottom = { frame, target };
  setGlobal({ pendingChatId: chatId });
  // пока лента нового чата не готова, на экране остаётся прежний; затем шапка и лента меняются одним кадром
  startFeed(frame, anchor, (patch) => {
    if (pendingBottom?.frame.key !== frame.key) return;
    const ready: ChatFrame = { ...pendingBottom.frame, ...patch, ready: true, instant: true };
    pendingBottom = null;
    for (const f of stack()) closeSession(f.key);
    popChats(0);
    setGlobal({ chatStack: [ready], chatLeaving: [], openChatId: chatId, pendingChatId: null });
    syncShown();
  });
}

/** Чат изнутри другого (автор в группе, найденное сообщение): поверх стека, прежний остаётся живым. */
export function openInner(chatId: number, target?: { id: number; sort: number }): void {
  const g = getGlobal();
  if (!topReady()) { openChat(chatId, target); return; }
  cancelPending();
  const st = g.chatStack;
  const at = st.findIndex((f) => f.chatId === chatId);
  if (at >= 0) {   // уже в стеке — снять всё выше него
    if (at < st.length - 1) popTo(at);
    if (target) focusMessage(target);
    return;
  }
  const { frame, anchor } = newFrame(chatId, target);
  // колонка сразу в DOM (скрыта): лента раскладывается и встаёт на позицию до показа
  setGlobal({ chatStack: [...st, frame], pendingChatId: chatId });
  startFeed(frame, anchor, (patch) => {
    if (!stack().some((f) => f.key === frame.key)) return;
    beginHeavyAnimation(LEAVE_MS + 50);
    patchFrame(frame.key, { ...patch, ready: true });
    setGlobal({ openChatId: chatId, pendingChatId: null });
    pushChat(stack().length - 1);
    syncShown();
  });
}

/** Стрелка «Назад» в шапке: снять верхний чат; нижний — к списку чатов. */
export function closeChat(): void {
  const st = stack();
  if (st.length > 1) popTo(st.length - 2);
  else openChat(null);
}

/** Личный чат с человеком поверх текущего (автор сообщения в группе). Нет такого чата — создать. */
export async function openUserChat(userId: number): Promise<void> {
  const me = getGlobal().me;
  if (!me || userId === me.userId) return;
  const found = getGlobal().chats.find((c) => c.kind === 'direct' && c.peerId === userId);
  if (found) { openInner(found.id as number); return; }
  const id = await createDirectChat(userId);
  openInner(id);
}

/** Сдвинуть окно ленты кадра на порцию: к старым (верх) или к новым (низ). Дальняя сторона обрезается. */
export function moveWindow(dir: 'older' | 'newer' | 'latest', frameKey?: string): void {
  const f = frameKey ? frameByKey(getGlobal(), frameKey) : topReady();
  const s = f && sessions.get(f.key);
  if (!f || !s || s.moving) return;
  const ms = f.messages, meta = f.feedMeta;
  const set = (anchor: Anchor | undefined) => { s.anchor = anchor; s.moving = true; s.watch.update({ kind: 'messages', chatId: f.chatId, limit: WINDOW, anchor }); };
  if (dir === 'latest') { if (s.anchor) set(undefined); return; }
  if (!ms.length) return;
  if (dir === 'older' && meta?.hasOlder) set({ sort: ms[Math.min(ms.length - 1, FEED_PAGE - 1)].sort as number, side: 'end' });
  if (dir === 'newer' && meta?.hasNewer) set({ sort: ms[Math.max(0, ms.length - FEED_PAGE)].sort as number, side: 'start' });
}

/** Перейти к сообщению чата на экране (цитата, поиск): в окне — прокрутка, нет — окно вокруг него. */
export function focusMessage(target: { id: number; sort: number }): void {
  const f = topReady();
  const s = f && sessions.get(f.key);
  if (!f || !s) return;
  const inWindow = f.messages.some((m) => m.id === target.id);
  patchFrame(f.key, { focus: { ...target, nonce: Date.now(), replaced: !inWindow } });
  if (!inWindow) { s.anchor = { sort: target.sort, side: 'center' }; s.moving = true; s.watch.update({ kind: 'messages', chatId: f.chatId, limit: WINDOW, anchor: s.anchor }); }
}

/** Переход к сообщению выполнен — снять отметку кадра. */
export function clearFocus(frameKey: string): void { patchFrame(frameKey, { focus: null }); }

/** Лента чата ушла с якоря (своё сообщение — внизу, как в Telegram). */
function toLatestOf(chatId: number): void {
  const f = topReady();
  if (f?.chatId === chatId && sessions.get(f.key)?.anchor) moveWindow('latest', f.key);
}

/** Прежний вызов «ещё истории» — теперь сдвиг окна к старым. */
export function loadOlder(): void { moveWindow('older'); }

export async function send(chatId: number, body: string, replyToId: number | null = null, entities: Entity[] = []): Promise<void> {
  nudgeWallpaper();
  toLatestOf(chatId); // своё сообщение — внизу, как в Telegram
  await engine.call({ type: 'sendMessage', chatId, body, entities, replyToId });
}

const typingSent = new Map<number, number>();
/** «Печатаю»: не чаще раза в 3 с на чат (у собеседника отметка живёт 6 с). */
export function typing(chatId: number): void {
  const now = Date.now();
  if (now - (typingSent.get(chatId) ?? 0) < 3000) return;
  typingSent.set(chatId, now);
  engine.call({ type: 'typing', chatId }).catch(() => {});
}
/** Отправили — следующий набор снова сразу сообщит «печатаю». */
export function typingDone(chatId: number): void { typingSent.delete(chatId); }

/** Поиск сообщений (сервер; без сети — по кэшу на устройстве). */
export function searchMessages(q: string, chatId?: number, beforeId?: number): Promise<SearchResult> {
  return engine.call({ type: 'search', q, chatId, beforeId }) as Promise<SearchResult>;
}

/** Локальные копии своих файлов (objectURL) до и сразу после отправки — показываем без загрузки с сервера. */
const localPreviews = new Map<string, string>();
export function localPreview(clientId: string): string | undefined { return localPreviews.get(clientId); }

/** Размеры фото и крошечное превью (24 px, JPEG) — чтобы лента знала место заранее и показала размытую картинку. */
async function describeImage(file: Blob): Promise<{ w: number; h: number; thumb: string | null } | null> {
  if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type)) return null;
  try {
    const bmp = await createImageBitmap(file);
    const k = 24 / Math.max(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const thumb = c.toDataURL('image/jpeg', 0.5);
    const out = { w: bmp.width, h: bmp.height, thumb: thumb.length <= 4096 ? thumb : null };
    bmp.close();
    return out;
  } catch { return null; }
}

/** Отправить файл (фото — с размерами и превью). Офлайн — уйдёт, когда появится сеть. */
/** Голосовое: Ogg/Opus, длительность в секундах и волна (63 байта). Локально играет сам записанный файл. */
export async function sendVoice(chatId: number, rec: { blob: Blob; duration: number; waveform: Uint8Array }, replyToId: number | null = null): Promise<void> {
  nudgeWallpaper();
  toLatestOf(chatId);
  const res = (await engine.call({ type: 'sendFile', chatId, body: '', file: rec.blob, name: 'voice.ogg', mime: 'audio/ogg', kind: 'voice', duration: rec.duration, waveform: toBase64(rec.waveform), replyToId })) as { clientId: string };
  localPreviews.set(res.clientId, URL.createObjectURL(rec.blob));
}

/** Кружок: квадрат 400×400, до 60 с; превью — кадр из записи. */
export async function sendRound(chatId: number, rec: { blob: Blob; duration: number; size: number; thumb: string | null }, replyToId: number | null = null): Promise<void> {
  nudgeWallpaper();
  toLatestOf(chatId);
  const res = (await engine.call({ type: 'sendFile', chatId, body: '', file: rec.blob, name: 'video.mp4', mime: rec.blob.type.split(';')[0] || 'video/mp4', kind: 'round', duration: rec.duration, w: rec.size, h: rec.size, thumb: rec.thumb, replyToId })) as { clientId: string };
  localPreviews.set(res.clientId, URL.createObjectURL(rec.blob));
}

/** Голосовое или кружок прослушан (своё — нет). */
export function markListened(chatId: number, id: number): void { engine.call({ type: 'listened', chatId, id }).catch(() => {}); }

export async function sendFile(chatId: number, file: File, caption: string, replyToId: number | null = null): Promise<void> {
  nudgeWallpaper();
  toLatestOf(chatId);
  const img = await describeImage(file);
  const res = (await engine.call({ type: 'sendFile', chatId, body: caption, file, name: file.name || 'file', mime: file.type || 'application/octet-stream', w: img?.w ?? null, h: img?.h ?? null, thumb: img?.thumb ?? null, replyToId })) as { clientId: string };
  if (img) localPreviews.set(res.clientId, URL.createObjectURL(file));
}

/** Медиа или файлы чата (вкладки панели «Информация»). */
export function chatMedia(chatId: number, kind: 'photo' | 'file'): Promise<Item[]> {
  return engine.call({ type: 'chatMedia', chatId, kind }) as Promise<Item[]>;
}

/** Правка своего сообщения (онлайн). */
export function editMessage(chatId: number, id: number, body: string, entities: Entity[] = []): Promise<unknown> { return engine.call({ type: 'editMessage', chatId, id, body, entities }); }
/** Удаление своего сообщения у всех (онлайн). */
export function deleteMessage(chatId: number, id: number): Promise<unknown> { return engine.call({ type: 'deleteMessage', chatId, id }); }
/** Реакция (null — снять). У себя применяется сразу. */
export function react(chatId: number, id: number, emoji: string | null): void { engine.call({ type: 'react', chatId, id, emoji }).catch(() => {}); }

/** Черновик чата (пустой — удалить). Хранится в движке: общий для вкладок, переживает перезагрузку. */
export function saveDraft(chatId: number, text: string, entities: Entity[] = []): void {
  engine.call({ type: 'setDraft', chatId, text, entities }).catch(() => {});
}

/** Следующая страница диалогов; движок сам не пустит второй запрос, пока идёт первый. */
export function loadMoreChats(): void {
  engine.call({ type: 'loadMoreChats' }).catch(() => {});
}

export function seen(chatId: number, upToId: number): void {
  engine.call({ type: 'seen', chatId, upToId }).catch(() => {});
}

async function createDirectChat(peerId: number): Promise<number> {
  const res = await fetch('/dev/chats', { method: 'POST', body: JSON.stringify({ kind: 'direct', title: null, memberIds: [peerId] }) });
  if (!res.ok) throw new Error(res.status === 401 ? 'Сессия истекла' : 'Не удалось создать чат');
  const { id } = (await res.json()) as { id: number };
  await engine.call({ type: 'refreshChats' });
  return id;
}

export async function startDirectChat(peerId: number): Promise<void> {
  openChat(await createDirectChat(peerId));
}

/* Имена авторов: в личке это собеседник (уже есть в списке чатов), в группе — запрос /users пачкой.
   Кэш в localStorage — без сети имена тоже на месте. */
const askedNames = new Set<number>();
let namesQueue: number[] = [];
export function ensureNames(ids: number[]): void {
  const known = getGlobal().names;
  for (const id of ids) if (id && !known[id] && !askedNames.has(id)) { askedNames.add(id); namesQueue.push(id); }
  if (!namesQueue.length) return;
  queueMicrotask(flushNames);
}
async function flushNames(): Promise<void> {
  const ids = namesQueue; namesQueue = [];
  if (!ids.length) return;
  try {
    const { users } = await (await fetch('/users?ids=' + ids.join(','))).json() as { users: { id: number; name: string }[] };
    rememberNames(Object.fromEntries(users.map((u) => [u.id, u.name])));
  } catch { for (const id of ids) askedNames.delete(id); }   // без сети — спросим в следующий раз
}
function rememberNames(add: Record<number, string>): void {
  const cur = getGlobal().names;
  if (Object.entries(add).every(([id, n]) => cur[Number(id)] === n)) return;
  const names = { ...cur, ...add };
  setGlobal({ names });
  try { localStorage.setItem('relay.names', JSON.stringify(names)); } catch { /* ok */ }
}
