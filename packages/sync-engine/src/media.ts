import type { MediaTab, Message } from '@relay/protocol';
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
export function tabMessages(store: Store, chatId: number, tab: MediaTab): LocalMessage[] {
  const all = store.chatMessages(chatId);
  let by = tabsCache.get(all);
  if (!by) {
    by = new Map();
    for (const m of all) for (const t of tabsOf(m)) { let l = by.get(t); if (!l) { l = []; by.set(t, l); } l.push(m); }
    tabsCache.set(all, by);
  }
  return by.get(tab) ?? [];
}

/**
 * С какого id вкладка известна подряд до самого нового: true — целиком; Infinity — ничего (страницу — с новейшего края).
 * Живой отрезок ленты содержит всё своё — и все сообщения вкладки в нём; страница вкладки старше — её mediaDone.
 */
export function mediaFloor(chat: LocalChat | undefined, tab: MediaTab): number | true {
  if (!chat) return Infinity;
  const done = chat.mediaDone?.[tab], live = chat.ranges[chat.ranges.length - 1];
  if (done === true || (chat.historyStart && chat.ranges.length === 1)) return true;
  return Math.min(done ?? Infinity, live ? live[0] : Infinity);
}

/** Что показать: сообщения вкладки от floor и новее, новые сверху; more — за limit есть ещё (в памяти или на сервере). */
function visible(store: Store, q: MediaQuery): { list: LocalMessage[]; more: boolean; floor: number | true } {
  const all = tabMessages(store, q.chatId, q.tab), floor = mediaFloor(store.chats.get(q.chatId), q.tab);
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
  const counts = store.chats.get(q.chatId)?.mediaCounts ?? null;
  const meta: Item = { key: '~media', done: !more, loading: loading || !store.isLoaded(q.chatId), counts: counts ? { ...counts } : null };
  items.set(meta.key, meta); sig.set(meta.key, JSON.stringify(meta)); order.push(meta.key);
  return { items, order, sig };
}

/**
 * Загрузка для подписок media: сообщения чата из IndexedDB, счётчики (раз, пока их нет) и страница вкладки старше
 * известного, когда подписке не хватает (одна на чат и вкладку). Отказ — до переподключения не повторяем.
 */
export class MediaLoader {
  private busy = new Set<string>();
  private failed = new Set<string>();

  constructor(private store: Store, private deps: {
    online: () => boolean;
    http: <T>(path: string) => Promise<T>;
    run: (fn: () => Promise<unknown>) => void;
    changed: () => void;
  }) {}

  /** Чаты, для которых идёт загрузка (сообщения из IDB, счётчики, страница вкладки): уборка их не трогает. */
  busyChats(): Set<number> {
    const out = new Set<number>();
    for (const k of this.busy) out.add(Number(k.startsWith('load:') || k.startsWith('counts:') ? k.slice(k.indexOf(':') + 1) : k.slice(0, k.indexOf(':'))));
    return out;
  }

  loading(chatId: number, tab: MediaTab): boolean { return this.busy.has(chatId + ':' + tab) || this.busy.has('load:' + chatId); }

  /** Новое подключение: отказы прошлого — спросим снова. */
  reconnect(): void { this.failed.clear(); }

  want(q: MediaQuery): void {
    const { chatId, tab } = q;
    if (!this.store.isLoaded(chatId)) {
      this.task('load:' + chatId, chatId, async () => { await this.store.loadChatMessages(chatId); }, false);
      return;
    }
    const chat = this.store.chats.get(chatId);
    if (!chat || !this.deps.online()) return;
    if (!chat.mediaCounts) {
      this.task('counts:' + chatId, chatId, async () => {
        const gen = this.store.resetGen;
        const r = await this.deps.http<Record<MediaTab, number>>(`/chats/${chatId}/media/counts`);
        const c = this.store.chats.get(chatId);
        if (!c || gen !== this.store.resetGen) return;
        // всё, что уже известно, сервер посчитал; новее — прибавит onMessage
        c.mediaCounts = { media: r.media ?? 0, file: r.file ?? 0, audio: r.audio ?? 0, voice: r.voice ?? 0, link: r.link ?? 0 };
        c.mediaCountsAt = c.knownMaxId;
        this.store.markChat(c);
      });
    }
    const v = visible(this.store, q);
    if (v.floor === true || v.list.length >= q.limit) return;
    const floor = v.floor;
    this.task(chatId + ':' + tab, chatId, async () => {
      const gen = this.store.resetGen, trims = this.store.trimGen(chatId);
      const r = await this.deps.http<Reply>(`/chats/${chatId}/media?kind=${tab}${Number.isFinite(floor) ? '&beforeId=' + floor : ''}`);
      const c = this.store.chats.get(chatId);
      if (!c || gen !== this.store.resetGen) return;   // ответ после сброса — устарел
      this.store.addLoose(chatId, r.messages);
      // пока ждали, уборка стёрла часть вкладки над floor — страница уже не продолжает известное подряд
      if (trims !== this.store.trimGen(chatId)) return;
      let lo = floor;
      for (const m of r.messages) if (m.id < lo) lo = m.id;
      c.mediaDone = { ...c.mediaDone, [tab]: r.hasMore && r.messages.length ? lo : true };
      this.store.markChat(c);
    });
  }

  private task(key: string, chatId: number, fn: () => Promise<void>, net = true): void {
    if (this.busy.has(key) || this.failed.has(key)) return;
    this.busy.add(key);
    this.store.retouch(chatId);   // loading в ~media
    this.deps.run(async () => {
      try { await fn(); await this.store.flush(); }
      catch (err) { if (net) this.failed.add(key); throw err; }
      finally { this.busy.delete(key); this.store.retouch(chatId); this.deps.changed(); }
    });
  }
}
