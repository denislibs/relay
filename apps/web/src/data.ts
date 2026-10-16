import { nudgeWallpaper } from '@relay/ui';
import { connectEngine, EngineClient, Mirror } from '@relay/sync-engine/src/client';
import type { Item, Patch, Query, SearchResult } from '@relay/sync-engine/src/types';
import { getGlobal, setGlobal, type FeedMeta, type Me, type Status } from './global';

declare const __BUILD__: string;

let engine: EngineClient;
let feed: { update(q: Query): void; close(): void } | null = null;
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
  engine.watch({ kind: 'chatList', limit: 1000 }, (p) => {
    chats.apply(p);
    // сразу, не дожидаясь конца анимаций: список виртуальный (≈20 строк), а отложенный подъём чата
    // после отправки выглядит как запоздалый рывок
    setGlobal({ chats: chats.list(), chatsLoaded: true });
    // открытый чат появился в списке — теперь известен собеседник: подписываемся на его статус
    const g = getGlobal(), current = g.pendingChatId ?? g.openChatId;
    if (current && peerFor !== current) watchPeer(current);
  });
  const counters = new Mirror();
  engine.watch({ kind: 'counters' }, (p) => { counters.apply(p); const c = counters.list()[0]; if (c) setGlobal({ counters: { unreadChats: c.unreadChats as number, unreadMessages: c.unreadMessages as number } }); });
  const status = new Mirror();
  engine.watch({ kind: 'status' }, (p) => { status.apply(p); const s = status.list()[0] as unknown as Status | undefined; if (s) { setGlobal({ status: s }); showPhase(s); } });

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
  const peerId = chat?.peerId as number | null | undefined;
  if (!peerId) { setGlobal({ peer: null }); return; }
  const m = new Mirror();
  peerWatch = engine.watch({ kind: 'presence', userId: peerId }, (p: Patch) => { m.apply(p); setGlobal({ peer: (m.list()[0] as Item) ?? null }); });
}

/**
 * Переключение чата одним кадром: пока лента нового чата не готова, на экране остаётся прежний
 * (строка в списке подсвечивается сразу), затем шапка и лента меняются вместе. Без «пусто → часть → всё».
 */
type Anchor = { sort: number; side: 'end' | 'start' | 'center' };
const WINDOW = FEED_PAGE * 2;                  // сообщений в DOM: две порции (как окно viewport в Telegram)
let feedAnchor: Anchor | undefined;            // undefined — живой хвост
let moving = false;                            // окно сдвигается — следующий сдвиг ждёт патча
let feedMirror: Mirror | null = null;
/** Позиция прокрутки чата при уходе: первый видимый бабл и его отступ (нет записи — чат был внизу). */
const positions = new Map<number, { key: string; sort: number; offset: number }>();

export function savePosition(chatId: number, pos: { key: string; sort: number; offset: number } | null): void {
  if (pos) positions.set(chatId, pos); else positions.delete(chatId);
}
export function savedPosition(chatId: number) { return positions.get(chatId) ?? null; }

function setFeed(chatId: number, anchor: Anchor | undefined): void {
  feedAnchor = anchor;
  moving = true;
  feed?.update({ kind: 'messages', chatId, limit: WINDOW, anchor });
}

/** Сдвинуть окно ленты на порцию: к старым (верх) или к новым (низ). Дальняя сторона обрезается. */
export function moveWindow(dir: 'older' | 'newer' | 'latest'): void {
  const g = getGlobal(), chatId = g.openChatId, meta = g.feedMeta;
  if (!chatId || !feed || moving) return;
  const ms = g.messages;
  if (dir === 'latest') { if (feedAnchor) setFeed(chatId, undefined); return; }
  if (!ms.length) return;
  if (dir === 'older' && meta?.hasOlder) setFeed(chatId, { sort: ms[Math.min(ms.length - 1, FEED_PAGE - 1)].sort as number, side: 'end' });
  if (dir === 'newer' && meta?.hasNewer) setFeed(chatId, { sort: ms[Math.max(0, ms.length - FEED_PAGE)].sort as number, side: 'start' });
}

let switchTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Переключение чата одним кадром: пока лента нового чата не готова, на экране остаётся прежний
 * (строка в списке подсвечивается сразу), затем шапка и лента меняются вместе. Без «пусто → часть → всё».
 * Открывается: на сохранённой позиции, иначе вокруг первого непрочитанного (с разделителем), иначе внизу.
 */
export function openChat(chatId: number | null, target?: { id: number; sort: number }): void {
  const g = getGlobal();
  if ((g.pendingChatId ?? g.openChatId) === chatId) { if (target) focusMessage(target); return; }
  feed?.close();
  feed = null;
  if (switchTimer) { clearTimeout(switchTimer); switchTimer = null; }
  history.replaceState(null, '', chatId ? '#chat=' + chatId : location.pathname);
  watchPeer(chatId);
  if (!chatId) { setGlobal({ openChatId: null, pendingChatId: null, messages: [], feedMeta: null, unreadFrom: null }); return; }
  const chat = g.chats.find((c) => c.id === chatId);
  const pos = positions.get(chatId);
  const unread = (chat?.unread as number) > 0 ? (chat!.lastReadId as number) : null;
  // ушли из середины истории в этой сессии — вернуться туда же; иначе — к первому непрочитанному; иначе — вниз
  // открыть на найденном сообщении; иначе: ушли из середины истории — туда же; непрочитанное; низ
  feedAnchor = target ? { sort: target.sort, side: 'center' } : pos ? { sort: pos.sort, side: 'center' } : unread != null ? { sort: unread + 0.5, side: 'center' } : undefined;
  moving = true;
  setGlobal({ pendingChatId: chatId });
  const m = new Mirror();
  feedMirror = m;
  const commit = () => {
    switchTimer && clearTimeout(switchTimer); switchTimer = null;
    setGlobal({ openChatId: chatId, pendingChatId: null, messages: m.list() as Item[], feedMeta: (m.meta('~window') as unknown as FeedMeta) ?? null, unreadFrom: target ? null : unread, focus: target ? { ...target, nonce: Date.now(), replaced: true } : null });
  };
  // лента открытого чата — срочная: свои сообщения должны появляться в тот же кадр
  feed = engine.watch({ kind: 'messages', chatId, limit: WINDOW, anchor: feedAnchor }, (p: Patch) => {
    m.apply(p);
    moving = false;
    const now = getGlobal();
    if (now.pendingChatId === chatId) { commit(); return; }
    if (now.openChatId !== chatId) return;
    const meta = (m.meta('~window') as unknown as FeedMeta) ?? null;
    setGlobal({ messages: m.list() as Item[], feedMeta: meta });
    // окно дошло до последних сообщений — снова живой хвост (новые сообщения появятся сами)
    if (feedAnchor && meta?.live && !meta.hasNewer) { feedAnchor = undefined; feed?.update({ kind: 'messages', chatId, limit: WINDOW }); }
  });
  // движок отдаёт готовую ленту почти сразу; если нет — не держим пользователя на прежнем чате
  switchTimer = setTimeout(() => { if (getGlobal().pendingChatId === chatId) commit(); }, 700);
}

/** Перейти к сообщению открытого чата (цитата, поиск): в окне — прокрутка, нет — окно вокруг него. */
export function focusMessage(target: { id: number; sort: number }): void {
  const g = getGlobal(), chatId = g.openChatId;
  if (!chatId) return;
  const inWindow = g.messages.some((m) => m.id === target.id);
  setGlobal({ focus: { ...target, nonce: Date.now(), replaced: !inWindow } });
  if (!inWindow) { moving = false; setFeed(chatId, { sort: target.sort, side: 'center' }); }
}

/** Прежний вызов «ещё истории» — теперь сдвиг окна к старым. */
export function loadOlder(): void { moveWindow('older'); }

export async function send(chatId: number, body: string, replyToId: number | null = null): Promise<void> {
  nudgeWallpaper();
  if (feedAnchor && getGlobal().openChatId === chatId) moveWindow('latest'); // своё сообщение — внизу, как в Telegram
  await engine.call({ type: 'sendMessage', chatId, body, replyToId });
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

/** Правка своего сообщения (онлайн). */
export function editMessage(chatId: number, id: number, body: string): Promise<unknown> { return engine.call({ type: 'editMessage', chatId, id, body }); }
/** Удаление своего сообщения у всех (онлайн). */
export function deleteMessage(chatId: number, id: number): Promise<unknown> { return engine.call({ type: 'deleteMessage', chatId, id }); }
/** Реакция (null — снять). У себя применяется сразу. */
export function react(chatId: number, id: number, emoji: string | null): void { engine.call({ type: 'react', chatId, id, emoji }).catch(() => {}); }

/** Черновик чата (пустой — удалить). Хранится в движке: общий для вкладок, переживает перезагрузку. */
export function saveDraft(chatId: number, text: string): void {
  engine.call({ type: 'setDraft', chatId, text }).catch(() => {});
}

/** Следующая страница диалогов; движок сам не пустит второй запрос, пока идёт первый. */
export function loadMoreChats(): void {
  engine.call({ type: 'loadMoreChats' }).catch(() => {});
}

export function seen(chatId: number, upToId: number): void {
  engine.call({ type: 'seen', chatId, upToId }).catch(() => {});
}

export async function startDirectChat(peerId: number): Promise<void> {
  const res = await fetch('/dev/chats', { method: 'POST', body: JSON.stringify({ kind: 'direct', title: null, memberIds: [peerId] }) });
  if (!res.ok) throw new Error(res.status === 401 ? 'Сессия истекла' : 'Не удалось создать чат');
  const { id } = (await res.json()) as { id: number };
  await engine.call({ type: 'refreshChats' });
  openChat(id);
}
