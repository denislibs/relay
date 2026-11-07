import type { SavedDialog, SavedDialogsPage } from '@relay/protocol';
import { chatTitle, personView } from './names';
import { lowerBound, messageWindow, windowItems, type Result } from './queries';
import type { Store } from './store';
import { PENDING_BASE, type Item, type LocalChat, type LocalMessage, type Query } from './types';

/*
 * Подчаты «Избранного» на устройстве. Список — кэш страниц сервера (хранилище savedDialogs), дальше его ведут события журнала
 * savedDialog (итоги) и сами сообщения (последнее). Лента, медиа и поиск подчата — фильтр сообщений чата по savedPeer: общая
 * лента не меняется. Без сети всё открывается из IndexedDB.
 */

export type SavedRow = Omit<SavedDialog, 'last'> & { last: LocalMessage | null };
export interface SavedMeta { loaded: boolean; total: number; messages: number; next: number | null }
const NO_META: SavedMeta = { loaded: false, total: 0, messages: 0, next: null };

/** Операция закрепления подчата: ключ savedPin:<peer>, тело {pinned, at}. Видно сразу, до ответа сервера. */
export const savedPinKey = (peer: string) => 'savedPin:' + peer;
/** Операция удаления подчата: ключ savedDelete:<peer>. Пока она в очереди, строка не показывается (страница её не вернёт на экран). */
export const savedDeleteKey = (peer: string) => 'savedDelete:' + peer;
type OpLike = { key: string; body?: unknown };

export class SavedDialogsCache {
  rows = new Map<string, SavedRow>();
  meta: SavedMeta = { ...NO_META };
  /** Сколько раз менялись итоги с прошлого чтения страницы: страницу, начатую раньше, не применяем (она старше журнала). */
  rev = 0;
  /** Строке не хватает названия или последнего сообщения: движок перечитает первую страницу. */
  want = false;
  private dirty = new Set<string>();
  private removed = new Set<string>();
  private metaDirty = false;

  static async load(rows: SavedRow[], meta: { k: string; v: unknown }[]): Promise<SavedDialogsCache> {
    const c = new SavedDialogsCache();
    for (const r of rows) c.rows.set(r.peer, r);
    const m = meta.find((x) => x.k === 'savedDialogs')?.v as SavedMeta | undefined;
    if (m) c.meta = m;
    return c;
  }

  put(r: SavedRow): void { this.rows.set(r.peer, r); this.dirty.add(r.peer); this.removed.delete(r.peer); }
  drop(peer: string): void { if (this.rows.delete(peer)) { this.removed.add(peer); this.dirty.delete(peer); } }
  setMeta(m: Partial<SavedMeta>): void { this.meta = { ...this.meta, ...m }; this.metaDirty = true; }
  reset(): void { for (const p of this.rows.keys()) this.removed.add(p); this.rows.clear(); this.dirty.clear(); this.meta = { ...NO_META }; this.metaDirty = true; this.rev++; }

  collect(): { put: SavedRow[]; del: string[]; meta: { k: string; v: number } | null } {
    const put = [...this.dirty].map((k) => this.rows.get(k)).filter(Boolean) as SavedRow[], del = [...this.removed];
    const meta = this.metaDirty ? { k: 'savedDialogs', v: this.meta as unknown as number } : null;
    this.dirty.clear(); this.removed.clear(); this.metaDirty = false;
    return { put, del, meta };
  }
}

const savedChatOf = (store: Store): LocalChat | undefined => { for (const c of store.chats.values()) if (c.saved) return c; return undefined; };
export { savedChatOf };

function toLocal(store: Store, d: SavedDialog): SavedRow {
  const last = d.lastId != null && store.isLoaded(d.last?.chatId ?? -1) ? store.messageById(d.last!.chatId, d.lastId) : undefined;
  return { ...d, last: last ?? (d.last ? store.localOf(d.last) : null) };
}

/**
 * Страница сервера. Первая (at нет) заменяет известное: строки, которых в ней нет, но новее её последней незакреплённой, — исчезли.
 * Страницу, начатую до более свежего события журнала, вызывающий не применяет (rev).
 */
export function applySavedPage(store: Store, chatId: number, page: SavedDialogsPage, at: number | null): void {
  const cache = store.savedDialogs;
  const seen = new Set<string>();
  for (const d of page.dialogs) { seen.add(d.peer); cache.put(toLocal(store, d)); }
  if (at == null) {
    const floor = page.next == null ? -Infinity : Math.min(...page.dialogs.filter((d) => d.peer !== 'me' && !d.pinnedAt).map((d) => d.lastId ?? Infinity));
    for (const [peer, r] of [...cache.rows]) {
      if (seen.has(peer)) continue;
      if (r.peer === 'me' || r.pinnedAt != null || (r.lastId ?? 0) >= floor) cache.drop(peer);
    }
  }
  cache.setMeta({ loaded: true, total: page.total, messages: page.messages, next: page.next });
  store.touch(chatId);
}

/** Событие журнала: итоги подчата. Строка новая или последнего не знаем — перечитать страницу. */
export function applySavedEvent(store: Store, u: { chatId: number; peer: string; count: number; lastId: number | null; pinnedAt: number | null; dialogs: number; messages: number }): void {
  const cache = store.savedDialogs;
  cache.rev++;
  cache.setMeta({ total: u.dialogs, messages: u.messages });
  if (!u.count) { cache.drop(u.peer); store.touch(u.chatId); return; }
  const row = cache.rows.get(u.peer);
  const known = u.lastId != null ? store.messageById(u.chatId, u.lastId) : undefined;
  const last = known ?? (row?.last?.id === u.lastId ? row!.last : null);
  if (!row || !last) cache.want = true;
  cache.put({ ...(row ?? blankRow(u.peer, last)), count: u.count, lastId: u.lastId, pinnedAt: u.pinnedAt, last });
  store.touch(u.chatId);
}

/** Строка из того, что есть на устройстве, пока сервер не ответил: названия и фото — из заголовка «Переслано от». */
function blankRow(peer: string, m: LocalMessage | null): SavedRow {
  const f = m?.fwdFrom ?? null;
  const kind = peer[0] === 'u' ? 'user' : peer[0] === 'c' ? (f?.userId == null ? 'channel' : 'group') : null;
  return { peer, count: 0, lastId: m?.id ?? null, last: m, pinnedAt: null, title: f?.name ?? null, photo: f?.photo ?? null, kind, access: false };
}

/**
 * Сообщение чата «Избранное» добавлено, изменено или удалено (derive.ts onMessage). Итоги — только у неотправленного
 * (остальное скажет событие savedDialog); удаление — оптимистично: последнее берём из памяти, журнал поправит.
 */
export function savedOnMessage(store: Store, chat: LocalChat, m: LocalMessage, kind: 'added' | 'edited' | 'deleted', prev?: LocalMessage): void {
  const peer = m.savedPeer ?? prev?.savedPeer;
  if (!peer) return;
  const cache = store.savedDialogs;
  const row = cache.rows.get(peer);
  if (kind === 'deleted') {
    if (!row) return;
    const count = row.count - 1;
    cache.setMeta({ messages: Math.max(0, cache.meta.messages - 1), ...(count <= 0 ? { total: Math.max(0, cache.meta.total - 1) } : {}) });
    if (count <= 0) { cache.drop(peer); store.touch(chat.id); return; }
    const was = row.last?.key === m.key;
    const list = was ? savedMessages(store, chat.id, peer) : null;
    const next = list ? [...list].reverse().find((x) => x.key !== m.key) ?? null : row.last;
    if (was && !next) cache.want = true;
    cache.put({ ...row, count, last: next, lastId: next ? next.id : row.lastId });
    store.touch(chat.id);
    return;
  }
  if (m.deleted) return;
  if (m.id == null && !prev) {
    // своё, ещё не дошедшее: подчат виден сразу и без сети (придёт событие — итоги сервера перекроют)
    cache.setMeta({ messages: cache.meta.messages + 1, ...(row ? {} : { total: cache.meta.total + 1 }) });
    cache.put({ ...(row ?? blankRow(peer, m)), count: (row?.count ?? 0) + 1, last: m });
    store.touch(chat.id);
    return;
  }
  if (!row) return;
  if (row.last?.key === m.key || !row.last || m.sort >= row.last.sort) { cache.put({ ...row, last: m, lastId: m.id ?? row.lastId }); store.touch(chat.id); }
}

/** Подчат удаляют с этого устройства: строка и всё, что в кэше, уходит сразу (сервер сотрёт очередью операций). */
export function dropSavedLocally(store: Store, chatId: number, peer: string, upToId: number): void {
  for (const m of [...savedMessages(store, chatId, peer)]) if (m.id != null && m.id <= upToId) store.applyUpdate({ type: 'messageDeleted', chatId, id: m.id });
  const row = store.savedDialogs.rows.get(peer);
  if (row) {
    store.savedDialogs.setMeta({ messages: Math.max(0, store.savedDialogs.meta.messages - row.count), total: Math.max(0, store.savedDialogs.meta.total - 1) });
    store.savedDialogs.drop(peer);
  }
  store.touch(chatId);
}

// ---------- лента подчата ----------

const byPeer = new WeakMap<LocalMessage[], Map<string, LocalMessage[]>>();
/** Сообщения подчата по порядку, без удалённых. Массив кэшируется вместе с отсортированной лентой чата. Не мутировать. */
export function savedMessages(store: Store, chatId: number, peer: string): LocalMessage[] {
  const all = store.chatMessages(chatId);
  let by = byPeer.get(all);
  if (!by) {
    by = new Map();
    for (const m of all) if (m.savedPeer && !m.deleted) { const l = by.get(m.savedPeer); if (l) l.push(m); else by.set(m.savedPeer, [m]); }
    byPeer.set(all, by);
  }
  return by.get(peer) ?? [];
}

/** С какого sort лента подчата известна подряд до живого края: всё, что в живом отрезке чата, и страницы подчата старше. */
export function savedFloor(chat: LocalChat | undefined, peer: string): number | true {
  if (!chat) return Infinity;
  const own = chat.savedViews?.[peer]?.floor, live = chat.ranges[chat.ranges.length - 1];
  if (own === true || (chat.historyStart && chat.ranges.length === 1)) return true;
  return Math.min(own ?? Infinity, live ? live[0] : Infinity);
}

type FeedQuery = Extract<Query, { kind: 'savedFeed' }>;
export function savedView(store: Store, q: FeedQuery): { all: LocalMessage[]; lo: number; hi: number; floor: number | true; from: number; to: number } {
  const all = savedMessages(store, q.chatId, q.peer), floor = savedFloor(store.chats.get(q.chatId), q.peer);
  const lo = floor === true ? 0 : lowerBound(all, Math.min(floor, PENDING_BASE)), hi = all.length;
  return { all, lo, hi, floor, ...messageWindow(all, q, lo, hi) };
}

/** Окно ленты подчата: те же элементы, что у ленты чата, и служебный ~window. */
export function savedFeedResult(store: Store, q: FeedQuery): Result {
  const { all, lo, hi, floor, from, to } = savedView(store, q);
  const out: Result = { items: new Map(), sig: new Map(), order: [] };
  windowItems(store, q.chatId, all, from, to, out);
  const meta: Item = { key: '~window', hasOlder: from > lo || floor !== true, hasNewer: to < hi, live: !q.anchor || to === hi, filling: !q.anchor && floor !== true && to === from };
  out.items.set(meta.key, meta); out.sig.set(meta.key, JSON.stringify(meta)); out.order.push(meta.key);
  return out;
}

// ---------- список подчатов ----------

/** Как в списке чатов: что нужно строке для превью (без файлов и всего сообщения). */
const lastItem = (m: LocalMessage | null) => (m ? { key: m.key, id: m.id, senderId: m.senderId, body: m.body, status: m.status, createdAt: m.createdAt, deleted: !!m.deleted, kind: m.kind ?? 'text', attachmentName: m.attachment?.name ?? null, attachmentTitle: m.attachment?.title ?? null, attachmentPerformer: m.attachment?.performer ?? null, entities: m.entities ?? null, thumb: m.attachment?.thumb ?? null, mime: m.attachment?.mime ?? null,
  ...(m.sticker ? { sticker: m.sticker } : {}), ...(m.fwdFrom ? { fwd: true } : null), ...(m.service ? { service: m.service } : null) } : null);

/** Операции закрепления в очереди: их значение перекрывает строку. */
export function savedPinOverlay(ops: readonly OpLike[]): Map<string, { pinned: boolean; at: number }> {
  const out = new Map<string, { pinned: boolean; at: number }>();
  for (const o of ops) if (o.key.startsWith('savedPin:')) out.set(o.key.slice(9), o.body as { pinned: boolean; at: number });
  return out;
}

/** Порядок строк: заметки всегда первой, дальше закреплённые (позже закреплённый — выше), дальше по последнему сообщению. */
export function savedOrder<T extends { peer: string; pinnedAt: number | null; lastSort: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.peer === 'me' || b.peer === 'me') return a.peer === 'me' ? -1 : 1;
    if (a.pinnedAt != null || b.pinnedAt != null) { if (a.pinnedAt == null) return 1; if (b.pinnedAt == null) return -1; if (a.pinnedAt !== b.pinnedAt) return b.pinnedAt - a.pinnedAt; }
    return b.lastSort - a.lastSort;
  });
}

/**
 * Подписка savedDialogs. Название и фото: заметки и «Автор скрыт» подписывает интерфейс; человек — как его видит зритель сейчас
 * (names.ts); чат, где я состою, — из его строки; остальное — то, что отдал сервер (он уже проверил права: сохранённое в
 * fwd_from или публичный канал). Служебный ~saved: loaded, total, messages, done, chatId.
 */
export function savedDialogsResult(store: Store, ops: readonly OpLike[]): Result {
  const cache = store.savedDialogs, pins = savedPinOverlay(ops);
  const gone = new Set(ops.filter((o) => o.key.startsWith('savedDelete:')).map((o) => o.key.slice(12)));
  const rows: (Item & { peer: string; pinnedAt: number | null; lastSort: number })[] = [];
  for (const r of cache.rows.values()) {
    if (gone.has(r.peer)) continue;
    const over = pins.get(r.peer);
    let { title, photo } = r;
    let kind = r.kind, access = r.access;
    const id = Number(r.peer.slice(1));
    if (r.peer[0] === 'u') {
      const p = personView(store, id);
      if (p) { title = p.name ?? title; photo = p.photo ?? null; }
      if (!store.users.get(id)) store.wantUser(id);
    } else if (r.peer[0] === 'c') {
      const c = store.chats.get(id);
      if (c?.group && !store.previews.has(id)) { title = chatTitle(store, c); photo = c.group.photo ?? null; kind = c.kind === 'channel' ? 'channel' : 'group'; access = true; }
    }
    rows.push({
      key: r.peer, peer: r.peer, count: r.count, lastId: r.lastId, lastSort: r.last?.sort ?? r.lastId ?? 0, last: lastItem(r.last), createdAt: r.last?.createdAt ?? null, pinnedAt: over ? (over.pinned ? r.pinnedAt ?? over.at : null) : r.pinnedAt,
      title, photo, kind, access, ...(r.userId != null ? { userId: r.userId } : r.peer[0] === 'u' ? { userId: id } : {}), ...(r.key ? { peerKey: r.key } : {}), ...(access && r.peer[0] === 'c' ? { sourceChatId: id } : {}),
    });
  }
  const list = savedOrder(rows);
  const out: Result = { items: new Map(), sig: new Map(), order: [] };
  for (const it of list) { out.items.set(it.key, it); out.sig.set(it.key, JSON.stringify(it)); out.order.push(it.key); }
  // подчат, скрытый ожидающим удалением, может снова оказаться в кэше (событие сервера пришло после локального удаления):
  // вычесть и его, и его сообщения — иначе счётчик сообщений отстаёт до ответа сервера
  const hidden = [...gone].map((p) => cache.rows.get(p)).filter((r) => r != null);
  const meta: Item = { key: '~saved', loaded: cache.meta.loaded, total: Math.max(0, cache.meta.total - hidden.length), messages: Math.max(0, cache.meta.messages - hidden.reduce((n, r) => n + r.count, 0)), done: cache.meta.next == null, chatId: savedChatOf(store)?.id ?? null };
  out.items.set(meta.key, meta); out.sig.set(meta.key, JSON.stringify(meta)); out.order.push(meta.key);
  return out;
}
