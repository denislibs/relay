import { showToast } from './settingsData';
import { coverThumb, readAudioTags } from './id3';
import { getPrefs } from './prefs';
import type { Block, LinkPreview, TodoInput } from '@relay/protocol';
import { playSentSound } from './sound';
import { beginHeavyAnimation, nudgeWallpaper, requestMutation, toBase64 } from '@relay/ui';
import { connectEngine, EngineClient, Mirror } from '@relay/sync-engine/src/client';
import type { Item, Patch, Query, SearchResult } from '@relay/sync-engine/src/types';
import { hideSpoilers, MAX_FILE_BYTES, type Entity } from '@relay/protocol';
import { activeFrame, frameByKey, getGlobal, setGlobal, type ChatFrame, type FeedMeta, type Me, type Status, type UploadItem } from './global';
import { bindChatDepth, popChats, pushChat } from './nav';
import { notifyIncoming, startNotify } from './notify';
import { bindMute, isMuted, startMuteMigration } from './mute';
import { startPeople, wantPeople } from './people';
import { resetMembers } from './members';
import { resetMediaTabs } from './mediaTab';
import { isSystemChat } from './ui/format';
import { asset } from './assets';
import { compressPhoto } from './media/compressPhoto';
import { compressVideo, type VideoQuality } from './media/compressVideo';

declare const __BUILD__: string;
declare const __DEV__: boolean;

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
    sharedUrl: asset('shared.worker.js'),
    dedicatedUrl: asset('dedicated.worker.js'),
  });
  engine.onReload(() => location.reload());
  startPeople(engine);
  resetMembers(); resetMediaTabs();   // вход другим пользователем без перезагрузки: кэши отрисовки прежнего — прочь
  bindMute((chatId, muteUntil) => engine.call({ type: 'setMute', chatId, muteUntil }));
  startMuteMigration();   // прежние relay.muted / relay.mutedUntil — на сервер, один раз (до первого снимка: значки не мигают)
  try { localStorage.removeItem('relay.names'); } catch { /* приватный режим */ }   // прежний кэш имён — теперь их держит движок

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
      notifyIncoming({ id: c.id as number, title: (c.title as string) || 'Чат №' + c.id, muted: isMuted(c), system: isSystemChat(c) },
        { id: last.id, body: hideSpoilers(last.body, (last as { entities?: Entity[] }).entities), kind: last.kind, attachmentName: last.attachment?.name, createdAt: last.createdAt, service: last.service });
    }
    // сразу, не дожидаясь конца анимаций: список виртуальный (≈20 строк), а отложенный подъём чата
    // после отправки выглядит как запоздалый рывок
    setGlobal({ chats: chats.list(), chatsLoaded: true });
    // открытый чат исчез из списка (меня удалили из группы, я вышел, группу удалили) — закрыть его и правую панель
    const open = getGlobal().openChatId;
    if (p.op === 'diff' && open != null && p.remove.includes('c' + open)) {
      setGlobal({ infoOpen: false });
      openChat(null);
      showToast('Чат больше недоступен');
    }
    // собеседники личных чатов — в people сразу (их имена и фото нужны ленте, медиа, поиску)
    // и авторы последних в группах («Имя:» в списке) — просим сразу с данными, а не из эффектов отрисовки
    wantPeople(chats.list().flatMap((c) => (c.kind === 'direct' ? (c.peerId ? [c.peerId as number] : [])
      : ((c.last as { senderId?: number } | null)?.senderId ? [(c.last as { senderId: number }).senderId] : []))));
    // открытый чат появился в списке — теперь известен собеседник: подписываемся на его статус
    const g = getGlobal(), current = g.pendingChatId ?? g.openChatId;
    if (current && peerFor !== current) watchPeer(current);
  });
  const counters = new Mirror();
  engine.watch({ kind: 'counters' }, (p) => { counters.apply(p); const c = counters.list()[0]; if (c) setGlobal({ counters: { unreadChats: c.unreadChats as number, unreadMessages: c.unreadMessages as number } }); });
  const status = new Mirror();
  engine.watch({ kind: 'status' }, (p) => { status.apply(p); const s = status.list()[0] as unknown as Status | undefined; if (s) { setGlobal({ status: s }); showPhase(s); } });
  const uploads = new Mirror();
  engine.watch({ kind: 'uploads' }, (p) => { uploads.apply(p); setGlobal({ uploads: uploads.list() as unknown as UploadItem[] }); });
  // закрытие вкладки, пока файл грузится: как в Telegram, спросим (очередь переживёт перезагрузку, но незагруженное придётся догружать)
  addEventListener('beforeunload', (e) => { const g = getGlobal(); if (g.preparing.length || g.uploads.some((u) => !u.uploaded)) { e.preventDefault(); e.returnValue = true; } });

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

/** Отказ сервера в загрузке по пределам (apps/server/src/domain/uploadLimits.ts): сообщение — «не отправлено», причина — тостом. */
const UPLOAD_REFUSAL: Record<string, string> = {
  upload_limit: 'Слишком много файлов загружается одновременно. Дождитесь окончания загрузки',
  upload_quota: 'Достигнут лимит загрузки файлов. Пожалуйста, повторите попытку позже',
  flood: 'Слишком много попыток. Пожалуйста, повторите попытку позже',
};
const refusalToasted = new Set<string>();
function toastUploadRefusals(items: Item[]): void {
  for (const m of items) {
    const code = m.error as string | undefined, att = m.attachment as { id?: string } | null | undefined;
    if (m.status !== 'failed' || !code || !UPLOAD_REFUSAL[code] || !att || att.id) continue;
    const key = m.key as string;
    if (refusalToasted.has(key)) continue;
    refusalToasted.add(key);
    showToast(UPLOAD_REFUSAL[code], 4000);
  }
}

/** Окно ленты кадра; onFirst — первый снимок (или 700 мс без него: не держим пользователя на прежнем чате). */
function startFeed(frame: ChatFrame, anchor: Anchor | undefined, onFirst: (patch: Partial<ChatFrame>) => void): void {
  const s: Session = { chatId: frame.chatId, mirror: new Mirror(), anchor, moving: true, first: true, timer: null, watch: null as never };
  sessions.set(frame.key, s);
  const first = (patch: Partial<ChatFrame>) => { s.first = false; if (s.timer) { clearTimeout(s.timer); s.timer = null; } onFirst(patch); };
  // лента — срочная: свои сообщения должны появляться в тот же кадр
  s.watch = engine.watch({ kind: 'messages', chatId: frame.chatId, limit: WINDOW, anchor }, (p: Patch) => {
    s.mirror.apply(p);
    // авторы пришедших сообщений — в people сразу, до отрисовки (повторы wantPeople отбрасывает сам)
    wantPeople((p.op === 'snapshot' ? p.items : p.upsert).flatMap((m) => (typeof m.senderId === 'number' ? [m.senderId] : [])));
    s.moving = false;
    const meta = (s.mirror.meta('~window') as unknown as FeedMeta) ?? null;
    const patch = { messages: s.mirror.list() as Item[], feedMeta: meta };
    toastUploadRefusals(patch.messages);
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
  const alive = () => stack().some((f) => f.key === frame.key);
  startFeed(frame, anchor, (patch) => {
    if (!alive()) return;
    // Как в Telegram Web: сначала лента рисуется и раскладывается в скрытой колонке, а переключение —
    // отдельным кадром, только смена классов. Иначе тяжёлый рендер ленты и запуск перехода — в одном кадре.
    patchFrame(frame.key, patch);
    requestAnimationFrame(() => requestMutation(() => {
      if (!alive()) return;
      beginHeavyAnimation(LEAVE_MS + 50);
      patchFrame(frame.key, { ready: true });
      setGlobal({ openChatId: chatId, pendingChatId: null });
      pushChat(stack().length - 1);
      syncShown();
    }));
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
/** «Перейти к дате»: первое сообщение с полуночи выбранного дня (по местному времени). Без сети — по уже загруженной ленте. */
export async function jumpToDate(chatId: number, day: Date): Promise<boolean> {
  const from = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  try {
    const res = await fetch(`/chats/${chatId}/messages?from=${encodeURIComponent(from.toISOString())}`);
    if (res.ok) {
      const { id } = (await res.json()) as { id: number | null };
      if (id != null) { focusMessage({ id, sort: id }); return true; }
      return false;
    }
  } catch { /* нет сети — ищем в загруженном */ }
  const f = topReady();
  const hit = f?.messages.find((m) => m.id != null && Date.parse(m.createdAt as string) >= from.getTime());
  if (hit) { focusMessage({ id: hit.id as number, sort: hit.sort as number }); return true; }
  return false;
}

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

/** Звук своей отправки (как в мобильных мессенджерах): по настройке звуков; пачка файлов — один звук, а не по штуке. */
let sentAt = 0;
export function sentSound(): void {
  const now = Date.now();
  if (now - sentAt < 400) return;
  sentAt = now;
  const p = getPrefs().notify;
  if (p.sound) playSentSound(p.volume);
}

export async function send(chatId: number, body: string, replyToId: number | null = null, entities: Entity[] = [], opts: { noLinkPreview?: boolean; link?: LinkPreview | null; blocks?: Block[] | null } = {}): Promise<void> {
  sentSound();
  nudgeWallpaper();
  toLatestOf(chatId); // своё сообщение — внизу, как в Telegram
  await engine.call({ type: 'sendMessage', chatId, body, entities, replyToId, ...opts });
}

/** Отправить текст без звука и прокрутки (приглашение в личку из управления группой). */
export async function engineSend(chatId: number, body: string): Promise<void> {
  await engine.call({ type: 'sendMessage', chatId, body, entities: [] });
}

/** Пересылка (forward.ts): копии сразу в ленте целевых чатов; в открытом чате — к низу, как своё сообщение. */
export async function forwardMessages(a: { fromChatId: number; ids: number[]; toChatIds: number[]; hideSender?: boolean; hideCaption?: boolean; comment?: { body: string; entities?: Entity[] } | null; replyToId?: number | null }): Promise<void> {
  nudgeWallpaper();
  for (const id of a.toChatIds) toLatestOf(id);
  await engine.call({ type: 'forwardMessages', ...a });
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

/**
 * Поиск сообщений: по словам на устройстве, с сетью — вместе с сервером (вся история).
 * onLocal — найденное на устройстве, сразу (если полный ответ ещё не пришёл); потом промис — полный ответ.
 */
export function searchMessages(q: string, chatId?: number, beforeId?: number, onLocal?: (r: SearchResult) => void): Promise<SearchResult> {
  let done = false;
  if (onLocal) (engine.call({ type: 'search', q, chatId, beforeId, local: true }) as Promise<SearchResult>).then((r) => { if (!done) onLocal(r); }, () => {});
  return (engine.call({ type: 'search', q, chatId, beforeId }) as Promise<SearchResult>).finally(() => { done = true; });
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

/** Видео, которое играет браузер (как VIDEO_MIME на сервере): медиа с кадром и длительностью; прочее — файлом. */
export const PLAYABLE_VIDEO = /^video\/(mp4|webm|quicktime)$/;

/**
 * Размеры кадра, длительность и превью видео (первый кадр, 48 px) — по метаданным, файл целиком не читается.
 * null — браузер не умеет это видео (кодек, повреждён): тогда оно уходит файлом, как в Telegram.
 */
export function describeVideo(file: Blob): Promise<{ w: number; h: number; duration: number; thumb: string | null } | null> {
  if (!PLAYABLE_VIDEO.test(file.type)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file), v = document.createElement('video');
    let meta: { w: number; h: number; duration: number } | null = null;
    const done = (thumb: string | null) => { clearTimeout(t); URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve(meta && { ...meta, thumb }); };
    const t = setTimeout(() => done(null), 6000);
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.onloadedmetadata = () => {
      if (!v.videoWidth || !v.videoHeight) { clearTimeout(t); URL.revokeObjectURL(url); resolve(null); return; }
      meta = { w: v.videoWidth, h: v.videoHeight, duration: Number.isFinite(v.duration) ? Math.round(v.duration) : 0 };
      v.currentTime = Math.min(0.1, (v.duration || 0) / 2);   // не нулевой кадр: у многих роликов он чёрный
    };
    v.onseeked = () => {
      try {
        const k = 48 / Math.max(v.videoWidth, v.videoHeight), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(v.videoWidth * k)); c.height = Math.max(1, Math.round(v.videoHeight * k));
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        const thumb = c.toDataURL('image/jpeg', 0.6);
        done(thumb.length <= 8000 ? thumb : null);
      } catch { done(null); }
    };
    v.onerror = () => { clearTimeout(t); URL.revokeObjectURL(url); resolve(null); };
    v.src = url;
  });
}

/** Как отправить: asFile — документом (без сжатия и превью, как «Отправить как файл» в Telegram); spoiler — фото/видео размыто;
 *  quality — видео: '720'/'1080' — пережать в браузере (WebCodecs, где есть), 'original' — как есть. */
export interface SendOpts { asFile?: boolean; spoiler?: boolean; quality?: VideoQuality }

/** Видео, которые сейчас сжимаются (ещё не в очереди движка): отмена из плашки «Сжатие видео». */
const preparing = new Map<string, AbortController>();
export function cancelPreparing(key: string): void { preparing.get(key)?.abort(); }
function setPrep(key: string, it: UploadItem | null): void {
  const rest = getGlobal().preparing.filter((x) => x.key !== key);
  setGlobal({ preparing: it ? [...rest, it] : rest });
}

/** Сжатие перед отправкой: фото — всегда (compressPhoto), видео — если выбрано качество и браузер умеет. Ошибка — оригинал; отмена — AbortError. */
async function shrinkForSend(chatId: number, file: File, quality: VideoQuality): Promise<File> {
  const t0 = performance.now();
  let out = file;
  if (/^image\//.test(file.type)) out = (await compressPhoto(file).catch(() => null))?.file ?? file;
  else if (quality !== 'original' && PLAYABLE_VIDEO.test(file.type)) {
    const key = 'prep-' + crypto.randomUUID(), ac = new AbortController();
    preparing.set(key, ac);
    const item: UploadItem = { key, chatId, name: file.name || 'video.mp4', size: file.size, kind: 'video', mime: file.type, uploaded: false, progress: 0, compressing: true };
    setPrep(key, item);
    let last = 0;
    try {
      out = await compressVideo(file, quality, (p) => { const now = performance.now(); if (now - last < 100) return; last = now; setPrep(key, { ...item, progress: p }); }, ac.signal)
        .catch((err) => { if (ac.signal.aborted) throw err; console.warn('video compress failed', err); return file; });
    } finally { preparing.delete(key); setPrep(key, null); }
  }
  if (__DEV__ && out !== file) console.info(`[send] ${file.type} ${file.size} → ${out.type} ${out.size} B (${Math.round(performance.now() - t0)} ms)`);
  return out;
}

/** Отправить файл (фото — с размерами и превью). Офлайн — уйдёт, когда появится сеть. */
/** Голосовое: Ogg/Opus, длительность в секундах и волна (63 байта). Локально играет сам записанный файл. */
export async function sendVoice(chatId: number, rec: { blob: Blob; duration: number; waveform: Uint8Array }, replyToId: number | null = null): Promise<void> {
  sentSound();
  nudgeWallpaper();
  toLatestOf(chatId);
  const res = (await engine.call({ type: 'sendFile', chatId, body: '', file: rec.blob, name: 'voice.ogg', mime: 'audio/ogg', kind: 'voice', duration: rec.duration, waveform: toBase64(rec.waveform), replyToId })) as { clientId: string };
  localPreviews.set(res.clientId, URL.createObjectURL(rec.blob));
}

/** Кружок: квадрат 400×400, до 60 с; превью — кадр из записи. */
export async function sendRound(chatId: number, rec: { blob: Blob; duration: number; size: number; thumb: string | null }, replyToId: number | null = null): Promise<void> {
  sentSound();
  nudgeWallpaper();
  toLatestOf(chatId);
  const res = (await engine.call({ type: 'sendFile', chatId, body: '', file: rec.blob, name: 'video.mp4', mime: rec.blob.type.split(';')[0] || 'video/mp4', kind: 'round', duration: rec.duration, w: rec.size, h: rec.size, thumb: rec.thumb, replyToId })) as { clientId: string };
  localPreviews.set(res.clientId, URL.createObjectURL(rec.blob));
}

/** Голосовое или кружок прослушан (своё — нет). */
/** Управление группой и вступление по ссылке: {ok, data} или {ok:false, code} (код ошибки сервера или offline). */
export type GroupResult<T = unknown> = { ok: true; data: T } | { ok: false; code: string; status?: number };
export function groupCall<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<GroupResult<T>> {
  return engine.call({ type: 'group', method, path, body }) as Promise<GroupResult<T>>;
}

export function markListened(chatId: number, id: number): void { engine.call({ type: 'listened', chatId, id }).catch(() => {}); }

export async function sendFile(chatId: number, file: File, caption: string, replyToId: number | null = null, groupId: string | null = null, opts: SendOpts = {}): Promise<void> {
  sentSound();
  nudgeWallpaper();
  toLatestOf(chatId);
  // фото — как в Telegram: до 2560 px и перекодировано (оригинал — только «как файл»); видео — по выбору «Качество»
  if (!opts.asFile) file = await shrinkForSend(chatId, file, opts.quality ?? 'original');
  const img = opts.asFile ? null : await describeImage(file);
  const vid = opts.asFile || img ? null : await describeVideo(file);
  if (vid) {
    const res = (await engine.call({ type: 'sendFile', chatId, body: caption, file, name: file.name || 'video.mp4', mime: file.type, kind: 'video', w: vid.w, h: vid.h, duration: vid.duration, thumb: vid.thumb, replyToId,
      ...(opts.spoiler ? { spoiler: true } : {}), ...(groupId ? { groupId } : {}) })) as { clientId: string };
    // своё видео играет из самого файла, пока грузится (как в Telegram) и сразу после
    localPreviews.set(res.clientId, URL.createObjectURL(file));
    return;
  }
  const seconds = img || opts.asFile ? null : await audioDuration(file);
  // музыка: название, исполнитель и обложка из тегов (как в Telegram); обложка — превью 96 px
  const tags = seconds ? await readAudioTags(file) : null;
  const cover = tags?.cover ? await coverThumb(tags.cover) : null;
  const res = (await engine.call({ type: 'sendFile', chatId, body: caption, file, name: file.name || 'file', mime: file.type || 'application/octet-stream', w: img?.w ?? null, h: img?.h ?? null, thumb: img?.thumb ?? cover ?? null, replyToId,
    ...(seconds ? { kind: 'audio' as const, duration: seconds, title: tags?.title ?? null, performer: tags?.performer ?? null } : {}),
    ...(img && opts.spoiler ? { spoiler: true } : {}), ...(groupId ? { groupId } : {}) })) as { clientId: string };
  if (img) localPreviews.set(res.clientId, URL.createObjectURL(file));
}

/** Файлы больше предела (2 ГБ, как в Telegram): их не ставим в очередь — сервер всё равно откажет. Тост — здесь. */
export function rejectTooBig(files: File[]): File[] {
  const ok = files.filter((f) => f.size <= MAX_FILE_BYTES);
  if (ok.length < files.length) showToast(files.length === 1 ? 'Файл слишком большой — можно отправлять файлы до 2 ГБ' : 'Файлы больше 2 ГБ не отправить — остальные отправлены');
  return ok;
}

/** Неотправленное сообщение: отправить ещё раз (после отказа) или убрать совсем (идущая загрузка прервётся). */
export function retrySend(clientId: string): void { refusalToasted.delete(clientId); engine.call({ type: 'retry', clientId }).catch(() => {}); }
export function discardUnsent(clientId: string): void {
  const url = localPreviews.get(clientId);
  if (url) { URL.revokeObjectURL(url); localPreviews.delete(clientId); }
  engine.call({ type: 'discard', clientId }).catch(() => {});
}

/** Файлов в одном альбоме (пузыре), как в Telegram. */
const ALBUM_MAX = 10;
/** Несколько файлов разом — одной группой (в ленте один пузырь, как альбом в Telegram); подпись — у последнего. */
export async function sendFiles(chatId: number, files: File[], caption: string, replyToId: number | null = null, opts: SendOpts = {}): Promise<void> {
  files = rejectTooBig(files);
  if (!files.length) return;
  sentSound();
  if (files.length === 1) return sendFile(chatId, files[0], caption, replyToId, null, opts);
  // отменённое сжатие одного видео (× в плашке) не отменяет остальные файлы альбома
  const skipCancelled = (e: unknown) => { if ((e as Error)?.name !== 'AbortError') throw e; };
  // как в Telegram: альбомы по 10; подпись — у последнего файла последнего альбома
  let groupId = '';
  for (let i = 0; i < files.length; i++) {
    if (i % ALBUM_MAX === 0) groupId = files.length - i > 1 ? crypto.randomUUID() : '';
    await sendFile(chatId, files[i], i === files.length - 1 ? caption : '', i === 0 ? replyToId : null, groupId || null, opts).catch(skipCancelled);
  }
}

/** Уже загруженный трек (из музыки профиля) — в чат без новой загрузки: тот же файл по id. */
export async function sendTrack(chatId: number, attachment: { id: string; kind: 'audio'; mime: string; name: string; size: number; w: null; h: null; duration: number | null; title?: string | null }, replyToId: number | null = null): Promise<void> {
  sentSound();
  toLatestOf(chatId);
  await engine.call({ type: 'sendMessage', chatId, body: '', attachment, replyToId });
}

/** Вкладка «Общих медиа» панели «Информация» (содержимое — подписка media, см. mediaTab.ts). */
export type MediaTab = 'media' | 'file' | 'audio' | 'voice' | 'link';

/** Длительность аудиофайла по метаданным (без проигрывания): музыка в ленте и во вкладке «Музыка». */
function audioDuration(file: File): Promise<number | null> {
  if (!/^audio\//.test(file.type)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file), a = new Audio();
    const done = (v: number | null) => { URL.revokeObjectURL(url); a.removeAttribute('src'); resolve(v); };
    const t = setTimeout(() => done(null), 5000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => { clearTimeout(t); done(Number.isFinite(a.duration) && a.duration >= 1 ? a.duration : null); };
    a.onerror = () => { clearTimeout(t); done(null); };
    a.src = url;
  });
}

/** Правка своего сообщения (онлайн). */
export function editMessage(chatId: number, id: number, body: string, entities: Entity[] = []): Promise<unknown> { return engine.call({ type: 'editMessage', chatId, id, body, entities }); }
/** Удаление своего сообщения у всех (онлайн). */
export function deleteMessage(chatId: number, id: number): Promise<unknown> { return engine.call({ type: 'deleteMessage', chatId, id }); }
/** Реакция (null — снять). У себя применяется сразу. */
export function react(chatId: number, id: number, emoji: string | null): void { engine.call({ type: 'react', chatId, id, emoji }).catch(() => {}); }

/* ---------- чек-листы ---------- */
export async function sendTodo(chatId: number, todo: TodoInput, replyToId: number | null = null): Promise<void> {
  nudgeWallpaper();
  toLatestOf(chatId);
  await engine.call({ type: 'sendTodo', chatId, todo, replyToId });
}
/** Отметка у себя — сразу; ошибка (нет прав, нет сети) — откат и false. */
export function toggleTodo(chatId: number, id: number, itemId: number, done: boolean): Promise<boolean> {
  return engine.call({ type: 'todoToggle', chatId, id, itemId, done }).then(() => true, () => false);
}
export function appendTodo(chatId: number, id: number, items: string[]): Promise<unknown> { return engine.call({ type: 'todoAppend', chatId, id, items }); }
export function editTodo(chatId: number, id: number, todo: TodoInput): Promise<unknown> { return engine.call({ type: 'todoEdit', chatId, id, todo }); }

/** Нажатие кнопки под сообщением: ответ сервера — тост (если он есть); правка сообщения придёт журналом. */
export function pressButton(chatId: number, id: number, data: string): Promise<void> {
  return engine.call({ type: 'pressButton', chatId, id, data }).then(
    (r) => { const toast = (r as { toast?: string } | null)?.toast; if (toast) showToast(toast); },
    (e) => { showToast((e as Error)?.message === 'offline' ? 'Нет соединения — попробуйте, когда появится сеть' : 'Не получилось — попробуйте ещё раз'); });
}

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

export async function createDirectChat(peerId: number): Promise<number> {
  // существующая личная переписка или новая (сервер не создаёт вторую на ту же пару)
  const res = await fetch('/chats/direct', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: peerId }) });
  if (!res.ok) throw new Error(res.status === 401 ? 'Сессия истекла' : 'Не удалось создать чат');
  const { id } = (await res.json()) as { id: number };
  await engine.call({ type: 'refreshChats' });
  return id;
}

/** Новая группа: сервер создаёт чат и служебное «создал(а) группу» — по нему чат появится у всех участников. */
export async function createGroup(title: string, memberIds: number[]): Promise<number> {
  const res = await fetch('/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, memberIds }) });
  if (!res.ok) {
    const code = ((await res.json().catch(() => ({}))) as { code?: string }).code;
    throw new Error(code === 'blocked' ? 'Кого-то из выбранных нельзя добавить в группу'
      : code === 'too_long' ? 'Слишком длинное название или слишком много участников'
      : code === 'not_found' ? 'Кого-то из выбранных больше нет в Relay'
      : res.status === 401 ? 'Сессия истекла' : 'Не удалось создать группу');
  }
  const { id } = (await res.json()) as { id: number };
  await engine.call({ type: 'refreshChats' });
  return id;
}

export async function startDirectChat(peerId: number): Promise<void> {
  openChat(await createDirectChat(peerId));
}

/* ---------- закреплённые сообщения ---------- */
export const pinMessage = (chatId: number, id: number) => engine.call({ type: 'pin', chatId, id }).catch(() => { showToastLazy('Не удалось закрепить — нет сети?'); });
export const unpinMessage = (chatId: number, id: number | null) => engine.call({ type: 'unpin', chatId, id }).catch(() => { showToastLazy('Не удалось открепить — нет сети?'); });
export const messagesByIds = (chatId: number, ids: number[]) => engine.call({ type: 'messagesByIds', chatId, ids }) as Promise<Item[]>;
function showToastLazy(text: string): void { void import('./settingsData').then((m) => m.showToast(text)); }
