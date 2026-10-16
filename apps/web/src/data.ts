import { deferDuringAnimation, nudgeWallpaper } from '@relay/ui';
import { connectEngine, EngineClient, Mirror } from '@relay/sync-engine/src/client';
import type { Item, Patch } from '@relay/sync-engine/src/types';
import { getGlobal, setGlobal, type Me, type Status } from './global';

declare const __BUILD__: string;

let engine: EngineClient;
let feed: { update(q: { kind: 'messages'; chatId: number; limit: number }): void; close(): void } | null = null;
let feedLimit = 60;

/** Подписки движка → GlobalState. Несрочное применяем после тяжёлых анимаций. */
export function startData(me: Me): void {
  engine = connectEngine({
    build: __BUILD__,
    config: {
      userId: me.userId,
      dbName: 'relay-' + me.userId,
      httpBase: location.origin,
      wsUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
    },
    sharedUrl: '/shared.worker.js',
    dedicatedUrl: '/dedicated.worker.js',
  });
  engine.onReload(() => location.reload());

  const chats = new Mirror();
  engine.watch({ kind: 'chatList', limit: 1000 }, (p) => {
    chats.apply(p);
    const apply = () => setGlobal({ chats: chats.list(), chatsLoaded: true });
    // пустой список беречь нечего — первые данные показываем сразу, остальное после тяжёлых анимаций
    if (!getGlobal().chats.length) apply(); else deferDuringAnimation(apply);
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

let switchTimer: ReturnType<typeof setTimeout> | null = null;
let peerWatch: { close(): void } | null = null;

/** Присутствие собеседника личного чата — отдельная маленькая подписка, живёт, пока чат открыт. */
function watchPeer(chatId: number | null): void {
  peerWatch?.close();
  peerWatch = null;
  const peerId = chatId ? (getGlobal().chats.find((c) => c.id === chatId)?.peerId as number | null | undefined) : null;
  if (!peerId) { setGlobal({ peer: null }); return; }
  const m = new Mirror();
  peerWatch = engine.watch({ kind: 'presence', userId: peerId }, (p: Patch) => { m.apply(p); setGlobal({ peer: (m.list()[0] as Item) ?? null }); });
}

/**
 * Переключение чата одним кадром: пока лента нового чата не готова, на экране остаётся прежний
 * (строка в списке подсвечивается сразу), затем шапка и лента меняются вместе. Без «пусто → часть → всё».
 */
export function openChat(chatId: number | null): void {
  const g = getGlobal();
  if ((g.pendingChatId ?? g.openChatId) === chatId) return;
  feed?.close();
  feed = null;
  feedLimit = 60;
  if (switchTimer) { clearTimeout(switchTimer); switchTimer = null; }
  history.replaceState(null, '', chatId ? '#chat=' + chatId : location.pathname);
  watchPeer(chatId);
  if (!chatId) { setGlobal({ openChatId: null, pendingChatId: null, messages: [] }); return; }
  setGlobal({ pendingChatId: chatId });
  const m = new Mirror();
  const commit = () => { switchTimer && clearTimeout(switchTimer); switchTimer = null; setGlobal({ openChatId: chatId, pendingChatId: null, messages: m.list() as Item[] }); };
  // лента открытого чата — срочная: свои сообщения должны появляться в тот же кадр
  feed = engine.watch({ kind: 'messages', chatId, limit: feedLimit }, (p: Patch) => {
    m.apply(p);
    const now = getGlobal();
    if (now.pendingChatId === chatId) { commit(); return; }
    if (now.openChatId !== chatId) return;
    setGlobal({ messages: m.list() as Item[] });
  });
  // движок отдаёт готовую ленту почти сразу; если нет — не держим пользователя на прежнем чате
  switchTimer = setTimeout(() => { if (getGlobal().pendingChatId === chatId) commit(); }, 700);
}

export function loadOlder(): void {
  const chatId = getGlobal().openChatId;
  if (!chatId || !feed) return;
  feedLimit += 40;
  feed.update({ kind: 'messages', chatId, limit: feedLimit });
}

export async function send(chatId: number, body: string, replyToId: number | null = null): Promise<void> {
  nudgeWallpaper();
  await engine.call({ type: 'sendMessage', chatId, body, replyToId });
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
