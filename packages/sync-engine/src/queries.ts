import type { Store } from './store';
import type { Item, LocalChat, LocalMessage, Patch, Query } from './types';

export interface Result {
  items: Map<string, Item>;
  order: string[];
  /** стабильная сериализация каждого элемента — для дешёвого сравнения */
  sig: Map<string, string>;
}

function result(list: Item[]): Result {
  const items = new Map<string, Item>(), sig = new Map<string, string>();
  for (const it of list) { items.set(it.key, it); sig.set(it.key, JSON.stringify(it)); }
  return { items, order: list.map((i) => i.key), sig };
}

const chatItem = (c: LocalChat): Item => ({
  key: 'c' + c.id, id: c.id, kind: c.kind, title: c.title, peerId: c.peerId, unread: c.unread, lastReadId: c.lastReadId, lastAt: c.lastAt,
  last: c.last ? { key: c.last.key, id: c.last.id, senderId: c.last.senderId, body: c.last.body, status: c.last.status, createdAt: c.last.createdAt } : null,
});
const messageItem = (m: LocalMessage): Item => ({ ...m });

export function computeQuery(store: Store, q: Query): Result {
  switch (q.kind) {
    case 'chatList': {
      const chats = [...store.chats.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : b.id - a.id));
      return result(chats.slice(0, q.limit).map(chatItem));
    }
    case 'messages': {
      const all = store.chatMessages(q.chatId);
      return result(all.slice(Math.max(0, all.length - q.limit)).map(messageItem));
    }
    case 'counters': {
      let unreadChats = 0, unreadMessages = 0;
      for (const c of store.chats.values()) if (c.unread > 0) { unreadChats++; unreadMessages += c.unread; }
      return result([{ key: 'counters', unreadChats, unreadMessages }]);
    }
    case 'status':
      throw new Error('status is computed by the engine');
  }
}

/** Задевает ли изменение этих чатов результат подписки. */
export function affects(q: Query, touched: Set<number>): boolean {
  if (!touched.size) return false;
  if (q.kind === 'status') return false;
  return q.kind === 'messages' ? touched.has(q.chatId) : true;
}

export function diffResults(prev: Result | null, next: Result): Patch | null {
  if (!prev) return { op: 'snapshot', items: next.order.map((k) => next.items.get(k)!), order: next.order };
  const upsert: Item[] = [], remove: string[] = [];
  for (const k of next.order) if (prev.sig.get(k) !== next.sig.get(k)) upsert.push(next.items.get(k)!);
  for (const k of prev.order) if (!next.items.has(k)) remove.push(k);
  const orderChanged = prev.order.length !== next.order.length || prev.order.some((k, i) => k !== next.order[i]);
  if (!upsert.length && !remove.length && !orderChanged) return null;
  return orderChanged ? { op: 'diff', upsert, remove, order: next.order } : { op: 'diff', upsert, remove };
}
