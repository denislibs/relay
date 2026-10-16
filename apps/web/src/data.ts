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
  engine.watch({ kind: 'status' }, (p) => { status.apply(p); const s = status.list()[0]; if (s) setGlobal({ status: s as unknown as Status }); });

  const open = Number(new URLSearchParams(location.hash.slice(1)).get('chat')) || null;
  if (open) openChat(open);
}

export function openChat(chatId: number | null): void {
  if (getGlobal().openChatId === chatId) return;
  feed?.close();
  feed = null;
  feedLimit = 60;
  setGlobal({ openChatId: chatId, messages: [] });
  history.replaceState(null, '', chatId ? '#chat=' + chatId : location.pathname);
  if (!chatId) return;
  const m = new Mirror();
  // лента открытого чата — срочная: свои сообщения должны появляться в тот же кадр
  feed = engine.watch({ kind: 'messages', chatId, limit: feedLimit }, (p: Patch) => {
    if (getGlobal().openChatId !== chatId) return;
    m.apply(p);
    setGlobal({ messages: m.list() as Item[] });
  });
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
