import { bindStickers } from './stickers';
import { showToast } from './settingsData';
import { coverThumb, readAudioTags } from './id3';
import { getPrefs } from './prefs';
import type { Block, LinkPreview, ThreadGuest, TodoInput } from '@relay/protocol';
import { playSentSound } from './sound';
import { beginHeavyAnimation, nudgeWallpaper, requestMutation, toBase64 } from '@relay/ui';
import { connectEngine, EngineClient, Mirror } from '@relay/sync-engine/src/client';
import type { Item, Patch, Query, SearchResult } from '@relay/sync-engine/src/types';
import { hideSpoilers, MAX_FILE_BYTES, type Entity } from '@relay/protocol';
import { activeFrame, findChat, frameByKey, getGlobal, setGlobal, subscribeGlobal, type ChatFrame, type FeedMeta, type Me, type Status, type UploadItem } from './global';
import { closeLayer, closeLayers, pushLayer } from './nav';
import { notifyIncoming, startNotify } from './notify';
import { rememberKeysIn, startFileKeyService } from './fileKeys';
import { bindMute, isMuted, startMuteMigration } from './mute';
import { bindChatFlags, clearUnreadMark } from './chatFlags';
import { startPeople, wantPeople } from './people';
import { resetMembers } from './members';
import { resetCommonGroups } from './commonGroups';
import { resetMediaTabs } from './mediaTab';
import { isSystemChat } from './ui/format';
import { asset } from './assets';
import { compressPhoto } from './media/compressPhoto';
import { compressVideo, type VideoQuality } from './media/compressVideo';
import { isOwnChannelPost, postCopyChannel } from './channelText';
import { baseOf, findTarget, hashFor, parseHash, positionKey, sameTarget, toTarget, type StackTarget } from './stackTarget';

declare const __BUILD__: string;
declare const __DEV__: boolean;

let engine: EngineClient;
// порция ленты — два экрана сообщений (строка-бабл ≈ 40 px), не меньше 30: как и страница диалогов, от высоты окна
const FEED_PAGE = Math.max(30, Math.ceil((typeof innerHeight === 'number' ? innerHeight : 0) / 40) * 2);   // вне браузера (тесты) — минимум

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
  // ключи зашифрованных вложений — запомнить до того, как ленты их отрисуют (Service Worker расшифровывает /files/<id>)
  engine.onData(rememberKeysIn);
  startFileKeyService();
  startPeople(engine);
  resetMembers(); resetMediaTabs(); resetCommonGroups();   // вход другим пользователем без перезагрузки: кэши отрисовки прежнего — прочь
  bindMute((chatId, muteUntil) => engine.call({ type: 'setMute', chatId, muteUntil }));
  bindChatFlags((chatId, f) => engine.call({ type: 'setChatFlags', chatId, ...f }));
  bindStickers((a) => engine.call(a as never));
  startMuteMigration();   // прежние relay.muted / relay.mutedUntil — на сервер, один раз (до первого снимка: значки не мигают)
  // позиции прокрутки из IndexedDB — до первого открытия чата (ответ движка приходит раньше списка чатов)
  void engine.call({ type: 'positions' }).then((r) => { for (const [k, v] of Object.entries((r as Record<string, { key: string; sort: number; offset: number }>) ?? {})) if (!dirtyPositions.has(k)) positions.set(k, v); }).catch(() => { /* без кэша — как раньше, только память */ });
  addEventListener('pagehide', flushPositions);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPositions(); });
  try { localStorage.removeItem('relay.names'); } catch { /* приватный режим */ }   // прежний кэш имён — теперь их держит движок

  const chats = new Mirror();
  engine.watch({ kind: 'chatList', limit: 1000 }, (p) => {
    chats.apply(p);
    // сразу, не дожидаясь конца анимаций: список виртуальный (≈20 строк), а отложенный подъём чата
    // после отправки выглядит как запоздалый рывок
    setGlobal({ chats: chats.list(), chatsLoaded: true });
    settlePreviews();
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
  watchPreviews();
  watchNotifications(me.userId);
  const counters = new Mirror();
  engine.watch({ kind: 'counters' }, (p) => { counters.apply(p); const c = counters.list()[0]; if (c) setGlobal({ counters: { unreadChats: c.unreadChats as number, unreadMessages: c.unreadMessages as number } }); });
  const status = new Mirror();
  engine.watch({ kind: 'status' }, (p) => { status.apply(p); const s = status.list()[0] as unknown as Status | undefined; if (s) { setGlobal({ status: s }); showPhase(s); } });
  const uploads = new Mirror();
  engine.watch({ kind: 'uploads' }, (p) => { uploads.apply(p); setGlobal({ uploads: uploads.list() as unknown as UploadItem[] }); });
  // закрытие вкладки, пока файл грузится: как в Telegram, спросим (очередь переживёт перезагрузку, но незагруженное придётся догружать)
  addEventListener('beforeunload', (e) => { const g = getGlobal(); if (g.preparing.length || g.uploads.some((u) => !u.uploaded)) { e.preventDefault(); e.returnValue = true; } });

  // запись истории могла вернуть прежний адрес (#chat=…) — поправить на чат на экране
  addEventListener('popstate', () => queueMicrotask(syncShown));
  startNotify((id, threadId) => { focus(); openNotified(id, threadId); });
  // #chat=…&thread=… при загрузке: нижний слой — чат (тред гостя, &via= — канал поста), тред — поверх него (docs/navigation-rules.md)
  const open = parseHash(location.hash);
  if (open) { openChat(baseOf(open)); if (open.threadId != null) whenShown(baseOf(open), () => openInner(open)); }
}

/**
 * Клик по уведомлению: чат — нижним слоем (замена стека, docs/navigation-rules.md), комментарий — его тред поверх
 * группы, как адрес с thread. Тред уже наверху — ничего; группа уже нижняя и одна — openChat ничего не меняет, тред
 * кладётся сразу.
 */
function openNotified(chatId: number, threadId?: number): void {
  const top = activeFrame(getGlobal());
  if (threadId != null && top?.chatId === chatId && top.threadId === threadId) return;
  openChat(chatId);
  if (threadId == null) return;
  const g = getGlobal(), now = activeFrame(g);
  if (g.pendingChatId == null && now?.chatId === chatId && now.threadId == null) openInner({ chatId, threadId });
  else whenShown(chatId, () => openInner({ chatId, threadId }));
}

/** Когда чат станет нижним на экране (адрес при загрузке: тред кладётся поверх уже открытой группы). */
function whenShown(chatId: number, fn: () => void): void {
  const stop = subscribeGlobal(() => {
    const g = getGlobal(), top = activeFrame(g);
    if (top?.chatId === chatId && top.threadId == null) { stop(); queueMicrotask(fn); return; }
    if (g.pendingChatId == null && top) stop();   // открыли что-то другое — тред уже не нужен
  });
}

/**
 * Уведомления и звук — по запросу notifications движка: одно на сообщение (новое чужое или упоминание — что пришло
 * первым), а не по патчам списка чатов (иначе упоминание и сообщение дали бы два). Снимок при подключении вкладки —
 * старое, не новость.
 */
function watchNotifications(meId: number): void {
  const m = new Mirror();
  let shown: Set<string> | null = null;
  engine.watch({ kind: 'notifications' }, (p) => {
    m.apply(p);
    const items = m.list();
    if (!shown) { shown = new Set(items.map((n) => n.key)); return; }
    const g = getGlobal();
    const chatOf = (id: number) => {
      const c = g.chats.find((x) => x.id === id);
      return c ? { id, kind: c.kind, canPost: !!c.canSend, member: c.me != null, linkedChatId: (c.group as { linkedChatId?: number | null } | null)?.linkedChatId ?? null } : undefined;
    };
    for (const n of items) {
      if (shown.has(n.key)) continue;
      shown.add(n.key);
      const chatId = n.chatId as number;
      if (n.senderId === meId && !n.post) continue;
      const item = { chatId, post: !!n.post, mention: !!n.mention };
      // копия поста в группе обсуждения: подписчик канала уже уведомлён самим постом; открыт канал — пост на экране
      const copyOf = postCopyChannel(item, chatOf);
      if (copyOf?.member) continue;
      if ((chatId === g.openChatId || (copyOf && copyOf.id === g.openChatId)) && document.visibilityState === 'visible') continue;
      if (isOwnChannelPost(item, chatOf)) continue;   // свои посты и их копии
      const c = g.chats.find((x) => x.id === chatId);
      notifyIncoming({ id: chatId, title: (c?.title as string) || 'Чат №' + chatId, muted: isMuted(c ?? { id: chatId }), system: isSystemChat(c) },
        { id: n.id as number, body: hideSpoilers(String(n.body ?? ''), n.entities as Entity[] | undefined), kind: n.kind as string | undefined, attachmentName: n.attachmentName as string | null, createdAt: n.createdAt as string, service: n.service as { type: string } | undefined, threadId: n.threadId as number | undefined },
        { mention: !!n.mention });
    }
    // держим только ключи, что ещё в списке движка (он сам хранит последние)
    if (shown.size > items.length * 2 + 50) shown = new Set(items.map((n) => n.key));
  });
}

const PHASE_LABEL: Record<string, string> = {
  connecting: 'Подключение…',
  loading: 'Загрузка чатов…',
  updating: 'Обновление…',
  offline: 'Ожидание сети…',
};
const MIN_LABEL_MS = 600;
// как в Telegram Web K: первые 2 с после старта стадию не показываем (подключение обычно успевает), а пока
// надписи нет, новая появляется через 400 мс — короткие «Обновление…» не мигают
const BOOT_QUIET_MS = 2000, SHOW_DELAY_MS = 400;
const bootAt = performance.now();
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
  if (want !== null) {
    const now = performance.now();
    if (shown !== null) { labelSince = now; setGlobal({ syncLabel: want }); return; }   // уже видна — меняем сразу
    labelTimer = setTimeout(() => { labelTimer = null; labelSince = performance.now(); setGlobal({ syncLabel: want }); },
      Math.max(SHOW_DELAY_MS, bootAt + BOOT_QUIET_MS - now));
    return;
  }
  labelTimer = setTimeout(() => { labelTimer = null; setGlobal({ syncLabel: null }); }, Math.max(0, MIN_LABEL_MS - (performance.now() - labelSince)));
}

let peerWatch: { close(): void } | null = null;
let peerFor: number | null = null;   // для какого чата подписка уже решена (есть собеседник или это группа)

/** Присутствие собеседника личного чата — отдельная маленькая подписка, живёт, пока чат открыт. */
function watchPeer(chatId: number | null): void {
  peerWatch?.close();
  peerWatch = null;
  peerFor = null;
  const chat = chatId ? findChat(getGlobal(), chatId) : undefined;
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
/** Позиция прокрутки чата (и треда — свой ключ chatId:threadId) при уходе: первый видимый бабл и его отступ (нет записи — был внизу).
 *  В памяти — сразу; в IndexedDB движка — через секунду после последней записи и при уходе со страницы: после
 *  перезагрузки чат откроется на том же месте, окно ленты запросится с якорем и придёт из кэша без сети. */
const positions = new Map<string, { key: string; sort: number; offset: number }>();
const dirtyPositions = new Set<string>();
let positionsTimer: ReturnType<typeof setTimeout> | null = null;
function flushPositions(): void {
  if (positionsTimer) { clearTimeout(positionsTimer); positionsTimer = null; }
  for (const k of dirtyPositions) void engine.call({ type: 'setPosition', key: k, pos: positions.get(k) ?? null }).catch(() => { /* кэш недоступен — позиция останется в памяти */ });
  dirtyPositions.clear();
}
export function savePosition(t: StackTarget, pos: { key: string; sort: number; offset: number } | null): void {
  const k = positionKey(t);
  const had = positions.get(k);
  if (pos) positions.set(k, pos); else positions.delete(k);
  if (!pos && !had) return;   // внизу и записи не было — нечего стирать
  dirtyPositions.add(k);
  if (!positionsTimer) positionsTimer = setTimeout(flushPositions, 1000);
}
export function savedPosition(t: StackTarget) { return positions.get(positionKey(t)) ?? null; }

/* ---------- стек чатов ----------
 * Как в Telegram Web: openChat (клик в списке) — нижний чат, стек сбрасывается; openInner (переход
 * изнутри чата) — новый чат поверх, прежний остаётся живым в DOM (вернуться — мгновенно, на том же месте).
 * У каждого кадра — своя подписка на окно ленты. */

interface Session { chatId: number; threadId?: number; watch: { update(q: Query): void; close(): void }; mirror: Mirror; anchor: Anchor | undefined; moving: boolean; first: boolean; timer: ReturnType<typeof setTimeout> | null }
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
  // кадр снимают из стека после закрытия ленты: превью проверяем, когда стек уже обновлён
  queueMicrotask(() => releasePreview(s.chatId));
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
  const s: Session = { chatId: frame.chatId, threadId: frame.threadId, mirror: new Mirror(), anchor, moving: true, first: true, timer: null, watch: null as never };
  sessions.set(frame.key, s);
  const asked = performance.now();
  // сколько лента ждала первый снимок от движка (SharedWorker → IndexedDB → сюда) — видно во вкладке Performance
  const first = (patch: Partial<ChatFrame>) => { s.first = false; if (s.timer) { clearTimeout(s.timer); s.timer = null; } performance.measure('relay:feed-snapshot', { start: asked }); onFirst(patch); };
  // лента — срочная: свои сообщения должны появляться в тот же кадр
  s.watch = engine.watch(feedQuery(frame, anchor), (p: Patch) => {
    s.mirror.apply(p);
    // авторы пришедших сообщений — в people сразу, до отрисовки (повторы wantPeople отбрасывает сам)
    wantPeople((p.op === 'snapshot' ? p.items : p.upsert).flatMap((m) => (typeof m.senderId === 'number' ? [m.senderId] : [])));
    s.moving = false;
    const patch = mirrorPatch(s);
    const meta = patch.feedMeta ?? null;
    toastUploadRefusals(patch.messages!);
    if (s.first) first(patch); else patchFrame(frame.key, patch);
    if (patch.thread?.guest && topReady()?.key === frame.key) syncShown();   // тред гостя узнан позже — в адрес канал (&via=)
    // окно дошло до последних сообщений — снова живой хвост (новые сообщения появятся сами)
    if (s.anchor && meta?.live && !meta.hasNewer) { s.anchor = undefined; s.watch.update(feedQuery(frame, undefined)); }
  });
  s.timer = setTimeout(() => { if (s.first) first({}); }, 700);
}

/** Лента кадра из зеркала подписки: сообщения, окно и (тред) шапка, загружен ли, гость ли я. */
function mirrorPatch(s: Session): Partial<ChatFrame> {
  const patch: Partial<ChatFrame> = { messages: s.mirror.list() as Item[], feedMeta: (s.mirror.meta('~window') as unknown as FeedMeta) ?? null };
  // тред: шапка (копия поста) первой; загружен ли с сервера (пока нет — «Загрузка…», а не «нет комментариев»)
  if (s.threadId != null) { const th = s.mirror.meta('~thread'); patch.thread = { header: (th?.header as string | null) ?? null, loaded: !!th?.loaded, guest: (th?.guest as ThreadGuest | undefined) ?? null }; }
  return patch;
}

/** Окно ленты кадра: чат — messages, тред — thread (шапка-копия поста и комментарии из кэша группы). */
function feedQuery(f: { chatId: number; threadId?: number }, anchor: Anchor | undefined): Query {
  return f.threadId != null ? { kind: 'thread', chatId: f.chatId, threadId: f.threadId, limit: WINDOW, anchor } : { kind: 'messages', chatId: f.chatId, limit: WINDOW, anchor };
}

function newFrame(t: StackTarget, target?: { id: number; sort: number }): { frame: ChatFrame; anchor: Anchor | undefined } {
  const chatId = t.chatId;
  const chat = findChat(getGlobal(), chatId);
  const pos = positions.get(positionKey(t));
  // разделитель «Непрочитанные» — только у ленты чата (у треда своя прочитанность, readMaxId)
  const unread = t.threadId == null && (chat?.unread as number) > 0 ? (chat!.lastReadId as number) : null;
  // открыть на найденном сообщении; иначе: ушли из середины истории — туда же; непрочитанное; низ
  const anchor: Anchor | undefined = target ? { sort: target.sort, side: 'center' } : pos ? { sort: pos.sort, side: 'center' } : unread != null ? { sort: unread + 0.5, side: 'center' } : undefined;
  const frame: ChatFrame = {
    key: 'c' + ++frameSeq, chatId, ...(t.threadId != null ? { threadId: t.threadId, thread: { header: null, loaded: false } } : {}), ready: false, messages: [], feedMeta: null,
    unreadFrom: target ? null : unread,
    focus: target ? { ...target, nonce: Date.now(), replaced: true } : null,
  };
  return { frame, anchor };
}

/** Адрес и присутствие — по чату на экране. */
function syncShown(): void {
  const top = topReady();
  // тред гостя: в адресе и канал поста (&via=) — перезагрузка положит под тред канал, а не группу, где я не состою
  if (!top) history.replaceState(history.state, '', location.pathname);
  else {
    const hash = hashFor({ chatId: top.chatId, threadId: top.threadId, via: top.thread?.guest?.channelId });
    if (location.hash !== hash) history.replaceState(history.state, '', hash);
  }
  const thread = top?.threadId ?? null;
  if (getGlobal().openThreadId !== thread) setGlobal({ openThreadId: thread });
  if ((top?.chatId ?? null) !== peerFor) watchPeer(top?.chatId ?? null);
  if (top) clearUnreadMark(top.chatId);   // открыли чат, отмеченный непрочитанным, — пометка снята (как в Telegram)
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

/* Снятые со стека колонки не уничтожаются сразу: доиграв уход, ждут скрытыми (с живой подпиской на ленту) до
 * PARK_MS, не больше PARK_MAX. Вернулись в тот же чат — колонка встаёт обратно без подготовки, на той же прокрутке. */
const PARK_MS = 60_000;
const PARK_MAX = 2;
const parkTimers = new Map<string, ReturnType<typeof setTimeout>>();

function dropParked(keys?: string[]): void {
  const drop = getGlobal().chatLeaving.filter((f) => !keys || keys.includes(f.key));
  if (!drop.length) return;
  for (const f of drop) { closeSession(f.key); clearTimeout(parkTimers.get(f.key)); parkTimers.delete(f.key); }
  setGlobal((s) => ({ chatLeaving: s.chatLeaving.filter((f) => !drop.includes(f)) }));
}

/** Снять со стека всё выше index (анимация ухода). */
function popTo(index: number): void {
  const st = stack();
  const removed = st.slice(index + 1);
  if (!removed.length || index < 0) return;
  const parked = removed.filter((f) => f.ready);
  removed.filter((f) => !f.ready).forEach((f) => closeSession(f.key));
  beginHeavyAnimation(LEAVE_MS + 50);
  setGlobal((s) => ({ chatStack: s.chatStack.slice(0, index + 1), chatLeaving: [...s.chatLeaving, ...parked], openChatId: s.chatStack[index].chatId, pendingChatId: null }));
  for (const f of parked) parkTimers.set(f.key, setTimeout(() => dropParked([f.key]), PARK_MS));
  // лишние (самые давние) — после ухода, чтобы не оборвать его анимацию
  const extra = getGlobal().chatLeaving.slice(0, -PARK_MAX).map((f) => f.key);
  if (extra.length) setTimeout(() => dropParked(extra), LEAVE_MS);
  for (const f of removed) dropLayer(f.key);
  syncShown();
}

/** Вернуть припаркованную колонку наверх стека: подготовка не нужна — только переход. */
function revive(parked: ChatFrame, target?: { id: number; sort: number }): void {
  clearTimeout(parkTimers.get(parked.key)); parkTimers.delete(parked.key);
  // запаркованный кадр патчей не получает (patchFrame — только стек), а подписка жива: что пришло за это время — из зеркала
  const s = sessions.get(parked.key);
  const frame: ChatFrame = s && !s.first ? { ...parked, ...mirrorPatch(s) } : parked;
  beginHeavyAnimation(LEAVE_MS + 50);
  setGlobal((g) => ({ chatStack: [...g.chatStack, frame], chatLeaving: g.chatLeaving.filter((f) => f.key !== frame.key), openChatId: frame.chatId, pendingChatId: null }));
  addLayer(frame.key);
  syncShown();
  if (target) focusMessage(target);
}

/* Чат поверх чата — свой слой навигации (запись истории): «Назад» браузера и Esc снимают его кадр и всё выше. */
const layerOf = new Map<string, number>();
function addLayer(key: string): void {
  layerOf.set(key, pushLayer('chat', () => {
    cancelPending();
    const at = stack().findIndex((f) => f.key === key);
    if (at > 0) popTo(at - 1);
  }, key));
}
/** Кадр сняли из интерфейса — его запись больше не нужна (уже снятая «Назад» — без изменений). */
function dropLayer(key: string): void {
  const id = layerOf.get(key);
  layerOf.delete(key);
  if (id) closeLayer(id);
}
function dropLayers(): void {
  layerOf.clear();
  closeLayers('chat');
}

/* ---------- превью публичного канала (без подписки) ----------
 * Как в Telegram: канал с @именем открывается и без подписки — лента для чтения, внизу «Подписаться». Строка
 * канала живёт в движке как превью (подписка previews → global.previews, findChat), в списке её нет. Лента ушла
 * со стека (и из припаркованных) — превью закрывается. Подписался — строка переходит из previews в chats; пока
 * chatList её не принёс, прежняя строка превью держится (шапка не мигает «Чат №N»), в ленте — «Вы подписались». */

const previewMirror = new Mirror();
/** Превью, исчезнувшие из движка: ждём строку списка (подписался) или признаём канал недоступным. */
const previewGone = new Map<number, ReturnType<typeof setTimeout>>();

function watchPreviews(): void {
  engine.watch({ kind: 'previews' }, (p) => {
    previewMirror.apply(p);
    const live = previewMirror.list();
    const g = getGlobal();
    // ушедшее из движка — держим, пока на экране и строки в списке ещё нет (вступление: chatList догоняет)
    const held = g.previews.filter((x) => !live.some((y) => y.id === x.id) && !g.chats.some((c) => c.id === x.id) && onStack(x.id as number));
    for (const x of held) if (!previewGone.has(x.id as number)) previewGone.set(x.id as number, setTimeout(() => dropGonePreview(x.id as number), 1500));
    setGlobal({ previews: [...live, ...held] });
  });
}

const onStack = (chatId: number): boolean => {
  const g = getGlobal();
  return g.chatStack.some((f) => f.chatId === chatId) || g.chatLeaving.some((f) => f.chatId === chatId) || pendingBottom?.frame.chatId === chatId;
};

/** Список принёс чат, который был превью: подписались — строка превью больше не нужна; лента отмечает вступление. */
function settlePreviews(): void {
  const g = getGlobal();
  const joined = g.previews.filter((x) => g.chats.some((c) => c.id === x.id));
  if (!joined.length) return;
  for (const x of joined) {
    clearTimeout(previewGone.get(x.id as number)); previewGone.delete(x.id as number);
    for (const f of [...g.chatStack, ...g.chatLeaving]) {
      if (f.chatId !== x.id || f.threadId != null) continue;
      const last = f.messages.reduce((n, m) => (typeof m.id === 'number' && m.id > n ? m.id : n), 0);
      patchFrame(f.key, { joinedAfter: last });
    }
  }
  setGlobal((s) => ({ previews: s.previews.filter((x) => !joined.includes(x)) }));
}

/** Превью пропало, а в список канал не пришёл: удалили или закрыли — снять его ленты со стека, как исчезнувший чат. */
function dropGonePreview(chatId: number): void {
  previewGone.delete(chatId);
  const g = getGlobal();
  if (g.chats.some((c) => c.id === chatId)) return;
  setGlobal((s) => ({ previews: s.previews.filter((x) => x.id !== chatId || previewMirror.list().some((y) => y.id === chatId)) }));
  if (!onStack(chatId)) return;
  showToast('Канал больше недоступен');
  const st = stack(), at = st.findIndex((f) => f.chatId === chatId);
  if (at === 0) { setGlobal({ infoOpen: false }); openChat(null); } else if (at > 0) popTo(at - 1);
  dropParked(getGlobal().chatLeaving.filter((f) => f.chatId === chatId).map((f) => f.key));
}

/** Лента чата закрыта: если это было превью и других его лент нет — движок отписывается и забывает его. */
function releasePreview(chatId: number): void {
  if (!getGlobal().previews.some((x) => x.id === chatId) || onStack(chatId) || [...sessions.values()].some((s) => s.chatId === chatId)) return;
  engine.call({ type: 'closePreview', chatId }).catch(() => {});   // строку превью уберёт подписка previews
}

/**
 * Открыть публичный канал: подписан — как обычный чат; нет — превью (лента для чтения, «Подписаться»). from —
 * откуда (docs/navigation-rules.md): left — левая колонка (поиск) заменяет стек, inner — ссылка в чате кладёт поверх.
 * false — открыть нечего (приватный канал, удалён, нет сети): тост уже показан.
 */
export function openChannel(chatId: number, from: 'left' | 'inner'): Promise<boolean> {
  // двойной клик (или ссылка, нажатая дважды) — тот же переход, не второй
  let p = channelOpening.get(chatId);
  if (!p) {
    p = openChannelOnce(chatId, from).finally(() => channelOpening.delete(chatId));
    channelOpening.set(chatId, p);
  }
  return p;
}
const channelOpening = new Map<number, Promise<boolean>>();
/** Номер последнего перехода: открыли что-то другое, пока ждали сервер, — запоздалый переход в канал отменяется. */
let openSeq = 0;

async function openChannelOnce(chatId: number, from: 'left' | 'inner'): Promise<boolean> {
  const open = () => { if (from === 'left') openChat(chatId); else openInner(chatId); };
  if (getGlobal().chats.some((c) => c.id === chatId)) { open(); return true; }
  const tok = ++openSeq;
  const r = await engine.call({ type: 'openPreview', chatId }) as { member: boolean; requested: boolean } | { error: string };
  if ('error' in r) {
    if (tok === openSeq) showToast(r.error === 'offline' ? 'Нет сети — канал откроется, когда связь вернётся' : r.error === 'not_found' ? 'Канал удалён'
      : r.error === 'flood' ? 'Открыто слишком много каналов без подписки — закройте какие-нибудь' : 'Канал недоступен');
    return false;
  }
  if (!r.member) {
    // строка превью — сразу в global (подписка previews придёт следующим кадром): шапка новой колонки уже с названием
    await new Promise<void>((res) => { if (getGlobal().previews.some((x) => x.id === chatId)) res(); else { const stop = subscribeGlobal(() => { if (getGlobal().previews.some((x) => x.id === chatId)) { stop(); res(); } }); setTimeout(() => { stop(); res(); }, 500); } });
  }
  // пока ждали, пользователь ушёл в другой чат — не перебиваем его; превью, которое так и не открылось, — закрыть
  if (tok !== openSeq) {
    if (!r.member && !onStack(chatId) && ![...sessions.values()].some((s) => s.chatId === chatId)) engine.call({ type: 'closePreview', chatId }).catch(() => {});
    return false;
  }
  open();
  return true;
}

/** Строку превью — заново с сервера (заявка подана: «Заявка отправлена» держится и при повторном открытии). */
export function refreshPreview(chatId: number): void { engine.call({ type: 'openPreview', chatId }).catch(() => {}); }

/** Чат из списка (или из адреса, уведомления): нижний кадр, стек сбрасывается. */
export function openChat(chatId: number | null, target?: { id: number; sort: number }, hold?: Hold): void {
  openSeq++;   // любой переход отменяет ждущий openChannel
  const g = getGlobal(), st = g.chatStack, top = topReady();
  // тот же чат на экране — только прокрутка; его тред поверх — другой слой (ниже вернёмся к самой группе)
  if (chatId != null && (g.pendingChatId ?? top?.chatId) === chatId && top?.threadId == null && (st.length <= 1 || top?.chatId === chatId)) {
    if (target) focusMessage(target);
    return;
  }
  cancelPending();
  if (!chatId) {
    for (const f of st) closeSession(f.key);
    dropParked();
    dropLayers();
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
  const { frame, anchor } = newFrame({ chatId }, target);
  pendingBottom = { frame, target };
  if (hold) { hold.key = frame.key; hold.onCommit = () => setGlobal({ pendingChatId: chatId }); } else setGlobal({ pendingChatId: chatId });
  // пока лента нового чата не готова, на экране остаётся прежний; затем шапка и лента меняются одним кадром
  startFeed(frame, anchor, (patch) => {
    if (pendingBottom?.frame.key !== frame.key) return;
    whenReleased(hold, () => {
      if (pendingBottom?.frame.key !== frame.key) return;
      const ready: ChatFrame = { ...pendingBottom.frame, ...patch, ready: true, instant: true };
      pendingBottom = null;
      for (const f of stack()) closeSession(f.key);
      dropParked();
      dropLayers();
      setGlobal({ chatStack: [ready], chatLeaving: [], openChatId: chatId, pendingChatId: null });
      syncShown();
    });
  });
}

/**
 * Чат изнутри другого (автор в группе, найденное сообщение) или тред комментариев ({chatId: группа, threadId: копия
 * поста}): поверх стека, прежний остаётся живым. Дубль ищется по паре чат+тред.
 */
export function openInner(to: number | StackTarget, target?: { id: number; sort: number }, hold?: Hold): void {
  openSeq++;
  const t = toTarget(to), chatId = t.chatId;
  const g = getGlobal();
  if (!topReady()) {
    openChat(baseOf(t), t.threadId == null ? target : undefined);
    // тред без открытого чата: группа снизу (тред гостя — канал поста), тред поверх
    if (t.threadId != null) whenShown(baseOf(t), () => openInner(t, target));
    return;
  }
  cancelPending();
  const st = g.chatStack;
  const at = findTarget(st, t);
  if (at >= 0) {   // уже в стеке — снять всё выше него
    if (at < st.length - 1) popTo(at);
    if (target) focusMessage(target);
    return;
  }
  const parked = g.chatLeaving.find((f) => sameTarget(f, t));
  if (parked) { hold ? whenReleased(hold, () => requestMutation(() => revive(parked, target))) : requestMutation(() => revive(parked, target)); return; }
  const { frame, anchor } = newFrame(t, target);
  // колонка сразу в DOM (скрыта): лента раскладывается и встаёт на позицию до показа
  setGlobal(hold ? { chatStack: [...st, frame] } : { chatStack: [...st, frame], pendingChatId: chatId });
  if (hold) { hold.key = frame.key; hold.onCommit = () => setGlobal({ pendingChatId: chatId }); }
  const alive = () => stack().some((f) => f.key === frame.key);
  startFeed(frame, anchor, (patch) => {
    if (!alive()) return;
    // Как в Telegram Web: сначала лента рисуется и раскладывается в скрытой колонке, а переключение —
    // отдельным кадром, только смена классов. Иначе тяжёлый рендер ленты и запуск перехода — в одном кадре.
    patchFrame(frame.key, patch);
    // колонка уже отрисована в прошлом кадре (заготовка по нажатию) — переключать в ближайшей фазе записи
    let laidOut = false;
    requestAnimationFrame(() => { laidOut = true; });
    const show = () => {
      if (!alive()) return;
      beginHeavyAnimation(LEAVE_MS + 50);
      patchFrame(frame.key, { ready: true });
      setGlobal({ openChatId: chatId, pendingChatId: null });
      addLayer(frame.key);
      syncShown();
    };
    whenReleased(hold, () => (laidOut ? requestMutation(show) : requestAnimationFrame(() => requestMutation(show))));
  });
}

/* ---------- открытие по нажатию, как в Telegram Web ----------
 * pointerdown: чат начинает готовиться — снимок ленты из движка и скрытая колонка; click: показать (часто
 * колонка уже готова — переход стартует сразу). Клика не было (увели курсор) — заготовка выбрасывается. */
export interface Hold { released: boolean; key: string | null; waiting: (() => void) | null; onCommit: (() => void) | null }
export interface Prepared { commit(): void; cancel(): void }

function whenReleased(hold: Hold | undefined, fn: () => void): void {
  if (!hold || hold.released) fn(); else hold.waiting = fn;
}

function holdHandle(hold: Hold): Prepared {
  return {
    commit() {
      if (hold.released) return;
      hold.released = true;
      hold.onCommit?.();
      const w = hold.waiting; hold.waiting = null; w?.();
    },
    cancel() {
      if (hold.released) return;
      hold.released = true; hold.waiting = null;
      const key = hold.key;
      if (!key) return;
      if (pendingBottom?.frame.key === key) { closeSession(key); pendingBottom = null; return; }
      if (stack().some((f) => f.key === key && !f.ready)) { closeSession(key); setGlobal((s) => ({ chatStack: s.chatStack.filter((f) => f.key !== key) })); }
    },
  };
}

/** Заготовка нижнего чата (строка списка). Тот же чат или уже в стеке — заготавливать нечего: обычный клик. */
export function prepareChat(chatId: number): Prepared | null {
  const g = getGlobal(), st = g.chatStack, top = topReady();
  if ((g.pendingChatId ?? top?.chatId) === chatId || st.some((f) => f.chatId === chatId)) return null;
  const hold: Hold = { released: false, key: null, waiting: null, onCommit: null };
  openChat(chatId, undefined, hold);
  return holdHandle(hold);
}

/** Заготовка личного чата поверх текущего (участник группы). Чата ещё нет — его создаст обычный клик. */
export function prepareUserChat(userId: number): Prepared | null {
  const g = getGlobal();
  if (!g.me || userId === g.me.userId || !topReady()) return null;
  const found = g.chats.find((c) => c.kind === 'direct' && c.peerId === userId);
  if (!found || g.chatStack.some((f) => f.chatId === found.id)) return null;
  const hold: Hold = { released: false, key: null, waiting: null, onCommit: null };
  openInner(found.id as number, undefined, hold);
  return holdHandle(hold);
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

/**
 * Сдвинуть окно ленты кадра на порцию: к старым (верх) или к новым (низ). Дальняя сторона обрезается.
 * false — окно не двигается: прежний сдвиг ещё в пути или за этим краем уже ничего нет (края окна в кадре свежее,
 * чем у ленты, которая ещё не перерисовалась). Лента тогда не ждёт нового окна — оно не придёт.
 */
export function moveWindow(dir: 'older' | 'newer' | 'latest', frameKey?: string): boolean {
  const f = frameKey ? frameByKey(getGlobal(), frameKey) : topReady();
  const s = f && sessions.get(f.key);
  if (!f || !s || s.moving) return false;
  const ms = f.messages, meta = f.feedMeta;
  const set = (anchor: Anchor | undefined) => { s.anchor = anchor; s.moving = true; s.watch.update(feedQuery(f, anchor)); return true; };
  if (dir === 'latest') return !!s.anchor && set(undefined);
  if (!ms.length) return false;
  if (dir === 'older' && meta?.hasOlder) return set({ sort: ms[Math.min(ms.length - 1, FEED_PAGE - 1)].sort as number, side: 'end' });
  if (dir === 'newer' && meta?.hasNewer) return set({ sort: ms[Math.max(0, ms.length - FEED_PAGE)].sort as number, side: 'start' });
  return false;
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
  if (!inWindow) { s.anchor = { sort: target.sort, side: 'center' }; s.moving = true; s.watch.update(feedQuery(f, s.anchor)); }
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

export async function send(chatId: number, body: string, replyToId: number | null = null, entities: Entity[] = [], opts: { noLinkPreview?: boolean; link?: LinkPreview | null; blocks?: Block[] | null; threadId?: number } = {}): Promise<void> {
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
/** Клики по большому эмодзи — собеседнику (личный чат): t — секунды от первого клика пачки. */
export function emojiFx(chatId: number, id: number, key: string, t: number[]): void { engine.call({ type: 'emojiFx', chatId, id, key, t }).catch(() => {}); }

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
export interface SendOpts { asFile?: boolean; spoiler?: boolean; quality?: VideoQuality; threadId?: number }   // threadId — комментарий в треде

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
export async function sendVoice(chatId: number, rec: { blob: Blob; duration: number; waveform: Uint8Array }, replyToId: number | null = null, threadId?: number): Promise<void> {
  sentSound();
  nudgeWallpaper();
  toLatestOf(chatId);
  const res = (await engine.call({ type: 'sendFile', chatId, body: '', file: rec.blob, name: 'voice.ogg', mime: 'audio/ogg', kind: 'voice', duration: rec.duration, waveform: toBase64(rec.waveform), replyToId, ...(threadId != null ? { threadId } : {}) })) as { clientId: string };
  localPreviews.set(res.clientId, URL.createObjectURL(rec.blob));
}

/** Кружок: квадрат 400×400, до 60 с; превью — кадр из записи. */
export async function sendRound(chatId: number, rec: { blob: Blob; duration: number; size: number; thumb: string | null }, replyToId: number | null = null, threadId?: number): Promise<void> {
  sentSound();
  nudgeWallpaper();
  toLatestOf(chatId);
  const res = (await engine.call({ type: 'sendFile', chatId, body: '', file: rec.blob, name: 'video.mp4', mime: rec.blob.type.split(';')[0] || 'video/mp4', kind: 'round', duration: rec.duration, w: rec.size, h: rec.size, thumb: rec.thumb, replyToId, ...(threadId != null ? { threadId } : {}) })) as { clientId: string };
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
  const thread = opts.threadId != null ? { threadId: opts.threadId } : {};
  if (vid) {
    const res = (await engine.call({ type: 'sendFile', chatId, body: caption, file, name: file.name || 'video.mp4', mime: file.type, kind: 'video', w: vid.w, h: vid.h, duration: vid.duration, thumb: vid.thumb, replyToId,
      ...(opts.spoiler ? { spoiler: true } : {}), ...(groupId ? { groupId } : {}), ...thread })) as { clientId: string };
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
    ...(img && opts.spoiler ? { spoiler: true } : {}), ...(groupId ? { groupId } : {}), ...thread })) as { clientId: string };
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

/** Прочитано в треде: точка у кнопки поста гаснет; основную ленту группы (seen) не трогает. */
export function markThreadRead(chatId: number, threadId: number, upToId: number): void {
  engine.call({ type: 'markThreadRead', chatId, threadId, upToId }).catch(() => {});
}

/** Посты канала на экране: просмотр — по разу на пост за сессию (батч и дубли — в движке, channel.ts). */
export function countViews(chatId: number, ids: number[]): void {
  if (ids.length) engine.call({ type: 'countViews', chatId, ids }).catch(() => {});
}

/** «К реакции»: самое старое моё сообщение с непрочитанной реакцией (id) — из кэша движка или с сервера; null — нет. */
export function nextReaction(chatId: number): Promise<number | null> {
  return (engine.call({ type: 'nextReaction', chatId }) as Promise<number | null>).catch(() => null);
}
/** Реакции прочитаны: ids — увидел эти сообщения на экране, без ids — «прочитать все». */
export function readReactions(chatId: number, ids?: number[]): void {
  engine.call({ type: 'readReactions', chatId, ids }).catch(() => {});
}

/** «К упоминанию»: старейшее непрочитанное упоминание чата ({id, threadId?}) из кэша движка или null. */
export function nextMention(chatId: number): Promise<{ id: number; threadId?: number } | null> {
  return (engine.call({ type: 'nextMention', chatId }) as Promise<{ id: number; threadId?: number } | null>).catch(() => null);
}

/** «Кто прочитал» своё сообщение в небольшой группе. */
export function readBy(chatId: number, id: number): Promise<GroupResult<{ id: number; name: string }[]>> {
  return engine.call({ type: 'readBy', chatId, id }) as Promise<GroupResult<{ id: number; name: string }[]>>;
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
export async function createGroup(title: string, memberIds: number[], channel?: { about: string }): Promise<number> {
  // канал: {kind: 'channel'}, без участников — подписчиков добавляют следующим шагом (как в Telegram)
  const res = await fetch('/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(channel ? { kind: 'channel', title, about: channel.about, memberIds } : { title, memberIds }) });
  if (!res.ok) {
    const code = ((await res.json().catch(() => ({}))) as { code?: string }).code;
    throw new Error(code === 'blocked' ? 'Кого-то из выбранных нельзя добавить в группу'
      : code === 'too_long' ? 'Слишком длинное название или слишком много участников'
      : code === 'not_found' ? 'Кого-то из выбранных больше нет в Relay'
      : res.status === 401 ? 'Сессия истекла' : channel ? 'Не удалось создать канал' : 'Не удалось создать группу');
  }
  const { id } = (await res.json()) as { id: number };
  await engine.call({ type: 'refreshChats' });
  return id;
}

/** Перечитать список чатов с сервера (число подписчиков канала после добавления: журнал канала состав не несёт). */
export function refreshChats(): void { engine.call({ type: 'refreshChats' }).catch(() => {}); }

export async function startDirectChat(peerId: number): Promise<void> {
  openChat(await createDirectChat(peerId));
}

/* ---------- закреплённые сообщения ---------- */
export const pinMessage = (chatId: number, id: number) => engine.call({ type: 'pin', chatId, id }).catch(() => { showToastLazy('Не удалось закрепить — нет сети?'); });
export const unpinMessage = (chatId: number, id: number | null) => engine.call({ type: 'unpin', chatId, id }).catch(() => { showToastLazy('Не удалось открепить — нет сети?'); });
export const messagesByIds = (chatId: number, ids: number[]) => engine.call({ type: 'messagesByIds', chatId, ids }) as Promise<Item[]>;
function showToastLazy(text: string): void { void import('./settingsData').then((m) => m.showToast(text)); }
