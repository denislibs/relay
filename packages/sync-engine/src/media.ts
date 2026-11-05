import type { MediaCounts, MediaTab, Message } from '@relay/protocol';
import { tabsOf } from './derive';
import { messageItem } from './queries';
import type { Store } from './store';
import type { Item, LocalChat, LocalMessage, Query } from './types';

/*
 * «Общие медиа» из воркера. Состав вкладок — в памяти, из сообщений чата (tabsOf: вкладки пересекаются, фото со
 * ссылкой — и медиа, и ссылки); сообщения в IndexedDB вместе с остальными (страницы вкладок — addLoose, вне ленты).
 * Вкладка известна подряд от новых: живой отрезок ленты целиком и страницы /media старше (chat.mediaDone).
 * Счётчики — снимок /media/counts, дальше их ведёт onMessage (derive.ts).
 */

type MediaQuery = Extract<Query, { kind: 'media' }>;
type Reply = { messages: Message[]; hasMore: boolean };

// состав вкладок по отсортированному массиву сообщений чата (store.chatMessages кэширует его до изменения чата)
const tabsCache = new WeakMap<LocalMessage[], Map<MediaTab, LocalMessage[]>>();
/** Сообщения вкладки по возрастанию sort. Не мутировать. */
export function tabMessages(store: Store, chatId: number, tab: MediaTab, savedPeer?: string): LocalMessage[] {
  const all = store.chatMessages(chatId);
  if (savedPeer) return savedTab(store, chatId, all, tab, savedPeer);
  let by = tabsCache.get(all);
  if (!by) {
    by = new Map();
    for (const m of all) for (const t of tabsOf(m)) { let l = by.get(t); if (!l) { l = []; by.set(t, l); } l.push(m); }
    tabsCache.set(all, by);
  }
  return by.get(tab) ?? [];
}

const peerTabs = new WeakMap<LocalMessage[], Map<string, LocalMessage[]>>();
function savedTab(store: Store, chatId: number, all: LocalMessage[], tab: MediaTab, peer: string): LocalMessage[] {
  let by = peerTabs.get(all);
  if (!by) { by = new Map(); peerTabs.set(all, by); }
  const k = peer + ':' + tab;
  let list = by.get(k);
  if (!list) { list = tabMessages(store, chatId, tab).filter((m) => m.savedPeer === peer); by.set(k, list); }
  return list;
}

/** Откуда знать счётчики и подряд известное: подчат «Избранного» — своя запись, иначе строка чата. */
const holder = (chat: LocalChat | undefined, peer?: string): Pick<LocalChat, 'mediaDone' | 'mediaCounts' | 'mediaCountsAt'> | undefined => (peer ? chat?.savedViews?.[peer] : chat);

/**
 * С какого id вкладка известна подряд до самого нового: true — целиком; Infinity — ничего (страницу — с новейшего края).
 * Живой отрезок ленты содержит всё своё — и все сообщения вкладки в нём; страница вкладки старше — её mediaDone.
 */
export function mediaFloor(chat: LocalChat | undefined, tab: MediaTab, savedPeer?: string): number | true {
  if (!chat) return Infinity;
  const done = holder(chat, savedPeer)?.mediaDone?.[tab], live = chat.ranges[chat.ranges.length - 1];
  if (done === true || (chat.historyStart && chat.ranges.length === 1)) return true;
  return Math.min(done ?? Infinity, live ? live[0] : Infinity);
}

/** Что показать: сообщения вкладки от floor и новее, новые сверху; more — за limit есть ещё (в памяти или на сервере). */
function visible(store: Store, q: MediaQuery): { list: LocalMessage[]; more: boolean; floor: number | true } {
  const all = tabMessages(store, q.chatId, q.tab, q.savedPeer), floor = mediaFloor(store.chats.get(q.chatId), q.tab, q.savedPeer);
  let lo = 0;
  if (floor !== true) while (lo < all.length && all[lo].sort < floor) lo++;
  const from = Math.max(lo, all.length - q.limit);
  return { list: all.slice(from).reverse(), more: from > lo || floor !== true, floor };
}

/** Подписка media: элементы — сообщения (как в ленте, без цитат), служебный ~media {done, loading, counts}. */
export function mediaResult(store: Store, q: MediaQuery, loading: boolean): { items: Map<string, Item>; order: string[]; sig: Map<string, string> } {
  const items = new Map<string, Item>(), sig = new Map<string, string>(), order: string[] = [];
  const { list, more } = visible(store, q);
  for (const m of list) {
    const { item, sig: g } = messageItem(m, null);
    items.set(item.key, item); sig.set(item.key, g); order.push(item.key);
  }
  const counts = holder(store.chats.get(q.chatId), q.savedPeer)?.mediaCounts ?? null;
  const meta: Item = { key: '~media', done: !more, loading: loading || !store.isLoaded(q.chatId), counts: counts ? { ...counts } : null };
  items.set(meta.key, meta); sig.set(meta.key, JSON.stringify(meta)); order.push(meta.key);
  return { items, order, sig };
}

/** Пауза после отказа чтения из IndexedDB: без неё каждый проход подписок запускал бы его снова. */
export const MEDIA_LOAD_RETRY_MS = 5000;

/**
 * Загрузка для подписок media: сообщения чата из IndexedDB, счётчики (раз, пока их нет) и страница вкладки старше
 * известного, когда подписке не хватает (одна на чат и вкладку). Отказ сети — до переподключения не повторяем,
 * отказ IndexedDB — не раньше MEDIA_LOAD_RETRY_MS.
 */
export class MediaLoader {
  private busy = new Set<string>();
  private failed = new Set<string>();
  /** отказ чтения из IndexedDB: ключ → когда можно снова */
  private retryAt = new Map<string, number>();

  constructor(private store: Store, private deps: {
    online: () => boolean;
    http: <T>(path: string) => Promise<T>;
    run: (fn: () => Promise<unknown>) => void;
    changed: () => void;
  }) {}

  /** Чаты, для которых идёт загрузка (сообщения из IDB, счётчики, страница вкладки): уборка их не трогает. */
  busyChats(): Set<number> {
    const out = new Set<number>();
    for (const k of this.busy) out.add(parseInt(k.startsWith('load:') || k.startsWith('counts:') ? k.slice(k.indexOf(':') + 1) : k, 10));
    return out;
  }

  loading(chatId: number, tab: MediaTab, savedPeer?: string): boolean { return this.busy.has(chatId + ':' + tab + (savedPeer ? ':' + savedPeer : '')) || this.busy.has('load:' + chatId) || (!!savedPeer && this.busy.has('counts:' + chatId + ':' + savedPeer)); }

  /** Новое подключение или сброс кэша: отказы прошлого — спросим снова. */
  reconnect(): void { this.failed.clear(); this.retryAt.clear(); }

  want(q: MediaQuery): void {
    const { chatId, tab, savedPeer } = q;
    if (!this.store.isLoaded(chatId)) {
      this.task('load:' + chatId, chatId, async () => { await this.store.loadChatMessages(chatId); }, false);
      return;
    }
    const chat = this.store.chats.get(chatId);
    if (!chat || !this.deps.online()) return;
    const qs = savedPeer ? '&savedPeer=' + encodeURIComponent(savedPeer) : '';
    const view = () => { const c = this.store.chats.get(chatId); return c && savedPeer ? ((c.savedViews ??= {})[savedPeer] ??= {}) : c; };
    if (!holder(chat, savedPeer)?.mediaCounts) {
      this.task('counts:' + chatId + (savedPeer ? ':' + savedPeer : ''), chatId, async () => {
        const gen = this.store.resetGen;
        const r = await this.deps.http<MediaCounts>(`/chats/${chatId}/media/counts${savedPeer ? '?savedPeer=' + encodeURIComponent(savedPeer) : ''}`);
        const c = this.store.chats.get(chatId), h = view();
        if (!c || !h || gen !== this.store.resetGen) return;
        // всё, что уже известно, сервер посчитал; новее — прибавит onMessage
        h.mediaCounts = { media: r.media ?? 0, file: r.file ?? 0, audio: r.audio ?? 0, voice: r.voice ?? 0, link: r.link ?? 0, ...(typeof r.video === 'number' ? { video: r.video } : {}) };
        h.mediaCountsAt = c.knownMaxId;
        this.store.markChat(c);
      });
    }
    const v = visible(this.store, q);
    if (v.floor === true || v.list.length >= q.limit) return;
    const floor = v.floor;
    this.task(chatId + ':' + tab + (savedPeer ? ':' + savedPeer : ''), chatId, async () => {
      const gen = this.store.resetGen, trims = this.store.trimGen(chatId);
      const r = await this.deps.http<Reply>(`/chats/${chatId}/media?kind=${tab}${Number.isFinite(floor) ? '&beforeId=' + floor : ''}${qs}`);
      const c = this.store.chats.get(chatId), h = view();
      if (!c || !h || gen !== this.store.resetGen) return;   // ответ после сброса — устарел
      this.store.addLoose(chatId, r.messages);
      // пока ждали, уборка стёрла часть вкладки над floor — страница уже не продолжает известное подряд
      if (trims !== this.store.trimGen(chatId)) return;
      let lo = floor;
      for (const m of r.messages) if (m.id < lo) lo = m.id;
      h.mediaDone = { ...h.mediaDone, [tab]: r.hasMore && r.messages.length ? lo : true };
      this.store.markChat(c);
    });
  }

  private task(key: string, chatId: number, fn: () => Promise<void>, net = true): void {
    if (this.busy.has(key) || this.failed.has(key) || (this.retryAt.get(key) ?? 0) > Date.now()) return;
    this.busy.add(key);
    this.store.retouch(chatId);   // loading в ~media
    this.deps.run(async () => {
      try { await fn(); await this.store.flush(); }
      catch (err) { if (net) this.failed.add(key); else this.retryAt.set(key, Date.now() + MEDIA_LOAD_RETRY_MS); throw err; }
      finally { this.busy.delete(key); this.store.retouch(chatId); this.deps.changed(); }
    });
  }
}
