import { chatTitle, personView } from './names';
import type { Store } from './store';
import { toQuote, type Item, type LocalChat, type LocalMessage, type Patch, type Query, type QuoteMsg } from './types';

export interface Result {
  items: Map<string, Item>;
  order: string[];
  /** подпись каждого элемента — для дешёвого сравнения (строки — из версий, мелкие элементы — сериализация) */
  sig: Map<string, string>;
}

/** Мелкие служебные элементы (очередь загрузок, счётчики): подпись — сериализация, их единицы. */
function result(list: Item[]): Result {
  const items = new Map<string, Item>(), sig = new Map<string, string>();
  for (const it of list) { items.set(it.key, it); sig.set(it.key, JSON.stringify(it)); }
  return { items, order: list.map((i) => i.key), sig };
}

/** Место в списке — по более позднему из последнего сообщения и черновика (как в Telegram). */
const sortAt = (c: LocalChat): string => (c.draft && c.draft.at > c.lastAt ? c.draft.at : c.lastAt);

/** Строка списка: название и фото личного чата — из people (personView), группы — из chat.group. */
const chatItem = (store: Store, c: LocalChat, person: ReturnType<typeof personView> | null): Item => {
  const title = chatTitle(store, c);
  return {
  key: 'c' + c.id, id: c.id, kind: c.kind, title, peerId: c.peerId,
  // собеседник личного чата; system — служебный чат «Relay» (только чтение)
  peer: c.peerId != null ? { id: c.peerId, name: title, ...(c.system ? { system: true } : null) } : null, unread: c.unread, lastReadId: c.lastReadId, lastAt: c.lastAt,
  photo: person ? person.photo : c.group?.photo ?? null, group: c.group ?? null, me: c.me ?? null, membersRev: c.membersRev ?? 0, sortAt: sortAt(c), draft: c.draft?.text ?? null, draftEntities: c.draft?.entities ?? null, pinned: c.pinned ?? [],
  last: c.last ? { key: c.last.key, id: c.last.id, senderId: c.last.senderId, body: c.last.body, status: c.last.status, createdAt: c.last.createdAt, deleted: !!c.last.deleted, kind: c.last.kind ?? 'text', attachmentName: c.last.attachment?.name ?? null, attachmentTitle: c.last.attachment?.title ?? null, attachmentPerformer: c.last.attachment?.performer ?? null,
    // для превью в списке: спойлеры прячем, миниатюра 20 px — из встроенного thumb, без загрузки файла
    entities: c.last.entities ?? null, thumb: c.last.attachment?.thumb ?? null, mime: c.last.attachment?.mime ?? null,
    ...(c.last.service ? { service: c.last.service } : null) } : null,
  };
};
// строка списка переиспользуется, пока не изменились её входы: версия чата (всё из строки чата, включая last и
// черновик), вид собеседника (профиль, контакт, операция в очереди) и «печатает»; JSON.stringify не нужен
const chatCache = new WeakMap<LocalChat, { sig: string; item: Item }>();
function chatListItem(store: Store, c: LocalChat): { item: Item; sig: string } {
  const person = !c.group && c.peerId != null ? personView(store, c.peerId) : null;
  // профиля собеседника нет (чат узнали из сообщения, строку people вытеснили) — движок его спросит
  if (person && c.peerId != null && !store.users.get(c.peerId)) store.wantUser(c.peerId);
  const typing = store.typing.has(c.id);
  const sig = `${store.chatVersion(c.id)}|${person?.sig ?? ''}|${typing}`;
  let hit = chatCache.get(c);
  if (!hit || hit.sig !== sig) { hit = { sig, item: { ...chatItem(store, c, person), typing } }; chatCache.set(c, hit); }
  return hit;
}

// элемент сообщения переиспользуется, пока сообщение не изменилось: дешёвая подпись вместо JSON.stringify
// цитата — короткая копия исходного сообщения, если оно есть в кэше (видна, даже когда оригинал вне окна)
type Quote = QuoteMsg | null;
const msgSig = (m: LocalMessage, q: Quote): string => `${m.id}|${m.status}|${m.sort}|${m.replyToId}|${m.body}|${m.editedAt ?? ''}|${m.deleted ? 1 : 0}|${m.reactions?.map((r) => r.userId + r.emoji).join(',') ?? ''}|${m.attachment ? m.attachment.id + ':' + (m.progress ?? '') + ':' + m.attachment.size + (m.attachment.preview ? ':p' : '') + ':' + (m.attachment.variants?.length ?? 0) : ''}|${q ? q.id + ':' + q.body + ':' + (q.deleted ? 1 : 0) + ':' + (q.attachment?.thumb?.length ?? 0) + ':' + (q.entities?.length ?? 0) : ''}|${m.error ?? ''}|${m.listened ? 1 : 0}|${m.entities?.map((e) => e.type + e.offset + ':' + e.length + (e.url ?? '')).join(',') ?? ''}|${m.todo ? JSON.stringify(m.todo) : ''}|${m.service?.data ? JSON.stringify(m.service.data) : ''}`;
const msgCache = new WeakMap<LocalMessage, { sig: string; item: Item }>();
const messageItem = (m: LocalMessage, q: Quote): { item: Item; sig: string } => {
  const sig = msgSig(m, q);
  let c = msgCache.get(m);
  if (!c || c.sig !== sig) { c = { sig, item: { ...m, reply: q } }; msgCache.set(m, c); }
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
      const items = new Map<string, Item>(), sig = new Map<string, string>(), order: string[] = [];
      for (const c of chats.slice(0, q.limit)) {
        const { item, sig: g } = chatListItem(store, c);
        items.set(item.key, item); sig.set(item.key, g); order.push(item.key);
      }
      return { items, sig, order };
    }
    case 'messages': {
      // только окно: бинарный поиск по отсортированному кэшу, подписи — без сериализации
      const all = store.chatMessages(q.chatId);
      const { from, to } = messageWindow(all, q);
      const chat = store.chats.get(q.chatId);
      const items = new Map<string, Item>(), sig = new Map<string, string>(), order: string[] = [];
      const missingQuotes = new Set<number>();
      for (let k = from; k < to; k++) {
        const m = all[k];
        let quote: Quote = null;
        if (m.replyToId != null) {
          const r = store.messageById(q.chatId, m.replyToId);
          quote = r ? toQuote(r) : store.quoteFor(q.chatId, m.replyToId) ?? null;
          if (!quote) missingQuotes.add(m.replyToId);
        }
        const { item, sig: g } = messageItem(m, quote);
        items.set(item.key, item); sig.set(item.key, g); order.push(item.key);
      }
      // служебный элемент: есть ли что-то за краями окна (интерфейс по нему решает, двигать ли окно)
      const meta: Item = { key: '~window', hasOlder: from > 0 || !chat?.historyComplete, hasNewer: to < all.length, live: !q.anchor || to === all.length };
      items.set(meta.key, meta); sig.set(meta.key, `${meta.hasOlder}|${meta.hasNewer}|${meta.live}`); order.push(meta.key);
      if (missingQuotes.size) store.wantQuotes(q.chatId, [...missingQuotes]);
      return { items, sig, order };
    }
    case 'uploads': {
      // очередь отправки файлов во всех чатах (индикатор «Отправка N файлов» и предупреждение при закрытии вкладки)
      const list: Item[] = [];
      for (const o of store.outbox.values()) {
        if (o.failed || !o.attachment || o.forward) continue;
        list.push({ key: o.clientId, chatId: o.chatId, name: o.attachment.name, size: o.attachment.size, kind: o.attachment.kind, mime: o.attachment.mime,
          uploaded: !!o.attachment.id, progress: o.attachment.id ? 1 : Math.round(store.progressOf(o.clientId) * 100) / 100 });
      }
      return result(list);
    }
    case 'counters': {
      let unreadChats = 0, unreadMessages = 0;
      for (const c of store.chats.values()) if (c.unread > 0) { unreadChats++; unreadMessages += c.unread; }
      return result([{ key: 'counters', unreadChats, unreadMessages }]);
    }
    case 'status':
    case 'presence':
    case 'me':
    case 'user':
    case 'people':
    case 'ops':
    case 'contacts':
    case 'settings':
    case 'blocked':
    case 'devStats':
    case 'devLog':
      throw new Error(q.kind + ' is computed by the engine');
  }
}

/** Задевает ли изменение этих чатов результат подписки. */
export function affects(q: Query, touched: Set<number>): boolean {
  if (!touched.size) return false;
  if (q.kind === 'status' || q.kind === 'me' || q.kind === 'user' || q.kind === 'people' || q.kind === 'ops' || q.kind === 'contacts' || q.kind === 'settings' || q.kind === 'blocked' || q.kind === 'devStats' || q.kind === 'devLog') return false;   // у них свои флаги в движке
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
