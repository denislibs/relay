import { chatTitle, personView } from './names';
import { canPost } from './channel';
import type { Store } from './store';
import { PENDING_BASE, toQuote, type Item, type LocalChat, type LocalMessage, type Patch, type Query, type QuoteMsg } from './types';

export interface Result {
  items: Map<string, Item>;
  order: string[];
  /** подпись каждого элемента — для дешёвого сравнения (строки — из версий, мелкие элементы — сериализация) */
  sig: Map<string, string>;
}

/** Операция «выключить уведомления чата»: ключ mute:<chatId>, тело {muteUntil}. Её значение показывается сразу, до ответа сервера. */
export const muteKey = (chatId: number) => 'mute:' + chatId;
export const flagsKey = (chatId: number) => 'flags:' + chatId;

/** Флаги чата, которые видит список: закреплён (мс), в архиве, пометка «непрочитанное». */
export interface Flags { pinnedAt: number | null; archived: boolean; unreadMark: boolean }
type FlagsOp = { pinned: boolean; archived: boolean; unreadMark?: boolean; at: number };
/**
 * Неотправленные операции setChatFlags: их значение перекрывает значение чата (видно сразу, до ответа сервера).
 * unarchive:<id> (сообщение в архивную группу) — чат показывается вне архива, пока сервер не ответил; ручная
 * flags: того же чата в очереди побеждает (идёт по порядку очереди, позже — выше).
 */
export function flagsOverlay(ops: readonly { key: string; body?: unknown }[]): Map<number, FlagsOp> {
  const m = new Map<number, FlagsOp>();
  for (const o of ops) {
    if (o.key.startsWith('flags:')) m.set(Number(o.key.slice(6)), o.body as FlagsOp);
    else if (o.key.startsWith('unarchive:')) m.set(Number(o.key.slice(10)), { pinned: false, archived: false, at: 0 });
  }
  return m;
}
/** Флаги чата с учётом операции в очереди: закреплённый раньше сохраняет своё место, только что закреплённый — время операции. */
export function flagsOf(c: LocalChat, over?: FlagsOp): Flags {
  if (!over) return { pinnedAt: c.pinnedAt ?? null, archived: !!c.archived, unreadMark: !!c.unreadMark };
  const keep = c.pinnedAt != null && !!c.archived === over.archived;
  return { pinnedAt: over.pinned ? (keep ? c.pinnedAt! : over.at) : null, archived: over.archived, unreadMark: over.unreadMark ?? !!c.unreadMark };
}
export function muteOverlay(ops: readonly { key: string; body?: unknown }[]): Map<number, number | null> {
  const m = new Map<number, number | null>();
  for (const o of ops) if (o.key.startsWith('mute:')) m.set(Number(o.key.slice(5)), (o.body as { muteUntil: number | null }).muteUntil);
  return m;
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
const chatItem = (store: Store, c: LocalChat, person: ReturnType<typeof personView> | null, muteUntil: number | null, f: Flags): Item => {
  const title = chatTitle(store, c);
  return {
  key: 'c' + c.id, id: c.id, kind: c.kind, title, peerId: c.peerId,
  // собеседник личного чата; system — служебный чат «Relay» (только чтение)
  peer: c.peerId != null ? { id: c.peerId, name: title, ...(c.system ? { system: true } : null) } : null, unread: c.unread, lastReadId: c.lastReadId, lastAt: c.lastAt,
  // canSend: в канале пишет только админ с правом post (channel.ts)
  canSend: canPost(c),
  photo: person ? person.photo : c.group?.photo ?? null, group: c.group ?? null, me: c.me ?? null, membersRev: store.members.rev(c.id), sortAt: sortAt(c), draft: c.draft?.text ?? null, draftEntities: c.draft?.entities ?? null, pinned: c.pinned ?? [], muteUntil,
  pinnedAt: f.pinnedAt, archived: f.archived, unreadMark: f.unreadMark, mentions: c.mentions ?? 0,
  last: c.last ? { key: c.last.key, id: c.last.id, senderId: c.last.senderId, body: c.last.body, status: c.last.status, createdAt: c.last.createdAt, deleted: !!c.last.deleted, kind: c.last.kind ?? 'text', attachmentName: c.last.attachment?.name ?? null, attachmentTitle: c.last.attachment?.title ?? null, attachmentPerformer: c.last.attachment?.performer ?? null,
    // для превью в списке: спойлеры прячем, миниатюра 20 px — из встроенного thumb, без загрузки файла
    entities: c.last.entities ?? null, thumb: c.last.attachment?.thumb ?? null, mime: c.last.attachment?.mime ?? null,
    ...(c.last.sticker ? { sticker: c.last.sticker } : {}),   // стикер: мини-стикер в строке списка
    ...(c.last.service ? { service: c.last.service } : null) } : null,
  };
};
// строка списка переиспользуется, пока не изменились её входы: версия чата (всё из строки чата, включая last и
// черновик), вид собеседника (профиль, контакт, операция в очереди) и «печатает»; JSON.stringify не нужен
const chatCache = new WeakMap<LocalChat, { sig: string; item: Item }>();
function chatListItem(store: Store, c: LocalChat, mute: Map<number, number | null>, flags: Map<number, FlagsOp>): { item: Item; sig: string } {
  const person = !c.group && c.peerId != null ? personView(store, c.peerId) : null;
  // профиля собеседника нет (чат узнали из сообщения, строку people вытеснили) — движок его спросит
  if (person && c.peerId != null && !store.users.get(c.peerId)) store.wantUser(c.peerId);
  const typing = store.typing.has(c.id);
  // уведомления: значение неотправленной операции перекрывает значение чата
  const muteUntil = mute.has(c.id) ? mute.get(c.id)! : c.muteUntil ?? null;
  // membersRev — счётчик изменений состава в памяти (members.ts) для старого интерфейса участников
  const f = flagsOf(c, flags.get(c.id));
  const sig = `${store.chatVersion(c.id)}|${person?.sig ?? ''}|${typing}|${muteUntil}|${store.members.rev(c.id)}|${f.pinnedAt}|${f.archived}|${f.unreadMark}`;
  let hit = chatCache.get(c);
  if (!hit || hit.sig !== sig) { hit = { sig, item: { ...chatItem(store, c, person, muteUntil, f), typing } }; chatCache.set(c, hit); }
  return hit;
}

// элемент сообщения переиспользуется, пока сообщение не изменилось: дешёвая подпись вместо JSON.stringify
// цитата — короткая копия исходного сообщения, если оно есть в кэше (видна, даже когда оригинал вне окна)
type Quote = QuoteMsg | null;
const msgSig = (m: LocalMessage, q: Quote): string => `${m.id}|${m.status}|${m.sort}|${m.replyToId}|${m.body}|${m.editedAt ?? ''}|${m.deleted ? 1 : 0}|${m.reactions?.map((r) => r.userId + r.emoji).join(',') ?? ''}|${m.attachment ? m.attachment.id + ':' + (m.progress ?? '') + ':' + m.attachment.size + (m.attachment.preview ? ':p' : '') + ':' + (m.attachment.variants?.length ?? 0) : ''}|${q ? q.id + ':' + q.body + ':' + (q.deleted ? 1 : 0) + ':' + (q.attachment?.thumb?.length ?? 0) + ':' + (q.entities?.length ?? 0) : ''}|${m.error ?? ''}|${m.listened ? 1 : 0}|${m.entities?.map((e) => e.type + e.offset + ':' + e.length + (e.url ?? '')).join(',') ?? ''}|${m.todo ? JSON.stringify(m.todo) : ''}|${m.service?.data ? JSON.stringify(m.service.data) : ''}|${m.buttons ? JSON.stringify(m.buttons) : ''}|${m.views ?? ''}|${m.reactionCounts?.map((r) => r[0] + r[1]).join(',') ?? ''}|${m.myReaction ?? ''}|${m.postAuthor ?? ''}|${m.replies ? m.replies.count + ':' + m.replies.lastId + ':' + m.replies.recent.join(',') + ':' + (m.replies.readMaxId ?? '') : ''}`;
const msgCache = new WeakMap<LocalMessage, { sig: string; item: Item }>();
export const messageItem = (m: LocalMessage, q: Quote): { item: Item; sig: string } => {
  const sig = msgSig(m, q);
  let c = msgCache.get(m);
  if (!c || c.sig !== sig) { c = { sig, item: { ...m, reply: q } }; msgCache.set(m, c); }
  return c;
};

/** Первый индекс в [lo, hi) с sort >= s (массив отсортирован по sort). */
function lowerBound(arr: LocalMessage[], s: number, lo = 0, hi = arr.length): number {
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].sort < s) lo = mid + 1; else hi = mid; }
  return lo;
}
/** Первый индекс с sort > s. */
function upperBound(arr: LocalMessage[], s: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].sort <= s) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Отрезок истории для ленты у sort: тот, где sort, иначе ближайший новее; без sort и новее всех — живой (последний). -1 — отрезков нет. */
export function rangeAt(ranges: readonly [number, number][], sort?: number): number {
  const n = ranges.length;
  if (sort == null || n === 0 || sort > ranges[n - 1][1]) return n - 1;
  let i = 0;
  while (ranges[i][1] < sort) i++;
  return i;
}

/**
 * Где лента в отсортированных сообщениях чата: [lo, hi) — сообщения отрезка истории у sort (у живого — и всё,
 * что после него: неотправленные). start — отрезок от начала истории; live — отрезок живой (за ним новее нет).
 * Сообщения вне отрезка (догруженные отдельно, за дырой) в ленту не попадают.
 */
export function feedSpan(chat: Pick<LocalChat, 'ranges' | 'historyStart'> | undefined, all: LocalMessage[], sort?: number): { lo: number; hi: number; i: number; start: boolean; live: boolean } {
  if (!chat) return { lo: 0, hi: all.length, i: -1, start: false, live: true };
  const ranges = chat.ranges, i = rangeAt(ranges, sort), live = i === ranges.length - 1;
  const lo = lowerBound(all, i < 0 ? PENDING_BASE : ranges[i][0]);
  return { lo, hi: live ? all.length : upperBound(all, ranges[i][1]), i, start: i <= 0 && !!chat.historyStart, live };
}

/** Границы окна ленты [from, to) по запросу внутри [lo, hi) (отрезок истории, feedSpan). */
export function messageWindow(all: LocalMessage[], q: Pick<Extract<Query, { kind: 'messages' }>, 'limit' | 'anchor'>, lo = 0, hi = all.length): { from: number; to: number } {
  const limit = q.limit;
  if (!q.anchor) return { from: Math.max(lo, hi - limit), to: hi };
  const i = lowerBound(all, q.anchor.sort, lo, hi);
  if (q.anchor.side === 'end') { const to = Math.min(hi, i < hi && all[i].sort === q.anchor.sort ? i + 1 : i); return { from: Math.max(lo, to - limit), to }; }
  if (q.anchor.side === 'start') return { from: i, to: Math.min(hi, i + limit) };
  let from = Math.max(lo, i - (limit >> 1));
  const to = Math.min(hi, from + limit);
  from = Math.max(lo, to - limit);
  return { from, to };
}

/** Комментарии треда из кэша группы (по порядку; массив кэшируется вместе с отсортированной лентой чата). */
const threadCache = new WeakMap<LocalMessage[], Map<number, LocalMessage[]>>();
export function threadMessages(store: Store, chatId: number, threadId: number): LocalMessage[] {
  const all = store.chatMessages(chatId);
  let by = threadCache.get(all);
  if (!by) { by = new Map(); threadCache.set(all, by); }
  let list = by.get(threadId);
  if (!list) { list = all.filter((m) => m.threadId === threadId); by.set(threadId, list); }
  return list;
}
/** Тред: его комментарии и где окно (отрезки треда; не открывали — только неотправленные). */
export function threadView(store: Store, q: Extract<Query, { kind: 'thread' }>) {
  const all = threadMessages(store, q.chatId, q.threadId);
  const span = feedSpan(store.threadRanges(q.chatId, q.threadId) ?? { ranges: [] }, all, q.anchor?.sort);
  return { all, span, ...messageWindow(all, q, span.lo, span.hi) };
}

/** Окно сообщений → элементы с цитатами (лента чата и тред). */
function windowItems(store: Store, chatId: number, all: LocalMessage[], from: number, to: number, out: Result): void {
  const missingQuotes = new Set<number>();
  for (let k = from; k < to; k++) {
    const m = all[k];
    let quote: Quote = null;
    if (m.replyToId != null) {
      const r = store.messageById(chatId, m.replyToId);
      quote = r ? toQuote(r) : store.quoteFor(chatId, m.replyToId) ?? null;
      if (!quote) missingQuotes.add(m.replyToId);
    }
    const { item, sig: g } = messageItem(m, quote);
    out.items.set(item.key, item); out.sig.set(item.key, g); out.order.push(item.key);
  }
  if (missingQuotes.size) store.wantQuotes(chatId, [...missingQuotes]);
}

export function computeQuery(store: Store, q: Query, mute: Map<number, number | null> = new Map(), flags: Map<number, FlagsOp> = new Map()): Result {
  switch (q.kind) {
    case 'chatList': {
      // закреплённые — сверху, в порядке закрепления (позже — выше), новые сообщения их не двигают; дальше — по последнему
      const pin = (c: LocalChat) => flagsOf(c, flags.get(c.id)).pinnedAt;
      const chats = [...store.chats.values()].filter((c) => !store.previews.has(c.id)).sort((a, b) => {
        const pa = pin(a), pb = pin(b);
        if (pa != null || pb != null) { if (pa == null) return 1; if (pb == null) return -1; if (pa !== pb) return pb - pa; }
        const x = sortAt(a), y = sortAt(b); return x < y ? 1 : x > y ? -1 : b.id - a.id;
      });
      const items = new Map<string, Item>(), sig = new Map<string, string>(), order: string[] = [];
      for (const c of chats.slice(0, q.limit)) {
        const { item, sig: g } = chatListItem(store, c, mute, flags);
        items.set(item.key, item); sig.set(item.key, g); order.push(item.key);
      }
      return { items, sig, order };
    }
    case 'previews': {
      // превью каналов без подписки: те же строки, что у списка, с пометкой preview (canSend — false: me нет)
      const items = new Map<string, Item>(), sig = new Map<string, string>(), order: string[] = [];
      for (const id of store.previews) {
        const c = store.chats.get(id);
        if (!c) continue;
        const { item, sig: g } = chatListItem(store, c, mute, flags);
        const it = { ...item, preview: true };
        items.set(it.key, it); sig.set(it.key, g); order.push(it.key);
      }
      return { items, sig, order };
    }
    case 'messages': {
      // только окно: бинарный поиск по отсортированному кэшу, подписи — без сериализации
      const all = store.chatMessages(q.chatId);
      const chat = store.chats.get(q.chatId);
      const span = feedSpan(chat, all, q.anchor?.sort);
      const { from, to } = messageWindow(all, q, span.lo, span.hi);
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
      // служебный элемент: есть ли что-то за краями окна (интерфейс по нему решает, двигать ли окно);
      // старее — и за началом отрезка, пока он не от начала истории; новее — и за концом не живого отрезка
      const meta: Item = { key: '~window', hasOlder: from > span.lo || !span.start, hasNewer: to < span.hi || !span.live, live: !q.anchor || (span.live && to === span.hi) };
      items.set(meta.key, meta); sig.set(meta.key, `${meta.hasOlder}|${meta.hasNewer}|${meta.live}`); order.push(meta.key);
      if (missingQuotes.size) store.wantQuotes(q.chatId, [...missingQuotes]);
      return { items, sig, order };
    }
    case 'thread': {
      // шапка — копия поста (из того же кэша сообщений группы), дальше окно комментариев по отрезкам треда
      const { all, span, from, to } = threadView(store, q);
      const out: Result = { items: new Map(), sig: new Map(), order: [] };
      const header = store.messageById(q.chatId, q.threadId);
      if (header) { const { item, sig: g } = messageItem(header, null); out.items.set(item.key, item); out.sig.set(item.key, g); out.order.push(item.key); }
      windowItems(store, q.chatId, all, from, to, out);
      const meta: Item = { key: '~window', hasOlder: from > span.lo || !span.start, hasNewer: to < span.hi || !span.live, live: !q.anchor || (span.live && to === span.hi) };
      const th: Item = { key: '~thread', header: header?.key ?? null, loaded: !!store.threadRanges(q.chatId, q.threadId) };
      for (const it of [meta, th]) { out.items.set(it.key, it); out.sig.set(it.key, JSON.stringify(it)); out.order.push(it.key); }
      return out;
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
      // архив — отдельно (бейдж строки «Архив»); пометка «непрочитанное» — непрочитанный чат без сообщений в счёте
      let unreadChats = 0, unreadMessages = 0, archivedUnread = 0;
      for (const c of store.chats.values()) {
        if (store.previews.has(c.id)) continue;   // превью канала — не подписка
        const f = flagsOf(c, flags.get(c.id));
        if (!(c.unread > 0 || f.unreadMark)) continue;
        if (f.archived) { archivedUnread++; continue; }
        unreadChats++; unreadMessages += c.unread;
      }
      return result([{ key: 'counters', unreadChats, unreadMessages, archivedUnread }]);
    }
    case 'notifications': return result(store.notifications);
    case 'status':
    case 'presence':
    case 'me':
    case 'user':
    case 'people':
    case 'ops':
    case 'contacts':
    case 'settings':
    case 'blocked':
    case 'members':
    case 'media':
    case 'profileMusic':
    case 'profilePhotos':
    case 'devStats':
    case 'devLog':
      throw new Error(q.kind + ' is computed by the engine');
  }
}

/** Задевает ли изменение этих чатов результат подписки. */
export function affects(q: Query, touched: Set<number>): boolean {
  if (!touched.size) return false;
  if (q.kind === 'status' || q.kind === 'me' || q.kind === 'user' || q.kind === 'people' || q.kind === 'ops' || q.kind === 'contacts' || q.kind === 'settings' || q.kind === 'blocked' || q.kind === 'members' || q.kind === 'profileMusic' || q.kind === 'profilePhotos' || q.kind === 'devStats' || q.kind === 'devLog') return false;   // у них свои флаги в движке
  return q.kind === 'messages' || q.kind === 'media' || q.kind === 'thread' ? touched.has(q.chatId) : true;
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
