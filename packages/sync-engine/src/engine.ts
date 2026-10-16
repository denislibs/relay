import type { ClientFrame, Message, ServerFrame } from '@relay/protocol';
import { openDb } from './idb';
import { affects, computeQuery, diffResults, messageWindow, type Result } from './queries';
import type { Item } from './types';
import { Store, type ChatSummary } from './store';
import { WsTransport } from './transport';
import type { Action, EngineConfig, Patch, Query } from './types';

export interface WatchHandle { update(q: Query): void; close(): void }

interface Watcher { id: number; q: Query; cb: (p: Patch) => void; prev: Result | null; force: boolean; gated: boolean }
type ReqError = { code: string; retry: boolean };
type SyncReply = Extract<ServerFrame, { op: 'updates' | 'tooLong' }>;

/**
 * Движок синхронизации: владеет Store, держит соединение, догоняет журнал,
 * отправляет очередь, схлопывает прочтение и раздаёт подпискам патчи раз в кадр.
 */
const HISTORY_GATE_MS = 400;

export class Engine {
  private transport: WsTransport;
  private watchers = new Map<number, Watcher>();
  private nextWatch = 1;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private readTimer: ReturnType<typeof setTimeout> | null = null;

  private online = false;   // сокет открыт
  private wantOnline = false; // connect() вызван, ждём сокет
  private failures = 0;     // неудачных попыток подряд с последнего открытия
  private netDown = typeof navigator !== 'undefined' && navigator.onLine === false;
  private ready = false;    // первый sync после подключения завершён
  private syncing = false;
  /** Догоняем журнал после hello: данные копим и отдаём интерфейсу одной пачкой, чтобы список не ехал по частям. */
  private holding = false;
  /** Присутствие собеседников: состояние момента, только в памяти; без связи — неизвестно. */
  private presence = new Map<number, { online: boolean; lastSeen: string | null }>();
  private presenceFetched = false;
  private presenceDirty = false;   // присутствие не трогает чаты — свой флаг для подписок presence
  private acting = 0;       // действия пользователя в работе: их результат показываем сразу, даже во время догонки
  private syncAgain = false;
  private syncWaiter: { resolve(f: SyncReply): void; reject(e: ReqError): void } | null = null;
  private reqSeq = 0;
  private pending = new Map<string, { resolve(r: Record<string, unknown>): void; reject(e: ReqError): void }>();
  private pumping = false;
  private busy = 0;
  private historyLoads = new Map<number, Promise<void>>();
  private lastCreated = 0;
  private closed = false;
  private statusSig = '';
  private refreshing = false;
  private moreChats: Promise<void> | null = null;
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private constructor(private cfg: EngineConfig, readonly store: Store, private db: IDBDatabase) {
    this.transport = new WsTransport(cfg.wsUrl, {
      onOpen: () => this.onOpen(),
      onFrame: (f) => this.onFrame(f),
      onClose: () => this.onClose(),
    }, cfg.backoffMs ?? [250, 5000]);
  }

  static async open(cfg: EngineConfig): Promise<Engine> {
    const db = await openDb(cfg.dbName);
    const store = await Store.open(db, cfg.userId);
    return new Engine(cfg, store, db);
  }

  connect(): void {
    if (this.closed) return;
    this.wantOnline = true;
    this.watchNetwork();
    this.transport.start();
  }
  disconnect(): void { this.wantOnline = false; this.transport.stop(); this.changed(); }

  /** События сети воркера/окна: «нет сети» показываем сразу, а при возврате сети подключаемся без ожидания паузы. */
  private watchNetwork(): void {
    const g = globalThis as { addEventListener?: (t: string, cb: () => void) => void };
    if (typeof g.addEventListener !== 'function' || this.netWatched) return;
    this.netWatched = true;
    g.addEventListener('offline', () => { this.netDown = true; this.changed(); });
    g.addEventListener('online', () => { this.netDown = false; this.changed(); this.transport.retryNow(); });
  }
  private netWatched = false;

  /**
   * Стадия для интерфейса:
   * connecting — пытаемся подключиться; offline — сети нет или попытки не удаются;
   * loading — подключились, а кэш пуст (первый снимок); updating — догоняем журнал; ready — всё сошлось.
   */
  private phase(): 'connecting' | 'offline' | 'loading' | 'updating' | 'ready' {
    if (!this.online) return this.wantOnline && !this.netDown && this.failures < 2 ? 'connecting' : 'offline';
    if (this.ready) return 'ready';
    return this.store.hydrated ? 'updating' : 'loading';
  }

  async close(): Promise<void> {
    this.closed = true;
    this.disconnect();
    if (this.frameTimer) { clearTimeout(this.frameTimer); this.frameTimer = null; }
    if (this.readTimer) { clearTimeout(this.readTimer); this.readTimer = null; }
    this.watchers.clear();
    await this.whenIdle(2000).catch((e) => console.warn(String(e)));
    await this.store.flush();
    this.db.close();
  }

  // =====================================================================
  // Подписки
  // =====================================================================

  watch(q: Query, cb: (p: Patch) => void): WatchHandle {
    const w: Watcher = { id: this.nextWatch++, q, cb, prev: null, force: true, gated: q.kind === 'messages' };
    this.watchers.set(w.id, w);
    this.prepare(w);
    this.schedule();
    return {
      update: (q2) => { const chatChanged = q2.kind === 'messages' && (w.q.kind !== 'messages' || w.q.chatId !== q2.chatId); w.q = q2; w.force = true; if (chatChanged) w.gated = true; this.prepare(w); this.schedule(); },
      close: () => { this.watchers.delete(w.id); },
    };
  }

  private prepare(w: Watcher): void {
    if (w.q.kind !== 'messages') return;
    const { chatId, limit } = w.q;
    const q = w.q;
    // первый снимок ленты — уже готовый: кэш прочитан и, если сообщений меньше окна, история догружена
    // (сервер ждём не дольше HISTORY_GATE_MS, без сети — не ждём); иначе интерфейс покажет пусто → часть → всё
    const open = () => { if (w.q === q && w.gated) { w.gated = false; this.changed(); } };
    this.run(async () => {
      try {
        await this.store.loadChatMessages(chatId);
        const history = this.ensureWindow(q);
        if (this.online && w.gated) await Promise.race([history.catch(() => {}), new Promise((r) => setTimeout(r, HISTORY_GATE_MS))]);
        open();
        await history;
      } finally {
        open();
      }
    });
  }

  private changed(): void { this.pushStatus(); this.schedule(); }

  /** Смена стадии уходит сразу, не дожидаясь кадра: иначе короткая «догонка» склеится и интерфейс её не покажет. */
  private pushStatus(): void {
    if (this.closed) return;
    const sig = JSON.stringify(this.statusItem());
    if (sig === this.statusSig) return;
    this.statusSig = sig;
    for (const w of this.watchers.values()) {
      if (w.q.kind !== 'status' || w.force) continue;
      const next = this.compute(w.q);
      const patch = diffResults(w.prev, next);
      w.prev = next;
      if (patch) { try { w.cb(patch); } catch (err) { console.error('watch callback failed', err); } }
    }
  }

  /** Текущий статус (то же, что приходит в подписку status). */
  status(): Item { return this.statusItem(); }

  private statusItem(): Item {
    return {
      key: 'status',
      phase: this.phase(),
      hydrated: this.store.hydrated,   // в кэше есть данные с сервера
      chatsComplete: this.store.dialogsDone,   // все страницы диалогов загружены
      chatsCursorAt: this.store.dialogsAt,     // докуда загружен непрерывный диапазон (мс; 0 — ещё не грузили)
      online: this.online,
      synced: this.ready,
      syncing: this.syncing,
      outbox: [...this.store.outbox.values()].filter((o) => !o.failed).length,
      failed: [...this.store.outbox.values()].filter((o) => o.failed).length,
    };
  }

  private compute(q: Query): Result {
    if (q.kind === 'presence') {
      const p = this.presence.get(q.userId);
      const it: Item = { key: 'p' + q.userId, userId: q.userId, known: !!p, online: p?.online ?? false, lastSeen: p?.lastSeen ?? null };
      return { items: new Map([[it.key, it]]), order: [it.key], sig: new Map([[it.key, JSON.stringify(it)]]) };
    }
    if (q.kind !== 'status') return computeQuery(this.store, q);
    const it = this.statusItem();
    return { items: new Map([[it.key, it]]), order: [it.key], sig: new Map([[it.key, JSON.stringify(it)]]) };
  }

  private schedule(): void {
    if (this.frameTimer || this.closed) return;
    this.frameTimer = setTimeout(() => { this.frameTimer = null; this.emit(); }, this.cfg.frameMs ?? 16);
  }

  /** Цитаты, исходники которых не загружены: одним запросом на чат, в фоне. */
  private fetchQuotes(): void {
    if (!this.online || !this.store.quoteWants.size) return;
    const wants = [...this.store.quoteWants.entries()];
    this.store.quoteWants.clear();
    for (const [chatId, ids] of wants) {
      this.run(async () => {
        const res = await this.http<{ messages: Message[] }>(`/chats/${chatId}/messages?ids=${[...ids].join(',')}`);
        this.store.addQuotes(chatId, res.messages);
        this.changed();
      });
    }
  }

  private emit(): void {
    const hold = this.holding && this.acting === 0;
    const touched = new Set(this.store.touched);
    if (!hold) this.store.touched.clear(); // при удержании изменения копятся до конца догонки
    const sig = JSON.stringify(this.statusItem());
    const statusChanged = sig !== this.statusSig;
    const presenceDirty = this.presenceDirty;
    this.presenceDirty = false;
    this.statusSig = sig;
    for (const w of this.watchers.values()) {
      if (!w.force && !affects(w.q, touched) && !(w.q.kind === 'status' && statusChanged) && !(w.q.kind === 'presence' && presenceDirty)) continue;
      if (hold && !w.force && w.q.kind !== 'status' && w.q.kind !== 'presence') continue;
      if (w.gated) continue;
      w.force = false;
      const next = this.compute(w.q);
      const patch = diffResults(w.prev, next);
      w.prev = next;
      if (patch) {
        try { w.cb(patch); } catch (err) { console.error('watch callback failed', err); }
      }
    }
    this.fetchQuotes();
  }

  // =====================================================================
  // Действия интерфейса
  // =====================================================================

  async call(a: Action): Promise<unknown> {
    this.acting++;
    try { return await this.act(a); } finally { this.acting--; }
  }

  private async act(a: Action): Promise<unknown> {
    switch (a.type) {
      case 'sendMessage': {
        const clientId = crypto.randomUUID();
        this.lastCreated = Math.max(Date.now(), this.lastCreated + 1); // порядок черновиков внутри одной миллисекунды
        this.store.addPending({ clientId, chatId: a.chatId, body: a.body, replyToId: a.replyToId ?? null, createdAt: this.lastCreated, failed: false });
        this.store.setDraft(a.chatId, '');   // отправили — черновик больше не нужен
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        return { clientId };
      }
      case 'seen': {
        if (this.store.localRead(a.chatId, a.upToId)) {
          await this.store.flush();
          this.changed();
          this.scheduleReads();
        }
        return null;
      }
      case 'loadOlder': {
        await this.store.loadChatMessages(a.chatId);
        await this.ensureHistory(a.chatId, this.store.chatMessages(a.chatId).length + (this.cfg.historyPage ?? 50));
        return null;
      }
      case 'refreshChats': {
        if (this.online) this.refreshList();
        return null;
      }
      case 'setDraft': {
        if (this.store.setDraft(a.chatId, a.text)) { await this.store.flush(); this.changed(); }
        return null;
      }
      case 'typing':
        if (this.online) this.transport.send({ op: 'typing', chatId: a.chatId });
        return null;
      case 'loadMoreChats':
        await this.loadMoreChats();
        return null;
      case 'retry': {
        if (this.store.unfail(a.clientId)) {
          await this.store.flush();
          this.changed();
          this.pumpOutbox();
        }
        return null;
      }
    }
  }

  // =====================================================================
  // Сеть
  // =====================================================================

  private onOpen(): void {
    this.online = true;
    this.failures = 0;
    this.netDown = false;
    this.ready = false;
    this.changed();
    this.transport.send({ op: 'hello', lastSeq: this.store.lastSeq });
  }

  private onClose(): void {
    this.online = false;
    this.holding = false;
    this.presence.clear();            // без связи не знаем, кто в сети
    this.presenceDirty = true;
    this.presenceFetched = false;
    if (this.wantOnline) this.failures++;
    this.ready = false;
    this.changed();
    const offline: ReqError = { code: 'offline', retry: true };
    this.syncWaiter?.reject(offline);
    this.syncWaiter = null;
    for (const p of this.pending.values()) p.reject(offline);
    this.pending.clear();
  }

  private onFrame(f: ServerFrame): void {
    switch (f.op) {
      case 'hello':
        this.holding = true;
        this.run(async () => {
          // другое поколение базы (сервер пересоздан): старый кэш недействителен целиком
          if (this.store.epoch && f.epoch && this.store.epoch !== f.epoch) { await this.store.wipe(f.epoch); this.changed(); }
          else if (!this.store.epoch && f.epoch) { this.store.epoch = f.epoch; this.store.markMeta(); }
          // снимок — только когда кэш пуст; lastSeq = 0 бывает и у заполненного кэша (журнал пользователя ещё пуст)
          if (!this.store.hydrated) await this.bootstrap(f.seq);
          else this.runSync();
        });
        return;
      case 'updates':
      case 'tooLong': {
        const w = this.syncWaiter;
        this.syncWaiter = null;
        w?.resolve(f);
        return;
      }
      case 'ack':
      case 'err': {
        const id = f.reqId;
        if (!id) return;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (f.op === 'ack') p.resolve(f.result);
        else p.reject({ code: f.code, retry: f.retry });
        return;
      }
      case 'poke':
        this.runSync();
        return;
      case 'typing': {
        // «печатает…» гаснет через typingMs после последнего кадра
        const key = f.chatId + ':' + f.userId;
        clearTimeout(this.typingTimers.get(key));
        this.store.setTyping(f.chatId, f.userId, true);
        this.typingTimers.set(key, setTimeout(() => { this.typingTimers.delete(key); this.store.setTyping(f.chatId, f.userId, false); this.changed(); }, this.cfg.typingMs ?? 6000));
        this.changed();
        return;
      }
      case 'presence':
        for (const p of f.items) this.presence.set(p.userId, { online: p.online, lastSeen: p.lastSeen });
        this.presenceDirty = true;
        this.changed();
        return;
      case 'pong':
        return;
    }
  }

  /** Первый вход или tooLong: hello дал seq S → снимок → lastSeq = S → догоняем от S. */
  private async bootstrap(seq: number): Promise<void> {
    this.syncing = true;
    try {
      await this.loadFirstDialogs();
      this.store.lastSeq = seq;
      await this.store.flush();
      this.changed();
    } finally {
      this.syncing = false;
    }
    await this.syncLoop();
  }

  private runSync(): void {
    if (this.syncing) { this.syncAgain = true; return; }
    this.run(() => this.syncLoop());
  }

  private async syncLoop(): Promise<void> {
    if (this.syncing) { this.syncAgain = true; return; }
    this.syncing = true;
    try {
      do {
        this.syncAgain = false;
        let more = true;
        while (more && this.online) {
          const f = await this.requestSync(this.store.lastSeq);
          // защита: пустая пачка с more от сервера означает дыру — лечим снимком
          const gap = f.op === 'updates' && f.more && f.items.length === 0;
          if (f.op === 'tooLong' || gap) {
            this.store.resetForSnapshot();
            this.store.resetDialogs();
            await this.loadFirstDialogs();
            this.store.lastSeq = f.op === 'tooLong' ? f.seq : f.to;
            await this.store.flush();
            this.changed();
            if (gap) break; // seq сервера неизвестен — не крутимся, ждём следующего poke
            continue;
          }
          for (const it of f.items) {
            if (it.seq <= this.store.lastSeq) continue;
            this.store.applyUpdate(it.update);
            this.store.lastSeq = it.seq;
          }
          await this.store.flush(); // данные и lastSeq — одной транзакцией
          this.changed();
          more = f.more;
        }
      } while (this.syncAgain && this.online);
    } finally {
      this.syncing = false;
    }
    if (this.online) {
      this.ready = true;
      this.holding = false;   // всё накопленное уйдёт одним патчем
      this.changed();
      this.pumpOutbox();
      this.flushReads();
      if (this.store.unnamed().length) this.refreshList();
      if (!this.presenceFetched) this.fetchPresence();
    }
  }

  /** Снимок присутствия собеседников — раз на подключение; дальше приходят кадры presence. */
  private fetchPresence(): void {
    this.presenceFetched = true;
    this.run(async () => {
      const list = await this.http<{ userId: number; online: boolean; lastSeen: string | null }[]>('/presence');
      if (!this.online) return;
      for (const p of list) if (!this.presence.has(p.userId)) this.presence.set(p.userId, { online: p.online, lastSeen: p.lastSeen }); // живой кадр, пришедший раньше снимка, свежее
      this.presenceDirty = true;
      this.changed();
    });
  }

  /** Первая страница диалогов и все чаты с непрочитанными (папка «Непрочитанные» и её счётчик — полные). */
  private async loadFirstDialogs(): Promise<void> {
    const [page, unread] = await Promise.all([
      this.http<{ chats: ChatSummary[]; next: { at: string; id: number } | null }>(`/chats/page?limit=${this.cfg.dialogsPage ?? 100}`),
      this.http<ChatSummary[]>('/chats?unread=1'),
    ]);
    this.store.applyChats([...page.chats, ...unread]);
    this.store.setDialogsCursor(page.next);
  }

  /** Следующая страница диалогов (список докрутили до конца). Один запрос за раз. */
  private loadMoreChats(): Promise<void> {
    if (this.store.dialogsDone || !this.store.hydrated) return Promise.resolve();
    this.moreChats ??= (async () => {
      try {
        const at = new Date(this.store.dialogsAt).toISOString();
        const page = await this.http<{ chats: ChatSummary[]; next: { at: string; id: number } | null }>(`/chats/page?limit=${this.cfg.dialogsPage ?? 100}&beforeAt=${encodeURIComponent(at)}&beforeId=${this.store.dialogsId}`);
        this.store.applyChats(page.chats);
        this.store.setDialogsCursor(page.next);
        await this.store.flush();
        this.changed();
      } finally {
        this.moreChats = null;
      }
    })();
    return this.moreChats;
  }

  /** Сообщение пришло в чат, которого не было в снимке: подтянуть названия и собеседников. */
  private refreshList(): void {
    if (this.refreshing) return;
    this.refreshing = true;
    this.run(async () => {
      try {
        // чаты, известные только по сообщениям, — точечно по id; иначе (новый чат) — свежая первая страница
        const unnamed = this.store.unnamed();
        const list = unnamed.length
          ? await this.http<ChatSummary[]>(`/chats?ids=${unnamed.slice(0, 500).join(',')}`)
          : (await this.http<{ chats: ChatSummary[] }>(`/chats/page?limit=${this.cfg.dialogsPage ?? 100}`)).chats;
        this.store.applyChats(list);
        await this.store.flush();
        this.changed();
      } finally {
        this.refreshing = false;
      }
    });
  }

  private requestSync(since: number): Promise<SyncReply> {
    return new Promise((resolve, reject) => {
      this.syncWaiter = { resolve, reject };
      if (!this.transport.send({ op: 'sync', since })) {
        this.syncWaiter = null;
        reject({ code: 'offline', retry: true });
      }
    });
  }

  private request(frame: Extract<ClientFrame, { reqId: string }>): Promise<Record<string, unknown>> {
    const reqId = 'r' + ++this.reqSeq;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      if (!this.transport.send({ ...frame, reqId })) {
        this.pending.delete(reqId);
        reject({ code: 'offline', retry: true });
      }
    });
  }

  // =====================================================================
  // Очередь отправки
  // =====================================================================

  private pumpOutbox(): void {
    if (!this.online || !this.ready || this.pumping) return;
    this.pumping = true;
    this.run(async () => {
      try {
        for (;;) {
          const next = [...this.store.outbox.values()].find((o) => !o.failed);
          if (!next || !this.online) break;
          try {
            const r = await this.request({ op: 'send', reqId: '', clientId: next.clientId, chatId: next.chatId, body: next.body, replyToId: next.replyToId });
            this.store.ack(next.clientId, r.id as number, r.createdAt as string);
          } catch (e) {
            if ((e as ReqError).retry === false) this.store.fail(next.clientId);
            else break; // сеть — дождёмся переподключения, порядок сохранится
          }
          await this.store.flush();
          this.changed();
        }
      } finally {
        this.pumping = false;
      }
    });
  }

  // =====================================================================
  // Прочтение
  // =====================================================================

  private scheduleReads(): void {
    if (this.readTimer || this.closed) return;
    this.readTimer = setTimeout(() => { this.readTimer = null; this.flushReads(); }, this.cfg.readFlushMs ?? 1000);
  }

  private flushReads(): void {
    if (!this.online || !this.ready || !this.store.pendingReads.size) return;
    this.run(async () => {
      for (const [chatId, upToId] of [...this.store.pendingReads]) {
        try {
          await this.request({ op: 'read', reqId: '', chatId, upToId });
          this.store.readSent(chatId, upToId);
        } catch (e) {
          if ((e as ReqError).retry === false) this.store.readSent(chatId, upToId);
          else break;
        }
      }
      await this.store.flush();
      if (this.store.pendingReads.size && this.online) this.scheduleReads(); // указатель вырос, пока отправляли
    });
  }

  // =====================================================================
  // История
  // =====================================================================

  /** Догрузить историю под окно запроса; если окно у самого края загруженного — ещё страницу наперёд. */
  private async ensureWindow(q: Extract<Query, { kind: 'messages' }>): Promise<void> {
    const page = this.cfg.historyPage ?? 50;
    for (let guard = 0; guard < 200; guard++) {
      const chat = this.store.chats.get(q.chatId);
      if (!chat || chat.historyComplete) return;
      const all = this.store.chatMessages(q.chatId);
      const { from, to } = messageWindow(all, q);
      let short: boolean;
      if (!q.anchor) short = all.length < q.limit;
      else {
        const reached = all.length > 0 && all[0].sort <= q.anchor.sort;   // якорь уже среди загруженных
        short = !reached || (q.anchor.side !== 'start' && from === 0 && to - from < q.limit);
      }
      // далеко в истории (переход к сообщению) — крупными страницами, а не десятками мелких запросов
      const far = q.anchor && all.length > 0 && all[0].sort > q.anchor.sort;
      if (short) { await this.ensureHistory(q.chatId, all.length + (far ? 200 : page), far ? 200 : undefined); continue; }
      // окно близко к старому краю — страница наперёд, в фоне, чтобы прокрутка вверх не упиралась
      if (from < page) this.run(() => this.ensureHistory(q.chatId, all.length + page));
      return;
    }
  }

  private ensureHistory(chatId: number, limit: number, pageSize?: number): Promise<void> {
    const have = this.store.chatMessages(chatId).length;
    const chat = this.store.chats.get(chatId);
    if (have >= limit || chat?.historyComplete) return Promise.resolve();
    const running = this.historyLoads.get(chatId);
    if (running) return running.then(() => this.ensureHistory(chatId, limit));
    const page = pageSize ?? this.cfg.historyPage ?? 50;
    const p = (async () => {
      while (this.store.chatMessages(chatId).length < limit && !this.store.chats.get(chatId)?.historyComplete) {
        const before = this.store.oldestId(chatId);
        const res = await this.http<{ messages: Message[]; hasMore: boolean }>(`/chats/${chatId}/messages?limit=${page}${before ? `&before=${before}` : ''}`);
        this.store.applyHistory(chatId, res.messages, res.hasMore);
        await this.store.flush();
        this.changed();
        if (!res.messages.length) break;
      }
    })().finally(() => this.historyLoads.delete(chatId));
    this.historyLoads.set(chatId, p);
    return p;
  }

  // =====================================================================
  // Служебное
  // =====================================================================

  private async http<T>(path: string): Promise<T> {
    const res = await fetch(this.cfg.httpBase + path, { headers: this.cfg.headers, credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return (await res.json()) as T;
  }

  private run(fn: () => Promise<unknown>): void {
    this.busy++;
    fn().catch((err) => { if (!(err && (err as ReqError).code === 'offline')) console.error('sync engine:', err); })
      .finally(() => { this.busy--; });
  }

  /** Ждёт, пока не останется синхронизации, запросов, неотправленного (при сети) и патчей. */
  async whenIdle(timeoutMs = 5000): Promise<void> {
    const end = Date.now() + timeoutMs;
    const busy = () =>
      this.syncing || this.busy > 0 || this.pending.size > 0 || this.frameTimer !== null || this.readTimer !== null ||
      (this.transport.wanted && !this.ready) ||
      (this.ready && [...this.store.outbox.values()].some((o) => !o.failed)) ||
      (this.ready && this.store.pendingReads.size > 0);
    while (busy()) {
      if (Date.now() > end) {
        throw new Error('engine did not become idle: ' + JSON.stringify({
          syncing: this.syncing, busy: this.busy, pending: this.pending.size, frame: this.frameTimer !== null, read: this.readTimer !== null,
          wanted: this.transport.wanted, ready: this.ready, outbox: this.store.outbox.size, reads: this.store.pendingReads.size,
        }));
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
