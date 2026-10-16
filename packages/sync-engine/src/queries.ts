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

/** Место в списке — по более позднему из последнего сообщения и черновика (как в Telegram). */
const sortAt = (c: LocalChat): string => (c.draft && c.draft.at > c.lastAt ? c.draft.at : c.lastAt);

const chatItem = (c: LocalChat): Item => ({
  key: 'c' + c.id, id: c.id, kind: c.kind, title: c.title, peerId: c.peerId, unread: c.unread, lastReadId: c.lastReadId, lastAt: c.lastAt,
  sortAt: sortAt(c), draft: c.draft?.text ?? null,
  last: c.last ? { key: c.last.key, id: c.last.id, senderId: c.last.senderId, body: c.last.body, status: c.last.status, createdAt: c.last.createdAt } : null,
});
// элемент сообщения переиспользуется, пока сообщение не изменилось: дешёвая подпись вместо JSON.stringify
const msgSig = (m: LocalMessage): string => `${m.id}|${m.status}|${m.sort}|${m.replyToId}|${m.body}`;
const msgCache = new WeakMap<LocalMessage, { sig: string; item: Item }>();
const messageItem = (m: LocalMessage): { item: Item; sig: string } => {
  const sig = msgSig(m);
  let c = msgCache.get(m);
  if (!c || c.sig !== sig) { c = { sig, item: { ...m } }; msgCache.set(m, c); }
  return c;
};

/** Первый индекс с sort >= s (массив отсортирован по sort). */
function lowerBound(arr: LocalMessage[], s: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].sort < s) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Границы окна ленты [from, to) по запросу. */
export function messageWindow(all: LocalMessage[], q: Extract<Query, { kind: 'messages' }>): { from: number; to: number } {
  const n = all.length, limit = q.limit;
  if (!q.anchor) return { from: Math.max(0, n - limit), to: n };
  const i = lowerBound(all, q.anchor.sort);
  if (q.anchor.side === 'end') { const to = Math.min(n, i < n && all[i].sort === q.anchor.sort ? i + 1 : i); return { from: Math.max(0, to - limit), to }; }
  if (q.anchor.side === 'start') return { from: i, to: Math.min(n, i + limit) };
  let from = Math.max(0, i - (limit >> 1));
  const to = Math.min(n, from + limit);
  from = Math.max(0, to - limit);
  return { from, to };
}

export function computeQuery(store: Store, q: Query): Result {
  switch (q.kind) {
    case 'chatList': {
      const chats = [...store.chats.values()].sort((a, b) => { const x = sortAt(a), y = sortAt(b); return x < y ? 1 : x > y ? -1 : b.id - a.id; });
      return result(chats.slice(0, q.limit).map(chatItem));
    }
    case 'messages': {
      // только окно: бинарный поиск по отсортированному кэшу, подписи — без сериализации
      const all = store.chatMessages(q.chatId);
      const { from, to } = messageWindow(all, q);
      const chat = store.chats.get(q.chatId);
      const items = new Map<string, Item>(), sig = new Map<string, string>(), order: string[] = [];
      for (let k = from; k < to; k++) { const { item, sig: g } = messageItem(all[k]); items.set(item.key, item); sig.set(item.key, g); order.push(item.key); }
      // служебный элемент: есть ли что-то за краями окна (интерфейс по нему решает, двигать ли окно)
      const meta: Item = { key: '~window', hasOlder: from > 0 || !chat?.historyComplete, hasNewer: to < all.length, live: !q.anchor || to === all.length };
      items.set(meta.key, meta); sig.set(meta.key, `${meta.hasOlder}|${meta.hasNewer}|${meta.live}`); order.push(meta.key);
      return { items, sig, order };
    }
    case 'counters': {
      let unreadChats = 0, unreadMessages = 0;
      for (const c of store.chats.values()) if (c.unread > 0) { unreadChats++; unreadMessages += c.unread; }
      return result([{ key: 'counters', unreadChats, unreadMessages }]);
    }
    case 'status':
    case 'presence':
      throw new Error(q.kind + ' is computed by the engine');
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
