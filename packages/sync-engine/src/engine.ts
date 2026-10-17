import type { ClientFrame, Me, Message, PublicUser, ServerFrame } from '@relay/protocol';
import { Contacts } from './contacts';
import { delBlob, getAll, getBlob, getByChat, openDb, putBlob } from './idb';
import { affects, computeQuery, diffResults, messageWindow, type Result } from './queries';
import type { Item } from './types';
import { Store, type ChatSummary } from './store';
import { WsTransport } from './transport';
import { loadOps, Ops, type PendingOp } from './ops';
import { applyUserUpdated, meItem, meView, OP_PROFILE, OP_USERNAME, userItem } from './profile';
import type { Action, EngineConfig, LocalMessage, Patch, Query, SearchResult } from './types';

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
  /** очередь операций настроек (ops.ts) */
  readonly ops: Ops;
  /** контакты (contacts.ts) */
  private readonly contacts: Contacts;
  /** чужие профили, которых нет в кэше: подгрузим, когда будет связь; asked — уже спрашивали за это подключение */
  private userWants = new Set<number>();
  private usersAsked = new Set<number>();

  private constructor(private cfg: EngineConfig, readonly store: Store, private db: IDBDatabase, ops: PendingOp[]) {
    this.ops = new Ops(db, ops, { base: cfg.httpBase, headers: cfg.headers, backoffMs: cfg.backoffMs }, {
      canSend: () => this.online && this.ready && !this.closed,
      done: (op, value) => this.opDone(op, value),
      changed: () => this.changed(),
      run: (fn) => this.run(fn),
    });
    this.contacts = new Contacts({
      store, ops: this.ops, httpBase: cfg.httpBase, headers: cfg.headers,
      online: () => this.online,
      presence: () => this.presence,
      seedPresence: (id, p) => { if (this.online && !this.presence.has(id)) { this.presence.set(id, p); this.presenceDirty = true; } },
      refreshUser: (id) => { this.usersAsked.delete(id); this.userWants.add(id); },
      http: (path) => this.http(path),
      run: (fn) => this.run(fn),
      changed: () => this.changed(),
    });
    store.titleOf = (c) => this.contacts.titleOf(c);
    this.transport = new WsTransport(cfg.wsUrl, {
      onOpen: () => this.onOpen(),
      onFrame: (f) => this.onFrame(f),
      onClose: () => this.onClose(),
    }, cfg.backoffMs ?? [250, 5000]);
  }

  static async open(cfg: EngineConfig): Promise<Engine> {
    let engine: Engine | null = null;
    const db = await openDb(cfg.dbName, { onVersionChange: () => engine?.obsolete() });
    const store = await Store.open(db, cfg.userId);
    engine = new Engine(cfg, store, db, await loadOps(db));
    return engine;
  }

  private dead = false;
  private onObsoleteCb: () => void = () => {};
  /** База обновляется новой сборкой: этот движок закрыл IDB и больше не работает — вкладкам пора перезагрузиться. */
  onObsolete(cb: () => void): void { this.onObsoleteCb = cb; }
  private obsolete(): void {
    if (this.dead) return;
    this.dead = true;
    this.closed = true;
    this.ops.close();
    this.disconnect();
    if (this.frameTimer) { clearTimeout(this.frameTimer); this.frameTimer = null; }
    if (this.readTimer) { clearTimeout(this.readTimer); this.readTimer = null; }
    this.watchers.clear();
    this.onObsoleteCb();
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
    if (this.dead) return;   // IDB уже закрыта (versionchange)
    this.closed = true;
    this.ops.close();
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
    // профиль человека: из кэша сразу, а с сервера — заново на каждую новую подписку (открыли «Информацию»)
    if (w.q.kind === 'user' && w.q.userId !== this.cfg.userId) { this.usersAsked.delete(w.q.userId); this.userWants.add(w.q.userId); return; }
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
    if (q.kind === 'contacts') {
      const list = this.contacts.items();
      return { items: new Map(list.map((it) => [it.key, it])), order: list.map((it) => it.key), sig: new Map(list.map((it) => [it.key, JSON.stringify(it)])) };
    }
    if (q.kind === 'me' || q.kind === 'user' || q.kind === 'ops') {
      const list = q.kind === 'ops' ? [this.ops.item()] : q.kind === 'me' ? meItem(this.meNow()) : userItem(this.store.profile, this.meNow(), q.userId);
      if (q.kind === 'user' && !list.length && q.userId !== this.cfg.userId) this.userWants.add(q.userId);
      return { items: new Map(list.map((it) => [it.key, it])), order: list.map((it) => it.key), sig: new Map(list.map((it) => [it.key, JSON.stringify(it)])) };
    }
    if (q.kind !== 'status') return computeQuery(this.store, q);
    const it = this.statusItem();
    return { items: new Map([[it.key, it]]), order: [it.key], sig: new Map([[it.key, JSON.stringify(it)]]) };
  }

  private schedule(): void {
    if (this.frameTimer || this.closed) return;
    this.frameTimer = setTimeout(() => { this.frameTimer = null; this.emit(); }, this.cfg.frameMs ?? 16);
  }

  /** Загрузка файла: XHR с прогрессом (есть в воркерах браузера), иначе fetch. Ошибка сети — повтор позже. */
  private upload(clientId: string, blob: Blob, a: { name: string; mime: string; w: number | null; h: number | null }): Promise<{ id: string }> {
    const qs = new URLSearchParams({ name: a.name });
    if (a.w && a.h) { qs.set('w', String(a.w)); qs.set('h', String(a.h)); }
    const url = `${this.cfg.httpBase}/upload?${qs}`;
    const offline: ReqError = { code: 'offline', retry: true };
    if (typeof XMLHttpRequest === 'undefined') {
      return fetch(url, { method: 'POST', body: blob, headers: { 'content-type': a.mime, ...(this.cfg.headers ?? {}) }, credentials: 'include' })
        .then(async (r) => { if (!r.ok) throw { code: 'upload', retry: r.status >= 500 } satisfies ReqError; return r.json() as Promise<{ id: string }>; }, () => { throw offline; });
    }
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', url);
      x.withCredentials = true;
      x.setRequestHeader('content-type', a.mime);
      for (const [k, v] of Object.entries(this.cfg.headers ?? {})) x.setRequestHeader(k, v);
      let last = 0;
      x.upload.onprogress = (e) => {
        if (!e.lengthComputable || e.timeStamp - last < 100) return; // не чаще 10 раз в секунду
        last = e.timeStamp;
        this.store.setProgress(clientId, e.loaded / e.total);
        this.changed();
      };
      x.onload = () => (x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject({ code: 'upload', retry: x.status >= 500 } satisfies ReqError));
      x.onerror = () => reject(offline);
      x.send(blob);
    });
  }

  /** Поиск: с сетью — на сервере (вся история), без сети — по сообщениям, сохранённым на устройстве. */
  private async search(a: Extract<Action, { type: 'search' }>): Promise<SearchResult> {
    const limit = a.limit ?? 30;
    if (this.online) {
      try {
        const qs = new URLSearchParams({ q: a.q, limit: String(limit) });
        if (a.chatId) qs.set('chatId', String(a.chatId));
        if (a.beforeId) qs.set('beforeId', String(a.beforeId));
        const res = await this.http<{ hits: { message: Message; chatTitle: string | null }[]; hasMore: boolean }>(`/search?${qs}`);
        return {
          hits: res.hits.map(({ message: m, chatTitle }) => ({ chatId: m.chatId, chatTitle: chatTitle ?? this.store.chats.get(m.chatId)?.title ?? null, id: m.id, sort: m.id, senderId: m.senderId, body: m.body, createdAt: m.createdAt })),
          hasMore: res.hasMore, source: 'server',
        };
      } catch { /* сеть пропала посреди запроса — ищем локально */ }
    }
    const needle = a.q.trim().toLowerCase();
    const all = a.chatId ? await getByChat(this.db, a.chatId) : await getAll<LocalMessage>(this.db, 'messages');
    const found = all
      .filter((m) => m.id != null && !m.deleted && (!a.beforeId || m.id < a.beforeId) && m.body.toLowerCase().includes(needle))
      .sort((x, y) => y.sort - x.sort);
    return {
      hits: found.slice(0, limit).map((m) => ({ chatId: m.chatId, chatTitle: this.store.chats.get(m.chatId)?.title ?? null, id: m.id!, sort: m.sort, senderId: m.senderId, body: m.body, createdAt: m.createdAt })),
      hasMore: found.length > limit, source: 'local',
    };
  }

  /** Отправить на сервер черновики этого устройства (сервер разнесёт их по остальным через журнал). */
  private pushDrafts(): void {
    if (!this.online || !this.ready) return;
    for (const chatId of [...this.store.pendingDrafts]) {
      const text = this.store.chats.get(chatId)?.draft?.text ?? '';
      this.run(async () => {
        await this.request({ op: 'draft', reqId: '', chatId, text });
        // за время запроса текст могли поменять — тогда он уйдёт следующим вызовом
        if ((this.store.chats.get(chatId)?.draft?.text ?? '') === text) this.store.pendingDrafts.delete(chatId);
      });
    }
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
    this.contacts.retitle();
    const hold = this.holding && this.acting === 0;
    const touched = new Set(this.store.touched);
    if (!hold) this.store.touched.clear(); // при удержании изменения копятся до конца догонки
    const sig = JSON.stringify(this.statusItem());
    const statusChanged = sig !== this.statusSig;
    const presenceDirty = this.presenceDirty;
    this.presenceDirty = false;
    // профиль при удержании копится, как и чаты; очередь операций (тосты отказов) — сразу
    const opsDirty = this.ops.dirty, profileDirty = this.store.profile.dirty || opsDirty;
    this.ops.dirty = false;
    const contactsDirty = this.store.contacts.dirty || opsDirty || presenceDirty || profileDirty;
    this.store.contacts.dirty = false;
    // me/user выводятся из очереди: при удержании изменение очереди не теряем — оно уйдёт с концом догонки
    this.store.profile.dirty = hold && profileDirty;
    this.statusSig = sig;
    for (const w of this.watchers.values()) {
      const own = (w.q.kind === 'status' && statusChanged) || (w.q.kind === 'presence' && presenceDirty) || (w.q.kind === 'ops' && opsDirty) || ((w.q.kind === 'me' || w.q.kind === 'user') && profileDirty) || (w.q.kind === 'contacts' && contactsDirty);
      if (!w.force && !affects(w.q, touched) && !own) continue;
      if (hold && !w.force && w.q.kind !== 'status' && w.q.kind !== 'presence' && w.q.kind !== 'ops' && w.q.kind !== 'contacts') continue;
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
    this.fetchUsers();
  }

  /** Свой профиль для интерфейса: база + очередь. */
  private meNow(): Me | null { return meView(this.store.profile.me, this.ops.list); }

  /** Операция подтверждена: ответ профиля — новая база (журнал принесёт то же самое ещё раз — не страшно). */
  private opDone(op: PendingOp, value: unknown): void {
    if (this.contacts.opDone(op, value)) return;
    if ((op.key === OP_PROFILE || op.key === OP_USERNAME) && value && typeof value === 'object' && (value as Me).userId === this.cfg.userId) {
      if (this.store.profile.setMe(value as Me)) this.run(() => this.store.flush());
    }
  }

  /** Свой профиль с сервера — после каждого hello (кэш мог устареть, пока нас не было). */
  private fetchMe(): void {
    const gen = this.store.profile.gen;
    this.run(async () => {
      const me = await this.http<Me>('/me');
      if (this.store.profile.gen !== gen) return;   // пока ждали, пришло свежее (журнал или ответ операции)
      if (!this.store.profile.setMe(me)) return;
      await this.store.flush();
      this.changed();
    });
  }

  /** Чужие профили, о которых спросил интерфейс, — по одному запросу на человека за подключение. */
  private fetchUsers(): void {
    if (!this.online || !this.ready || !this.userWants.size) return;
    const ids = [...this.userWants].filter((id) => !this.usersAsked.has(id));
    this.userWants.clear();
    for (const id of ids) {
      this.usersAsked.add(id);
      this.run(async () => {
        let u: PublicUser;
        try { u = await this.http<PublicUser>(`/users/${id}`); } catch { return; }   // 404 — не видим этого человека
        applyUserUpdated(this.store, u);
        await this.store.flush();
        this.changed();
      });
    }
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
        if (this.store.setDraft(a.chatId, a.text)) {
          this.store.pendingDrafts.add(a.chatId);
          await this.store.flush();
          this.changed();
          this.pushDrafts();
        }
        return null;
      }
      case 'typing':
        if (this.online) this.transport.send({ op: 'typing', chatId: a.chatId });
        return null;
      case 'editMessage': {
        if (!this.online) throw new Error('offline');
        await this.request({ op: 'edit', reqId: '', chatId: a.chatId, id: a.id, body: a.body });
        return null;
      }
      case 'deleteMessage': {
        if (!this.online) throw new Error('offline');
        await this.request({ op: 'delete', reqId: '', chatId: a.chatId, id: a.id });
        return null;
      }
      case 'react': {
        if (!this.online) throw new Error('offline');
        // сразу у себя (реакция должна отзываться мгновенно), подтверждение и чужие — через журнал
        const m = this.store.messageById(a.chatId, a.id);
        const prev = m?.reactions ?? [];
        if (m) {
          const next = prev.filter((r) => r.userId !== this.cfg.userId);
          if (a.emoji) next.push({ userId: this.cfg.userId, emoji: a.emoji });
          this.store.patchMessage(a.chatId, a.id, { reactions: next });
          this.changed();
        }
        try { await this.request({ op: 'react', reqId: '', chatId: a.chatId, id: a.id, emoji: a.emoji }); }
        catch (err) { if (m) { this.store.patchMessage(a.chatId, a.id, { reactions: prev }); this.changed(); } throw err; }
        return null;
      }
      case 'search': return this.search(a);
      case 'chatMedia': return this.http<{ messages: Message[] }>(`/chats/${a.chatId}/media?kind=${a.kind}`).then((r) => r.messages);
      case 'sendFile': {
        // файл — в IDB (переживёт офлайн и перезагрузку), сообщение — в очередь; загрузка и отправка — в pumpOutbox
        const clientId = crypto.randomUUID();
        this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
        await putBlob(this.db, clientId, a.file);
        const photo = /^image\//.test(a.mime) && !!a.w && !!a.h;
        this.store.addPending({ clientId, chatId: a.chatId, body: a.body, replyToId: a.replyToId ?? null, createdAt: this.lastCreated, failed: false,
          attachment: { id: '', kind: photo ? 'photo' : 'file', mime: a.mime, name: a.name, size: a.file.size, w: photo ? a.w! : null, h: photo ? a.h! : null, thumb: a.thumb ?? null } });
        this.store.setDraft(a.chatId, '');
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        return { clientId };
      }
      case 'loadMoreChats':
        await this.loadMoreChats();
        return null;
      case 'updateProfile': {
        const body: Record<string, unknown> = {};
        for (const k of ['firstName', 'lastName', 'bio', 'birthday'] as const) if (a[k] !== undefined) body[k] = a[k];
        if (Object.keys(body).length) await this.ops.enqueue({ key: OP_PROFILE, method: 'PATCH', path: '/me', body });
        return null;
      }
      case 'setUsername':
        await this.ops.enqueue({ key: OP_USERNAME, method: 'PUT', path: '/me/username', body: { username: a.username } });
        return null;
      case 'addContact':
      case 'updateContact':
      case 'removeContact':
      case 'resolveUser':
        return this.contacts.act(a);
      case 'checkUsername': {
        if (!this.online) return { offline: true };
        try { return await this.http<{ ok: boolean; reason?: string }>(`/users/check-username?u=${encodeURIComponent(a.username)}`); }
        catch { return { offline: true }; }
      }
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
    this.usersAsked.clear();
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
          if (this.store.epoch && f.epoch && this.store.epoch !== f.epoch) { await this.store.wipe(f.epoch); this.ops.forget(); this.changed(); }
          else if (!this.store.epoch && f.epoch) { this.store.epoch = f.epoch; this.store.markMeta(); }
          // снимок — только когда кэш пуст; lastSeq = 0 бывает и у заполненного кэша (журнал пользователя ещё пуст)
          this.fetchMe();
          this.contacts.fetch();
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
            this.contacts.fetch();
            await this.loadFirstDialogs();
            this.store.lastSeq = f.op === 'tooLong' ? f.seq : f.to;
            await this.store.flush();
            this.changed();
            if (gap) break; // seq сервера неизвестен — не крутимся, ждём следующего poke
            continue;
          }
          for (const it of f.items) {
            if (it.seq <= this.store.lastSeq) continue;
            this.store.applyUpdate(it.update, it.seq);
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
      this.pushDrafts();
      if (this.store.unnamed().length) this.refreshList();
      if (!this.presenceFetched) this.fetchPresence();
      this.ops.resume();
      this.fetchUsers();
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
            if (next.attachment && !next.attachment.id) {
              const blob = await getBlob(this.db, next.clientId);
              if (!blob) { this.store.fail(next.clientId); await this.store.flush(); this.changed(); continue; }
              const up = await this.upload(next.clientId, blob, next.attachment);
              this.store.setUploaded(next.clientId, up.id);
              await this.store.flush();
              this.changed();
            }
            const att = next.attachment ? { id: next.attachment.id, thumb: next.attachment.thumb ?? null } : null;
            const r = await this.request({ op: 'send', reqId: '', clientId: next.clientId, chatId: next.chatId, body: next.body, replyToId: next.replyToId, attachment: att });
            this.store.ack(next.clientId, r.id as number, r.createdAt as string);
            if (att) delBlob(this.db, next.clientId).catch(() => {});
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
      (this.ready && this.store.pendingReads.size > 0) ||
      this.ops.sending;
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
