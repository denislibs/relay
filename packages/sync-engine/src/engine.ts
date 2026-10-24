import { deviceFetch, signDevice } from './device';
import { MAX_FILE_BYTES, MEDIA_TABS, type MediaTab } from '@relay/protocol';
import type { ClientFrame, JournalEntry, Me, SettingsSnapshot, Message, PublicUser, ServerFrame, ThreadGuest } from '@relay/protocol';
import { Blocks } from './blocks';
import { Contacts } from './contacts';
import { delBlob, getBlob, openDb, putBlob, write } from './idb';
import { affects, computeQuery, diffResults, feedSpan, flagsKey, flagsOf, flagsOverlay, messageWindow, muteKey, rangeAt, muteOverlay, threadView, type Result } from './queries';
import type { Item } from './types';
import { countStores } from './devstats';
import { Store, type ChatSummary } from './store';
import { uploadParts, type MultipartState, type UploadSource } from './multipart';
import { FILE_CHUNK, fromBase64, importFileKey, newFileKey, newNonceBase, sealedSource, toBase64 } from '@relay/protocol';
import { WsTransport } from './transport';
import { loadOps, Ops, type PendingOp } from './ops';
import { folderKey, isNotifyOp, normalizeRule, notifyKey, OP_FOLDERS_ORDER, privacyKey, settingsItem, settingsView } from './settings';
import { applyUserUpdated, meItem, meView, OP_LINKS, OP_PROFILE, OP_USERNAME, userItem } from './profile';
import { OP_SESSIONS_TTL, Sessions } from './sessions';
import { Stickers } from './stickers';
import { SessionEnd } from './session';
import { DevTools, loadSim, type SimState, type SubStat } from './devlog';
import { simFlags, watchLoss } from './devsim';
import { chatTitle, displayName, peopleResult, PeerSigs } from './names';
import { localMedia, localPeople, localTop, type MediaHit, type PersonHit } from './globalSearch';
import { applyMembersReply, membersResult, type MembersReply } from './members';
import { MediaLoader, mediaResult, tabMessages } from './media';
import { evict, EVICT_LIMITS, type EvictKeep, type EvictLimits, type EvictOpts, type EvictStats } from './evict';
import { musicKey, profileMusicResult, profilePhotosResult, ProfileListsLoader, trackOf } from './profileLists';
import type { Action, StorageStats, EngineConfig, LocalChat, LocalMessage, OutboxEntry, Patch, Query, SearchHit, SearchResult } from './types';
import { searchLocal } from './search';
import { shiftCounts, ViewCounter } from './channel';

export interface WatchHandle { update(q: Query): void; close(): void }

interface Watcher { id: number; q: Query; cb: (p: Patch) => void; prev: Result | null; force: boolean; gated: boolean; stat?: SubStat; cursor?: number; first?: number }
type ReqError = { code: string; retry: boolean };
type SyncReply = Extract<ServerFrame, { op: 'updates' | 'tooLong' }>;
type ChatPush = Extract<ServerFrame, { op: 'push' }> & { chatId: number };
/** Страница треда; guest — я не участник группы (тред гостя, store.guests). */
type ThreadPage = { header: Message; messages: Message[]; hasMore: boolean; guest?: ThreadGuest };
type ChatReply = Extract<ServerFrame, { op: 'chatUpdates' | 'chatTooLong' | 'chatGone' }>;
/** Догонка журнала одного чата: идёт ли сейчас, просили ли ещё раз, push'и, пришедшие не по порядку или во время догонки. */
interface ChatSyncState { syncing: boolean; again: boolean; queued: boolean; buffer: Map<number, ChatPush>; gapTimer: ReturnType<typeof setTimeout> | null }

/**
 * Движок синхронизации: владеет Store, держит соединение, догоняет журнал,
 * отправляет очередь, схлопывает прочтение и раздаёт подпискам патчи раз в кадр.
 */
const HISTORY_GATE_MS = 400;
/** Сколько файлов грузится одновременно (как в Telegram — несколько, но не все разом: канал делится, а первый файл не ждёт последнего). */
const UPLOAD_SLOTS = 3;
/** сколько id в одном GET /users?ids= (предел сервера) */
const USERS_BATCH = 200;

/** Чаты, где пачка журнала правит уже существующие сообщения (правка, удаление, реакции, «прослушано», обработанное видео). */
function patchedChats(items: JournalEntry[], after: number): Set<number> {
  const out = new Set<number>();
  for (const { seq, update: u } of items) {
    if (seq > after && (u.type === 'messageEdited' || u.type === 'messageDeleted' || u.type === 'reactions' || u.type === 'reactionCounts' || u.type === 'mediaListened' || u.type === 'attachmentUpdated')) out.add(u.chatId);
  }
  return out;
}

/** Сколько локальный результат поиска переиспользуется после готовности (пара local + полный вызов). */
const SEARCH_MEMO_MS = 300;

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
  private presence = new Map<number, { online: boolean | null; lastSeen: string | null }>();
  private presenceFetched = false;
  private peersRefreshed = false;   // профили собеседников верхних чатов освежены в этой сессии движка
  private presenceDirty = false;   // присутствие не трогает чаты — свой флаг для подписок presence
  private acting = 0;       // действия пользователя в работе: их результат показываем сразу, даже во время догонки
  private syncAgain = false;
  private syncWaiter: { since: number; resolve(f: SyncReply): void; reject(e: ReqError): void } | null = null;
  private reqSeq = 0;
  private pending = new Map<string, { resolve(r: Record<string, unknown>): void; reject(e: ReqError): void }>();
  private pumping = false;
  /** Идущие PUT файлов по clientId — «отмена» прерывает загрузку. */
  private uploads = new Map<string, { abort(): void }>();
  /** Файлы, которые IndexedDB не приняла (квота): живут до перезагрузки вкладки, отправка от этого не страдает. */
  private memBlobs = new Map<string, Blob>();
  private busy = 0;
  private historyLoads = new Map<number, Promise<void>>();
  private chatLoads = new Map<number, Promise<void>>();   // точечная подгрузка открытого чата вне загруженных страниц
  /** Превью каналов, на push'и которых подписан сокет (watchChat): после переподключения — заново (раздел «Превью канала»). */
  private watched = new Set<number>();
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
  /** чёрный список (blocks.ts) */
  private readonly blocks: Blocks;
  /** активные сеансы (sessions.ts) */
  private readonly sessions: Sessions;
  private readonly stickers: Stickers;
  /** конец сеанса: sessionTerminated / 401 (session.ts) */
  private readonly session: SessionEnd;
  /** чужие профили, которых нет в кэше: подгрузим, когда будет связь; asked — уже спрашивали за это подключение */
  private userWants = new Set<number>();
  /** подписи собеседников личных чатов, уже показанные в списке (names.ts) */
  private peerSigs = new PeerSigs();
  /** какое значение «уведомлений» из очереди показано в строке чата: изменилось — строку пересчитать */
  private muteShown = new Map<number, number | null>();
  private flagsShown = new Map<number, string>();   // операции setChatFlags в очереди (подпись) — пересчёт строк при их смене
  private usersAsked = new Set<number>();
  /** участники групп, о которых спросил интерфейс; asked — уже загружали за это подключение */
  private membersWants = new Set<number>();
  private membersAsked = new Set<number>();
  /** «Общие медиа»: загрузка вкладок и счётчиков для подписок media (media.ts) */
  private readonly media: MediaLoader;
  /** просмотры постов каналов: батч раз в секунду (channel.ts) */
  private readonly views: ViewCounter;
  /** музыка и фото профиля: загрузка для подписок (profileLists.ts) */
  private readonly lists: ProfileListsLoader;
  /** раздел «Для разработчиков»: журнал, снимок состояния, имитатор сети (devlog.ts) */
  readonly dev: DevTools;

  private constructor(private cfg: EngineConfig, readonly store: Store, private db: IDBDatabase, ops: PendingOp[], sim: Pick<SimState, 'offline' | 'profile'> | null = null) {
    this.dev = new DevTools(db, {
      view: () => ({
        userId: cfg.userId, epoch: this.store.epoch, lastSeq: this.store.lastSeq, phase: this.phase(), ready: this.ready, syncing: this.syncing,
        socket: this.transport.view(), outbox: this.store.outbox.values(), pendingReads: this.store.pendingReads.size,
        ops: { pending: this.ops.list.length, keys: [...new Set(this.ops.list.map((o) => o.key))], failures: this.ops.failures.length },
        watchers: this.watchers.values(),
      }),
      schedule: () => this.schedule(),
      ping: () => { if (this.online) this.transport.send({ op: 'ping' }); },
      offline: (on) => this.simOffline(on),
      dropSocket: () => this.transport.drop(),
      sync: () => { if (this.online && this.ready) this.runSync(); },
      resync: () => this.resync(),
      restart: async () => { this.transport.stop(); if (this.wantOnline) this.transport.start(); return { restarted: 'reconnect' }; },
      retryFailed: () => this.retryFailed(),
      discardFailed: () => this.discardFailed(),
      // 401 «обнови доступ» — не конец сеанса: подпись ключом устройства, новый короткий cookie, повтор
      wrapFetch: (f) => deviceFetch(f, cfg.httpBase),
    });
    this.dev.restore(sim);
    if (this.dev.sim.offline) this.netDown = true;
    store.onFlush = (keys, ms) => { this.dev.log.record('engine', 'flush', { keys }, undefined, ms); this.scheduleEvict(); };
    this.muteShown = muteOverlay(ops);   // операции, восстановленные из IndexedDB: их отказ после перезапуска тоже пересчитает строку
    this.ops = new Ops(db, ops, { base: cfg.httpBase, headers: cfg.headers, backoffMs: cfg.backoffMs, fetch: this.dev.fetch }, {
      canSend: () => this.online && this.ready && !this.closed && !this.resetting,
      done: (op, value) => this.opDone(op, value),
      changed: () => this.changed(),
      run: (fn) => this.run(fn),
      unauthorized: () => this.session.end('terminated'),
      log: (type, data) => this.dev.log.record('engine', type, data),
    });
    this.contacts = new Contacts({
      store, ops: this.ops, httpBase: cfg.httpBase, headers: cfg.headers, fetch: this.dev.fetch,
      online: () => this.online,
      presence: () => this.presence,
      seedPresence: (id, p) => this.seedPresence(id, p),
      refreshUser: (id) => { this.usersAsked.delete(id); this.userWants.add(id); },
      http: (path) => this.http(path),
      run: (fn) => this.run(fn),
      changed: () => this.changed(),
    });
    this.blocks = new Blocks({ store, ops: this.ops, http: (path) => this.http(path), run: (fn) => this.run(fn), changed: () => this.changed() });
    this.views = new ViewCounter({
      online: () => this.online && this.ready, run: (fn) => this.run(fn), everyMs: cfg.viewsFlushMs ?? 1000,
      post: (chatId, ids) => this.http(`/chats/${chatId}/views`, { method: 'POST', body: JSON.stringify({ ids }) }),
      apply: (chatId, views) => this.run(async () => { this.store.applyViews(chatId, views); this.changed(); }),
    });
    this.media = new MediaLoader(store, { online: () => this.online && this.ready, http: (path) => this.http(path), run: (fn) => this.run(fn), changed: () => this.changed() });
    this.lists = new ProfileListsLoader(store, { online: () => this.online && this.ready, http: (path) => this.http(path), run: (fn) => this.run(fn), changed: () => this.changed() });
    this.sessions = new Sessions({ ops: this.ops, online: () => this.online, http: (path) => this.http(path) });
    this.stickers = new Stickers({ db, online: () => this.online, http: (path) => this.http(path), enqueue: (op) => this.ops.enqueue(op), bump: () => { this.store.stickersRev++; this.changed(); } });
    this.session = new SessionEnd({
      httpBase: cfg.httpBase, headers: cfg.headers, fetch: this.dev.fetch,
      closed: () => this.closed,
      stop: () => { this.dev.log.record('engine', 'sessionEnd', { reason: this.session.reason }); this.ops.close(); this.wantOnline = false; this.transport.stop(); },
      notify: () => this.pushStatus(),
      working: () => this.syncing || this.pumping || this.busy > 1,
      run: (fn) => this.run(fn),
      shutdown: () => {
        if (this.closed) return false;
        this.emit();   // последние патчи (и status.terminated) — подпискам, которые ещё не получили первый снимок
        this.closed = true;
        this.dead = true;
        this.dev.stop();
        if (this.frameTimer) { clearTimeout(this.frameTimer); this.frameTimer = null; }
        if (this.readTimer) { clearTimeout(this.readTimer); this.readTimer = null; }
        if (this.outboxTimer) { clearTimeout(this.outboxTimer); this.outboxTimer = null; }
        if (this.evictTimer) { clearTimeout(this.evictTimer); this.evictTimer = null; }
        for (const t of this.typingTimers.values()) clearTimeout(t);
        this.typingTimers.clear();
        this.views.close();
        this.watchers.clear();
        return true;
      },
      wipe: async () => {
        await this.store.wipe(null).catch(() => {});
        this.db.close();
        try { indexedDB.deleteDatabase(cfg.dbName); } catch { /* */ }
      },
    });
    store.contactOf = (id) => this.contacts.view().get(id);
    store.wantUser = (id) => this.userWants.add(id);
    store.wantRow = (chatId) => this.refreshRows([chatId]);
    store.wantPost = (chatId, id) => {
      if (this.postsNoReplies.has(chatId + ':' + id)) return;   // уже перечитывали — кнопки нет (тред не в текущей группе): не спрашивать снова
      let s = this.postWants.get(chatId); if (!s) { s = new Set(); this.postWants.set(chatId, s); } s.add(id);
    };
    this.transport = new WsTransport(cfg.wsUrl, {
      onOpen: () => this.onOpen(),
      onFrame: (f) => this.onFrame(f),
      onClose: () => this.onClose(),
    }, cfg.backoffMs ?? [250, 5000], this.dev);
  }

  static async open(cfg: EngineConfig): Promise<Engine> {
    let engine: Engine | null = null;
    const db = await openDb(cfg.dbName, { onVersionChange: () => engine?.obsolete() });
    const store = await Store.open(db, cfg.userId);
    engine = new Engine(cfg, store, db, await loadOps(db), await loadSim(db));
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
    this.dev.stop();
    if (this.frameTimer) { clearTimeout(this.frameTimer); this.frameTimer = null; }
    if (this.readTimer) { clearTimeout(this.readTimer); this.readTimer = null; }
    if (this.outboxTimer) { clearTimeout(this.outboxTimer); this.outboxTimer = null; }
    if (this.evictTimer) { clearTimeout(this.evictTimer); this.evictTimer = null; }
    if (this.safetyTimer) { clearInterval(this.safetyTimer); this.safetyTimer = null; }
    this.watchers.clear();
    this.onObsoleteCb();
  }

  /** Движок стёр локальные данные и закрылся после завершения сеанса (хост забывает его). */
  onTerminated(cb: () => void): void { this.session.onDone(cb); }

  connect(): void {
    if (this.closed || this.session.ended) return;
    this.wantOnline = true;
    this.watchNetwork();
    this.transport.start();
    // сверочная синхронизация: NOTIFY уходит после коммита, и упавший между ними процесс никого не «пнёт» —
    // раз в safetySyncMs спрашиваем журнал сами (три дешёвых запроса; при отсутствии нового — пустой ответ)
    if (!this.safetyTimer) this.safetyTimer = setInterval(() => {
      if (!this.online || !this.ready || this.syncing) return;
      this.runSync();
      this.transport.send({ op: 'chatsSince', since: this.store.since });   // журналы чатов: какие менялись с последней сверки
    }, this.cfg.safetySyncMs ?? 90_000);
  }
  private safetyTimer: ReturnType<typeof setInterval> | null = null;
  // ---- журнал чата (группы, каналы): см. раздел «Журнал чата» ----
  private chatSync = new Map<number, ChatSyncState>();
  private chatWaiters = new Map<string, { chatId: number; resolve(f: ChatReply): void; reject(e: ReqError): void }>();
  private chatQueue: number[] = [];
  private chatActive = 0;
  private refreshIds = new Set<number>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private rowsInFlight = false;
  private unknownAsked = new Map<number, number>();
  private sinceCandidate: number | null = null;
  disconnect(): void { this.wantOnline = false; this.transport.stop(); if (this.safetyTimer) { clearInterval(this.safetyTimer); this.safetyTimer = null; } this.changed(); }

  /** События сети воркера/окна: «нет сети» показываем сразу, а при возврате сети подключаемся без ожидания паузы. */
  private watchNetwork(): void {
    const g = globalThis as { addEventListener?: (t: string, cb: () => void) => void };
    if (typeof g.addEventListener !== 'function' || this.netWatched) return;
    this.netWatched = true;
    g.addEventListener('offline', () => { this.netDown = true; this.changed(); });
    g.addEventListener('online', () => { this.netDown = this.dev.sim.offline; this.changed(); this.transport.retryNow(); });   // офлайн имитатора сильнее
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
    this.dev.stop();
    if (this.frameTimer) { clearTimeout(this.frameTimer); this.frameTimer = null; }
    if (this.readTimer) { clearTimeout(this.readTimer); this.readTimer = null; }
    if (this.outboxTimer) { clearTimeout(this.outboxTimer); this.outboxTimer = null; }
    if (this.evictTimer) { clearTimeout(this.evictTimer); this.evictTimer = null; }
    this.watchers.clear();
    await this.whenIdle(2000).catch((e) => console.warn(String(e)));
    await this.evicting?.catch(() => {});   // уборка остановится между порциями — её порция и курсоры дописаны до flush
    await this.store.flush();
    this.db.close();
  }

  // =====================================================================
  // Подписки
  // =====================================================================

  watch(q: Query, cb: (p: Patch) => void): WatchHandle {
    const w: Watcher = { id: this.nextWatch++, q, cb, prev: null, force: true, gated: q.kind === 'messages' || q.kind === 'thread' };
    this.watchers.set(w.id, w);
    if (q.kind === 'messages') this.store.noteOpened(q.chatId);   // уборка урезает давно не открытые первыми
    if (q.kind === 'devStats' || q.kind === 'devLog') this.dev.track(this.watchers.values());
    this.prepare(w);
    this.schedule();
    return {
      update: (q2) => { const chatChanged = q2.kind === 'messages' && (w.q.kind !== 'messages' || w.q.chatId !== q2.chatId); if (chatChanged) this.store.noteOpened(q2.chatId); w.q = q2; w.force = true; if (chatChanged) w.gated = true; this.dev.track(this.watchers.values()); this.prepare(w); this.schedule(); },
      close: () => { this.watchers.delete(w.id); this.dev.track(this.watchers.values()); if (w.q.kind === 'thread') this.syncThreadWatches(); },
    };
  }

  private prepare(w: Watcher): void {
    // профиль человека: из кэша сразу, а с сервера — заново на каждую новую подписку (открыли «Информацию»)
    if (w.q.kind === 'user' && w.q.userId !== this.cfg.userId) { this.usersAsked.delete(w.q.userId); this.userWants.add(w.q.userId); return; }
    // участники: из IndexedDB сразу, с сервера — раз за подключение (дальше свежими держит журнал)
    if (w.q.kind === 'members') { this.membersWants.add(w.q.chatId); this.fetchMembers(); return; }
    // вкладка медиа: из памяти и IndexedDB сразу; с сервера — счётчики раз и страницы, когда не хватает
    if (w.q.kind === 'media') { this.media.want(w.q); return; }
    // музыка и фото профиля: из IndexedDB сразу; с сервера — если не загружали или сводка в профиле сменилась
    if (w.q.kind === 'profileMusic' || w.q.kind === 'profilePhotos') { this.lists.want(w.q); return; }
    if (w.q.kind === 'thread') { this.prepareThread(w); return; }
    if (w.q.kind !== 'messages') return;
    const { chatId, limit } = w.q;
    const q = w.q;
    // первый снимок ленты — уже готовый: кэш прочитан и, если сообщений меньше окна, история догружена
    // (сервер ждём не дольше HISTORY_GATE_MS, без сети — не ждём); иначе интерфейс покажет пусто → часть → всё
    const open = () => { if (w.q === q && w.gated) { w.gated = false; this.changed(); } };
    this.run(async () => {
      try {
        await this.store.loadChatMessages(chatId);
        // чат вне загруженных страниц (ссылка #chat=N): сначала он сам, иначе ни шапки, ни истории
        const history = this.ensureOpenChat(chatId).catch(() => {}).then(() => this.ensureWindow(q));
        if (this.online && w.gated) await Promise.race([history.catch(() => {}), new Promise((r) => setTimeout(r, HISTORY_GATE_MS))]);
        open();
        await history;
      } finally {
        open();
      }
    });
  }

  /** Тред: кэш группы из IndexedDB, затем страницы треда под окно; первый снимок — как у ленты (ждём не дольше HISTORY_GATE_MS). */
  private prepareThread(w: Watcher): void {
    const q = w.q as Extract<Query, { kind: 'thread' }>;
    const open = () => { if (w.q === q && w.gated) { w.gated = false; this.changed(); } };
    this.run(async () => {
      try {
        await this.store.loadChatMessages(q.chatId);
        const history = this.ensureThreadWindow(q);
        if (this.online && w.gated) await Promise.race([history.catch(() => {}), new Promise((r) => setTimeout(r, HISTORY_GATE_MS))]);
        open();
        await history;
      } finally {
        open();
      }
    });
  }

  private changed(): void { this.handleSeqHints(); this.syncThreadWatches(); this.pushStatus(); this.schedule(); }

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
      if (patch) { try { w.cb(patch); } catch (err) { console.error('watch callback failed', err); this.dev.log.error('watch callback', err); } }
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
      chatsTotal: this.store.dialogsTotal,     // сколько диалогов всего (до конца подгрузки — высота списка со скелетами)
      chatsCursorAt: this.store.dialogsAt,     // докуда загружен непрерывный диапазон (мс; 0 — ещё не грузили)
      online: this.online,
      synced: this.ready,
      syncing: this.syncing,
      outbox: [...this.store.outbox.values()].filter((o) => !o.failed).length,
      failed: [...this.store.outbox.values()].filter((o) => o.failed).length,
      ...this.session.status(),
      sessionsRev: this.store.sessionsRev,
      stickersRev: this.store.stickersRev,   // мои стикеры: журнал, переподключение, снимок, свои изменения   // растёт на sessionsChanged из журнала, переподключении и снимке: интерфейс перечитывает сеансы
      devSim: simFlags(this.dev.sim),   // имитатор сети включён — плашка «Режим разработчика» во всех вкладках
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
    if (q.kind === 'blocked') {
      const list = this.blocks.items();
      return { items: new Map(list.map((it) => [it.key, it])), order: list.map((it) => it.key), sig: new Map(list.map((it) => [it.key, JSON.stringify(it)])) };
    }
    if (q.kind === 'settings') {
      const s = this.store.settings, view = settingsView(s.base, this.ops.list);
      const list = settingsItem(view, s.loaded, view !== s.base);
      return { items: new Map(list.map((it) => [it.key, it])), order: list.map((it) => it.key), sig: new Map(list.map((it) => [it.key, JSON.stringify(it)])) };
    }
    if (q.kind === 'me' || q.kind === 'user' || q.kind === 'ops') {
      const list = q.kind === 'ops' ? [this.ops.item()] : q.kind === 'me' ? meItem(this.meNow()) : userItem(this.store.profile, this.meNow(), q.userId);
      if (q.kind === 'user' && !list.length && q.userId !== this.cfg.userId) this.userWants.add(q.userId);
      return { items: new Map(list.map((it) => [it.key, it])), order: list.map((it) => it.key), sig: new Map(list.map((it) => [it.key, JSON.stringify(it)])) };
    }
    if (q.kind === 'members') return membersResult(this.store, q.chatId, this.presence, this.meNow());
    if (q.kind === 'media') return mediaResult(this.store, q, this.media.loading(q.chatId, q.tab));
    if (q.kind === 'profileMusic') return profileMusicResult(this.store, q.userId, this.ops.list, this.lists.loading(q));
    if (q.kind === 'profilePhotos') return profilePhotosResult(this.store, q.userId, this.meNow(), this.lists.loading(q));
    if (q.kind === 'people') return peopleResult(this.store, q.ids, q.ids.includes(this.cfg.userId) ? this.meNow() : null);
    if (q.kind === 'devStats' || q.kind === 'devLog') {
      const it = q.kind === 'devStats' ? this.dev.stats() : { key: 'devLog' };   // devLog идёт мимо compute (dev.pushLog)
      return { items: new Map([[it.key, it]]), order: [it.key], sig: new Map([[it.key, JSON.stringify(it)]]) };
    }
    if (q.kind !== 'status') return computeQuery(this.store, q, muteOverlay(this.ops.list), flagsOverlay(this.ops.list));
    const it = this.statusItem();
    return { items: new Map([[it.key, it]]), order: [it.key], sig: new Map([[it.key, JSON.stringify(it)]]) };
  }

  private schedule(): void {
    if (this.frameTimer || this.closed) return;
    this.frameTimer = setTimeout(() => { this.frameTimer = null; this.emit(); }, this.cfg.frameMs ?? 16);
  }

  /**
   * Загрузка файла в три шага, тело идёт мимо нашего сервера:
   *  1) POST /uploads — запись pending и подписанный PUT (срок — минуты, поэтому ссылку не храним: повтор берёт новую);
   *  2) PUT прямо в хранилище: XHR с прогрессом (есть в воркерах браузера), иначе fetch; без cookie и наших заголовков;
   *  3) POST /uploads/:id/confirm — сервер сверяет размер и тип по HEAD, только после этого вложение можно отправить.
   * Сеть и истёкшая ссылка — повтор позже с начала; отказ сервера (не тот размер/тип, too_long) — сообщение failed.
   * Большой файл (сервер ответил multipart) — частями, см. multipart.ts: принятые части лежат в outbox, повтор их не грузит.
   */
  private async upload(clientId: string, blob: Blob, a: { name: string; mime: string; w: number | null; h: number | null; kind?: string; duration?: number | null; waveform?: string | null; title?: string | null; performer?: string | null }): Promise<{ id: string }> {
    const offline: ReqError = { code: 'offline', retry: true };
    const api = async <T>(path: string, body?: unknown, method = 'POST'): Promise<T> => {
      const r = await this.dev.fetch(this.cfg.httpBase + path, {
        method, credentials: 'include', headers: { 'content-type': 'application/json', ...(this.cfg.headers ?? {}) }, body: body === undefined ? undefined : JSON.stringify(body),
      }).catch(() => { throw offline; });
      if (this.session.unauthorized(r.status)) throw offline;
      if (!r.ok) {
        const code = ((await r.json().catch(() => null)) as { code?: string } | null)?.code ?? 'upload';
        // upload_missing: объект не дошёл (ссылка истекла посреди обрыва) — начнём заново
        throw { code, retry: r.status >= 500 || code === 'upload_missing' } as ReqError;
      }
      return r.json() as Promise<T>;
    };
    const meta: Record<string, unknown> = { name: a.name, mime: a.mime, size: blob.size };
    // файл шифруется здесь, до хранилища (fileCrypto.ts): ключ файла уходит серверу в заявке (он хранит его завёрнутым
    // KMS и кладёт в сообщение под ключом чата), в хранилище — только шифр. Ключ и основа nonce загрузки частями —
    // в outbox: после перезагрузки шифр тот же, принятые части не перегружаются.
    const encrypt = this.cfg.encryptFiles !== false;
    if (a.w && a.h) { meta.w = a.w; meta.h = a.h; }
    if (a.kind === 'voice' || a.kind === 'round' || a.kind === 'audio' || a.kind === 'video') { meta.kind = a.kind; if (a.duration) meta.duration = a.duration; if (a.waveform) meta.waveform = a.waveform; }
    if (a.kind === 'audio') { if (a.title) meta.title = a.title; if (a.performer) meta.performer = a.performer; }
    let mp = this.store.outbox.get(clientId)?.upload ?? null;
    if (mp && encrypt && !mp.key) { await this.saveUpload(clientId, null); mp = null; }   // начата без шифрования (старая версия) — заново
    const keyRaw = mp?.key ? fromBase64(mp.key) : newFileKey();
    const base = mp?.base ? fromBase64(mp.base) : newNonceBase();
    const source: UploadSource = encrypt ? sealedSource(blob, await importFileKey(keyRaw), { chunk: FILE_CHUNK, size: blob.size, base }) : blob;
    if (encrypt) { meta.enc = 1; meta.key = toBase64(keyRaw); }
    if (!mp) {
      const intent = await api<{ id: string; url?: string; mime: string; multipart?: { partSize: number; parts: number } }>('/uploads', meta);
      if (!intent.multipart) {
        await this.put(clientId, intent.url!, await source.slice(0, source.size), intent.mime);
        return api<{ id: string }>(`/uploads/${intent.id}/confirm`);
      }
      mp = { id: intent.id, ...intent.multipart, done: [], ...(encrypt ? { key: toBase64(keyRaw), base: toBase64(base) } : {}) };
      await this.saveUpload(clientId, mp);
    }
    return this.uploadMultipart(clientId, source, mp, api);
  }

  /** Части, затем confirm (сервер собирает объект). Разошлись с сервером (upload_incomplete) — сверяемся и догружаем;
   *  загрузки на сервере больше нет (сутки офлайн — убрана) — забываем её, повтор начнёт заново. */
  private async uploadMultipart(clientId: string, blob: UploadSource, mp: MultipartState, api: <T>(path: string, body?: unknown, method?: string) => Promise<T>): Promise<{ id: string }> {
    let last = 0, pending: ReturnType<typeof setTimeout> | null = null, latest = 0;
    const show = () => {
      pending = null; last = Date.now();
      // последние проценты — сборка и подтверждение на сервере: кольцо не стоит на 100%, пока сообщение ещё не ушло
      this.store.setProgress(clientId, 0.98 * latest);
      this.changed();
    };
    const io = {
      urls: async (parts: number[]) => (await api<{ urls: Record<number, string> }>(`/uploads/${mp.id}/parts`, { parts })).urls,
      saved: (done: number[]) => this.saveUpload(clientId, { ...mp, done }),
      // не чаще 10 раз в секунду на все части вместе; последнее значение не теряется (покажется чуть позже)
      progress: (p: number) => {
        latest = p;
        if (pending) return;
        const wait = 100 - (Date.now() - last);
        if (wait <= 0) show(); else pending = setTimeout(show, wait);
      },
      register: (ctl: { abort(): void }) => this.uploads.set(clientId, ctl),
      cancelled: () => this.cancelled.has(clientId) || !this.store.outbox.has(clientId),
      offline: () => this.dev.sim.offline,
    };
    try {
      for (let round = 0; ; round++) {
        if (io.cancelled()) throw { code: 'cancelled', retry: false } satisfies ReqError;
        await uploadParts(blob, mp, io);
        try { return await api<{ id: string }>(`/uploads/${mp.id}/confirm`); }
        catch (e) {
          if ((e as ReqError).code !== 'upload_incomplete' || round > 0) throw e;
          const st = await api<{ done: number[] }>(`/uploads/${mp.id}/parts`, undefined, 'GET');
          mp = { ...mp, done: st.done };
          await this.saveUpload(clientId, mp);
        }
      }
    } catch (e) {
      const code = (e as ReqError).code;
      if (code === 'not_found' || code === 'upload_mismatch') {
        await this.saveUpload(clientId, null);
        if (code === 'not_found') throw { code, retry: true } satisfies ReqError;
      }
      if (code === 'upload_incomplete') throw { code, retry: true } satisfies ReqError;   // сверились и снова не сошлось — позже
      // хранилище недоступно, а сокет жив: переподключения, которое запустит очередь, не будет — повтор с паузой
      if (code === 'offline' && this.online && !this.netDown) throw { code: 'upload', retry: true } satisfies ReqError;
      throw e;
    } finally {
      if (pending) { clearTimeout(pending); show(); }
      this.uploads.delete(clientId);
    }
  }

  /** Состояние загрузки частями — в outbox (IndexedDB), чтобы пережить перезагрузку вкладки. */
  private async saveUpload(clientId: string, mp: MultipartState | null): Promise<void> {
    if (!this.store.outbox.has(clientId)) return;
    this.store.setUploadState(clientId, mp);
    await this.store.flush();
  }

  /** PUT по подписанной ссылке. 403 — ссылка истекла (долго были офлайн между шагами): повтор возьмёт новую. */
  private put(clientId: string, url: string, blob: Blob, mime: string): Promise<void> {
    const offline: ReqError = { code: 'offline', retry: true };
    const fail = (status: number): ReqError => ({ code: 'upload', retry: status >= 500 || status === 403 || status === 408 || status === 429 });
    if (this.dev.sim.offline) return Promise.reject(offline);   // dev: офлайн (задержку XHR имитатор не накладывает)
    if (!this.store.outbox.has(clientId)) return Promise.reject({ code: 'cancelled', retry: false } satisfies ReqError);   // отменили, пока брали ссылку
    if (typeof XMLHttpRequest === 'undefined') {
      const ac = new AbortController();
      this.uploads.set(clientId, ac);
      return fetch(url, { method: 'PUT', body: blob, headers: { 'content-type': mime }, signal: ac.signal })
        .then((r) => { if (!r.ok) throw fail(r.status); }, () => { throw this.cancelled.has(clientId) ? { code: 'cancelled', retry: false } satisfies ReqError : offline; })
        .finally(() => { if (this.uploads.get(clientId) === ac) this.uploads.delete(clientId); });
    }
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      x.setRequestHeader('content-type', mime);
      let last = 0;
      x.upload.onprogress = (e) => {
        if (!e.lengthComputable || e.timeStamp - last < 100) return; // не чаще 10 раз в секунду
        last = e.timeStamp;
        // последние проценты — подтверждение на сервере: кольцо не стоит на 100%, пока сообщение ещё не ушло
        this.store.setProgress(clientId, 0.98 * e.loaded / e.total);
        this.changed();
      };
      const done = () => { if (this.uploads.get(clientId) === x) this.uploads.delete(clientId); };
      x.onload = () => { done(); if (x.status < 300) resolve(); else reject(fail(x.status)); };
      x.onerror = () => { done(); reject(offline); };
      // отмена из ленты: сообщения уже нет в очереди — отказ без повтора, pumpOutbox пойдёт дальше
      x.onabort = () => { done(); reject(this.cancelled.has(clientId) ? { code: 'cancelled', retry: false } satisfies ReqError : offline); };
      this.uploads.set(clientId, x);
      x.send(blob);
    });
  }

  /** Очистка локальных данных: общий wipe (как при смене epoch), затем повторный hello — он возьмёт снимок.
   *  Пока идёт очистка, `resetting` не даёт стартовать hello/синхронизации/отправке/операциям; идущую работу ждём и при таймауте отказываем. */
  private resetting = false;
  /** hello/poke, пришедшие во время очистки: при отказе проигрываем их, иначе синхронизация встанет до переподключения */
  /** сколько hello пришло этому экземпляру движка: со второго — переподключение (sessionsRev) */
  private hellos = 0;
  private skipped: { hello: Extract<ServerFrame, { op: 'hello' }> | null; poke: boolean } = { hello: null, poke: false };
  private async storageStats(): Promise<StorageStats> {
    const rows = await countStores(this.db);
    let bytes: number | null = null, exact = false;
    try {
      const e = (await navigator.storage.estimate()) as StorageEstimate & { usageDetails?: { indexedDB?: number } };
      exact = e.usageDetails?.indexedDB != null;
      bytes = e.usageDetails?.indexedDB ?? e.usage ?? null;
    } catch { /* оценки нет (старый браузер, тест) */ }
    return { rows, bytes, exact };
  }
  private async resetLocal(keepOutbox: boolean): Promise<void> {
    if (this.resetting) throw new Error('reset_busy');
    this.dev.log.record('engine', 'resetLocal', { keepOutbox });
    this.resetting = true;
    let ok = false;
    try {
      const end = Date.now() + (this.cfg.resetWaitMs ?? 8000);
      for (const x of this.uploads.values()) x.abort();   // загрузка большого файла может идти минутами — прервём, после очистки начнётся заново
      while (this.syncing || this.pumping || this.ops.busy || this.busy > 0) {
        if (Date.now() > end) throw new Error('reset_busy');
        await new Promise((r) => setTimeout(r, 10));
      }
      await this.store.wipe(this.store.epoch, { outbox: keepOutbox });
      this.clearAllChatState();
      if (!keepOutbox) this.ops.forget();
      this.forgetAsked();
      this.ready = false;
      this.holding = false;
      this.emit();   // подписки видят пустой кэш сразу: ответ на hello снова включит удержание до конца снимка
      ok = true;
    } finally {
      this.resetting = false;
      const sk = this.skipped;
      this.skipped = { hello: null, poke: false };
      if (!ok) {   // очистка не состоялась: возвращаем пропущенное и будим отправку
        if (sk.hello) this.onFrame(sk.hello); else if (sk.poke) this.runSync();
        this.ops.kick();
        this.changed();
      }
    }
    this.changed();
    this.transport.send({ op: 'hello', lastSeq: 0, since: 0 });
  }

  /**
   * Поиск: сначала по указателю слов на устройстве (без сети — только он), с сетью — к нему дописываются
   * результаты сервера (вся история); повторы по chatId:id убираются, совпадение с устройства остаётся.
   * Список — новые первыми, обрезан до limit: следующая страница по beforeId не повторит и не потеряет ни одного.
   * local: true — только локальные, сразу (интерфейс показывает их, пока ждёт полный ответ).
   */
  private async search(a: Extract<Action, { type: 'search' }>): Promise<SearchResult> {
    const limit = a.limit ?? 30;
    const local = this.searchLocal(a, limit);
    if (a.local || !this.online) return local;
    let res: { hits: { message: Message; chatTitle: string | null }[]; hasMore: boolean };
    try {
      const qs = new URLSearchParams({ q: a.q, limit: String(limit) });
      if (a.chatId) qs.set('chatId', String(a.chatId));
      if (a.beforeId) qs.set('beforeId', String(a.beforeId));
      res = await this.http(`/search?${qs}`);
    } catch { return local; }   // сеть пропала посреди запроса — только локальные
    const mine = await local.catch((): SearchResult => ({ hits: [], hasMore: false, source: 'local' }));   // локальная часть упала — ответ сервера не теряем
    const seen = new Set(mine.hits.map((h) => h.chatId + ':' + h.id));
    const server: SearchHit[] = res.hits.filter(({ message: m }) => !seen.has(m.chatId + ':' + m.id)).map(({ message: m, chatTitle }) => (
      { chatId: m.chatId, chatTitle: this.titleOfChat(m.chatId) ?? chatTitle ?? null, id: m.id, sort: m.id, senderId: m.senderId, body: m.body, createdAt: m.createdAt, kind: m.kind, attachment: m.attachment ?? null, entities: m.entities ?? null, ...(m.service ? { service: m.service } : {}), source: 'server' }));
    const all = [...mine.hits, ...server].sort((x, y) => y.id - x.id);
    return { hits: all.slice(0, limit), hasMore: all.length > limit || res.hasMore || mine.hasMore, source: 'server' };
  }

  // ---------- глобальный поиск левой колонки: сервер, без сети или при ошибке — устройство (globalSearch.ts) ----------

  /** Запрос к серверу не удался: сеанс завершён — ошибка дальше (не подменяем её ответом с устройства); иначе — сеть. */
  private searchFailed(e: unknown): void { if (this.session.ended) throw e; }

  private async searchPeople(q: string): Promise<PersonHit[]> {
    if (this.online) {
      try { return (await this.http<{ people: PersonHit[] }>(`/search/people?${new URLSearchParams({ q })}`)).people; }
      catch (e) { this.searchFailed(e); }   // сеть пропала посреди запроса — ответим с устройства
    }
    this.searchFailed(new Error('session_ended'));
    return localPeople(this.store, this.contacts.view(), this.cfg.userId, q);
  }

  private async searchMedia(kind: MediaTab, q: string, before?: number): Promise<{ hits: MediaHit[]; hasMore: boolean; next?: number }> {
    if (!MEDIA_TABS.includes(kind)) throw new Error('bad_frame');
    if (this.online) {
      try { return await this.http<{ hits: MediaHit[]; hasMore: boolean }>(`/search/media?${new URLSearchParams({ kind, q, ...(before ? { before: String(before) } : {}) })}`); }
      catch (e) { this.searchFailed(e); }   // сеть пропала — с устройства
    }
    this.searchFailed(new Error('session_ended'));
    if (this.store.termsDirty) await this.store.flush();   // последние сообщения — в IndexedDB (индекс byTab)
    const { scanned: _s, ...r } = await localMedia(this.db, this.store, kind, q, before);
    return r;
  }

  private async topChats(): Promise<number[]> {
    if (this.online) {
      try { return (await this.http<{ chatIds: number[] }>('/search/top')).chatIds; }
      catch (e) { this.searchFailed(e); }   // без сети — по последним сообщениям
    }
    this.searchFailed(new Error('session_ended'));
    return localTop(this.store);
  }

  /**
   * Локальная часть поиска, одна на запрос: вызов с local: true и следующий за ним полный (интерфейс шлёт их подряд)
   * делят один промис — пока он идёт и ещё SEARCH_MEMO_MS после (за это время кэш почти не меняется).
   */
  private searchLocal(a: Extract<Action, { type: 'search' }>, limit: number): Promise<SearchResult> {
    const key = [a.q, a.chatId ?? '', a.beforeId ?? '', limit].join('\0');
    let p = this.searchMemo.get(key);
    if (!p) {
      p = this.searchLocalNow(a, limit);
      this.searchMemo.set(key, p);
      const drop = () => setTimeout(() => { if (this.searchMemo.get(key) === p) this.searchMemo.delete(key); }, SEARCH_MEMO_MS);
      p.then(drop, drop);
    }
    return p;
  }
  private searchMemo = new Map<string, Promise<SearchResult>>();

  /** Указатель дописан (flush — только если он отстаёт от памяти), затем searchLocal по нему. */
  private async searchLocalNow(a: Extract<Action, { type: 'search' }>, limit: number): Promise<SearchResult> {
    if (this.store.termsDirty) await this.store.flush();   // слова последних сообщений — в указатель
    const { list, hasMore } = await searchLocal(this.db, a.q, { chatId: a.chatId, beforeId: a.beforeId, limit }, (c, k) => this.store.loadedMessage(c, k));
    return {
      hits: list.map((m) => ({ chatId: m.chatId, chatTitle: this.titleOfChat(m.chatId), id: m.id!, sort: m.sort, senderId: m.senderId, body: m.body, createdAt: m.createdAt, kind: m.kind, attachment: (m.attachment as never) ?? null, entities: m.entities ?? null, ...(m.service ? { service: m.service } : {}), source: 'local' as const })),
      hasMore, source: 'local',
    };
  }

  /** Отправить на сервер черновики этого устройства (сервер разнесёт их по остальным через журнал). */
  private pushDrafts(): void {
    if (!this.online || !this.ready) return;
    for (const chatId of [...this.store.pendingDrafts]) {
      const draft = this.store.chats.get(chatId)?.draft ?? null;
      const text = draft?.text ?? '';
      this.run(async () => {
        await this.request({ op: 'draft', reqId: '', chatId, text, entities: draft?.entities ?? [] });
        // за время запроса черновик могли поменять — тогда он уйдёт следующим вызовом
        if ((this.store.chats.get(chatId)?.draft ?? null) === draft) this.store.pendingDrafts.delete(chatId);
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
        await this.store.loadChatMessages(chatId);   // исходники ложатся строками чата: сначала — его сохранённые сообщения
        this.store.addQuotes(chatId, res.messages, [...ids]);
        this.changed();
      });
    }
  }

  /** Название чата для поиска: известный чат — как в списке (личный — displayName), иначе — что сказал сервер. */
  private titleOfChat(chatId: number): string | null {
    const c = this.store.chats.get(chatId);
    return c ? chatTitle(this.store, c) : null;
  }

  /** Операция setChatFlags: поставлена, заменена или ушла из очереди — строку пересчитать (место в списке, архив, бейдж). */
  private retouchFlags(): void {
    const now = new Map([...flagsOverlay(this.ops.list)].map(([id, v]) => [id, JSON.stringify(v)] as const));
    for (const [id, v] of now) if (this.flagsShown.get(id) !== v) this.store.retouch(id);
    for (const id of this.flagsShown.keys()) if (!now.has(id)) this.store.retouch(id);
    this.flagsShown = now;
  }

  /** Операция mute: поставлена, заменена или ушла из очереди — строку чата пересчитать (в IndexedDB ничего не пишется). */
  private retouchMute(): void {
    const now = muteOverlay(this.ops.list);
    for (const [id, v] of now) if (!this.muteShown.has(id) || this.muteShown.get(id) !== v) this.store.retouch(id);
    for (const id of this.muteShown.keys()) if (!now.has(id)) this.store.retouch(id);
    this.muteShown = now;
  }

  private emit(): void {
    this.contacts.repair();
    // собеседник выглядит иначе (профиль, контакт, очередь) — строки его личных чатов пересчитать
    if (this.store.profile.dirty || this.store.contacts.dirty || this.ops.dirty) this.peerSigs.retouch(this.store);
    if (this.ops.dirty) { this.retouchMute(); this.retouchFlags(); }
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
    const peopleDirty = this.store.contacts.dirty || profileDirty;   // имя — из профиля, контакта и очереди
    const membersTouched = new Set(this.store.members.touched);
    this.store.members.touched.clear();
    const listsTouched = new Set(this.store.profileLists.touched);
    this.store.profileLists.touched.clear();
    this.store.contacts.dirty = false;
    const settingsDirty = this.store.settings.dirty || opsDirty;
    this.store.settings.dirty = false;
    const blocksDirty = this.store.blocks.dirty || opsDirty || profileDirty;
    this.store.blocks.dirty = false;
    const devDirty = this.dev.statsDue;
    // me/user выводятся из очереди: при удержании изменение очереди не теряем — оно уйдёт с концом догонки
    this.store.profile.dirty = hold && profileDirty;
    this.statusSig = sig;
    for (const w of this.watchers.values()) {
      if (w.q.kind === 'devLog') { this.dev.pushLog(w); continue; }   // журнал: только новые события, пачкой раз в 250 мс
      const own = (w.q.kind === 'devStats' && devDirty) || (w.q.kind === 'status' && statusChanged) || (w.q.kind === 'presence' && presenceDirty) || (w.q.kind === 'ops' && opsDirty) || ((w.q.kind === 'me' || w.q.kind === 'user') && profileDirty) || (w.q.kind === 'people' && peopleDirty) || (w.q.kind === 'contacts' && contactsDirty) || (w.q.kind === 'settings' && settingsDirty) || (w.q.kind === 'blocked' && blocksDirty) || (w.q.kind === 'members' && (membersTouched.has(w.q.chatId) || peopleDirty || presenceDirty))
        || (w.q.kind === 'profileMusic' && (listsTouched.has('m:' + w.q.userId) || (opsDirty && w.q.userId === this.cfg.userId)))
        || (w.q.kind === 'profilePhotos' && (listsTouched.has('p:' + w.q.userId) || profileDirty));
      if (!w.force && !affects(w.q, touched) && !own) continue;
      if (hold && !w.force && w.q.kind !== 'status' && w.q.kind !== 'presence' && w.q.kind !== 'ops' && w.q.kind !== 'contacts' && w.q.kind !== 'people' && w.q.kind !== 'settings' && w.q.kind !== 'blocked' && w.q.kind !== 'members' && w.q.kind !== 'profileMusic' && w.q.kind !== 'profilePhotos' && w.q.kind !== 'devStats') continue;
      if (w.gated) continue;
      w.force = false;
      const next = this.compute(w.q);
      if (w.q.kind === 'people') this.wantPeople(w.q.ids);
      const patch = diffResults(w.prev, next);
      w.prev = next;
      if (patch) {
        this.dev.patched(w, patch);
        try { w.cb(patch); } catch (err) { console.error('watch callback failed', err); this.dev.log.error('watch callback', err); }
      }
    }
    this.dev.afterEmit();
    this.fetchQuotes();
    this.fetchPosts();
    this.fetchUsers();
    this.fetchMembers();
    for (const w of this.watchers.values()) {
      if (w.q.kind === 'media') this.media.want(w.q);
      else if (w.q.kind === 'profileMusic' || w.q.kind === 'profilePhotos') this.lists.want(w.q);   // устарел (сводка сменилась) — перечитать
    }
  }

  /** Присутствие из ответа сервера, если живого ещё нет (без связи — не знаем). */
  private seedPresence(id: number, p: { online: boolean | null; lastSeen: string | null }): void {
    if (this.online && !this.presence.has(id)) { this.presence.set(id, p); this.presenceDirty = true; }
  }

  /**
   * Участники групп, о которых спросил интерфейс, — GET /chats/:id/members раз за подключение. Снимок кладётся
   * с seq на момент запроса: записи журнала, пришедшие пока ждали, он не откатывает. Присутствие — только в память.
   */
  private fetchMembers(): void {
    if (!this.online || !this.ready || !this.membersWants.size) return;
    for (const chatId of [...this.membersWants]) {
      const chat = this.store.chats.get(chatId);
      if (!chat?.group) continue;   // чат или его группа ещё не пришли (знаем только по сообщению) — спросим, когда появятся
      this.membersWants.delete(chatId);
      if (this.membersAsked.has(chatId)) continue;
      this.membersAsked.add(chatId);
      const seq = this.store.lastSeq;
      // записи журнала, пришедшие пока ждём снимок, применяются сразу (раньше снимка) — снимок их не откатит
      if (chat.membersDone === undefined) this.store.members.loading.add(chatId);
      this.run(async () => {
        let r: MembersReply;
        try { r = await this.http<MembersReply>(`/chats/${chatId}/members`); }
        catch (err) {
          this.store.members.loading.delete(chatId);
          if (!this.online) { this.membersAsked.delete(chatId); this.membersWants.add(chatId); }   // спросим после переподключения
          throw err;
        }
        applyMembersReply(this.store, chatId, r, seq);
        for (const m of r.members) if (m.userId !== this.cfg.userId) this.seedPresence(m.userId, { online: m.online, lastSeen: m.lastSeen });
        await this.store.flush();
        this.changed();
      });
    }
  }

  /** Свой профиль для интерфейса: база + очередь. */
  private meNow(): Me | null { return meView(this.store.profile.me, this.ops.list); }
  /** Имя автора для «Переслано от» до ответа сервера: я, известный профиль, как зритель видит человека. */
  private nameOf(userId: number): string {
    if (userId === this.cfg.userId) return this.meNow()?.name ?? '';
    const u = this.store.profile.users.get(userId);
    if (u?.name) return u.name;
    return displayName(this.store, userId);
  }

  /** Операция подтверждена: ответ профиля — новая база (журнал принесёт то же самое ещё раз — не страшно). */
  private opDone(op: PendingOp, value: unknown): void {
    if (this.contacts.opDone(op, value)) return;
    if (this.blocks.opDone(op, value)) return;
    if (this.lists.opDone(op, value)) return;
    if (op.key.startsWith('flags:')) {
      // ответ — все три флага сервера: новая база (журнал принесёт то же самое ещё раз)
      const v = value as { pinnedAt?: number | null; archived?: boolean; unreadMark?: boolean } | null;
      if (v && typeof v.archived === 'boolean') { this.store.setFlags(Number(op.key.slice(6)), { pinnedAt: v.pinnedAt ?? null, archived: v.archived, unreadMark: !!v.unreadMark, archivedAtId: (v as { archivedAtId?: number }).archivedAtId }); this.run(() => this.store.flush()); }
      return;
    }
    if (op.key.startsWith('unarchive:')) {
      // ответ — всегда текущие флаги сервера (и при changed: false): оверлей снимается, стор — по ответу
      const v = value as { pinnedAt?: number | null; archived?: boolean; unreadMark?: boolean; archivedAtId?: number } | null;
      if (v && typeof v.archived === 'boolean') { this.store.setFlags(Number(op.key.slice(10)), { pinnedAt: v.pinnedAt ?? null, archived: v.archived, unreadMark: !!v.unreadMark, archivedAtId: v.archivedAtId }); this.run(() => this.store.flush()); }
      return;
    }
    if (op.key.startsWith('mute:')) {
      // ответ — новая база: между уходом операции и записью журнала строка не откатится
      const v = value as { muteUntil?: number | null } | null;
      if (v && v.muteUntil !== undefined) { this.store.setMute(Number(op.key.slice(5)), v.muteUntil); this.run(() => this.store.flush()); }
      return;
    }
    if (isNotifyOp(op)) {
      // ответ — новая база: иначе между уходом операции из очереди и записью журнала переключатель мигнул бы
      const v = value as (SettingsSnapshot) | null;
      if (v?.notify && this.store.settings.apply({ notify: v.notify, sessionsTtlDays: v.sessionsTtlDays, folders: v.folders, privacy: v.privacy }, v.seq)) this.run(() => this.store.flush());
      return;
    }
    if ((op.key === OP_PROFILE || op.key === OP_USERNAME || op.key === OP_LINKS) && value && typeof value === 'object' && (value as Me).userId === this.cfg.userId) {
      if (this.store.profile.setMe(value as Me)) this.run(() => this.store.flush());
    }
  }

  /** Настройки аккаунта с сервера — после каждого hello (журнал мог потерять settingsChanged). */
  private fetchSettings(): void {
    this.run(async () => {
      const r = await this.http<SettingsSnapshot>('/settings');
      if (!this.store.settings.apply({ notify: r.notify, sessionsTtlDays: r.sessionsTtlDays, folders: r.folders, privacy: r.privacy }, r.seq)) return;
      await this.store.flush();
      this.changed();
    });
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

  /** Люди подписки people, которых нет в кэше: спросим пачкой (fetchUsers); у вкладок воркера общий набор — один запрос. */
  private wantPeople(ids: readonly number[]): void {
    for (const id of ids) if (id !== this.cfg.userId && !this.store.users.get(id) && !this.usersAsked.has(id)) this.userWants.add(id);
  }

  /**
   * Чужие профили, о которых спросил интерфейс, — пачками GET /users?ids= (до USERS_BATCH) за подключение.
   * Профиль кладётся с seq ответа: снимок старее уже применённой записи журнала не откатывает её. Кого сервер
   * не вернул (не видим этого человека), остаётся в usersAsked — до переподключения не спрашиваем снова.
   */
  private fetchUsers(): void {
    if (!this.online || !this.ready || !this.userWants.size) return;
    const ids = [...this.userWants].filter((id) => !this.usersAsked.has(id));
    this.userWants.clear();
    for (const id of ids) this.usersAsked.add(id);
    for (let i = 0; i < ids.length; i += USERS_BATCH) {
      const part = ids.slice(i, i + USERS_BATCH);
      this.run(async () => {
        let r: { users: PublicUser[]; seq: number };
        try { r = await this.http(`/users?ids=${part.join(',')}`); }
        catch {
          // связь пропала — спросим после переподключения; отказ сервера — не повторяем в цикле
          if (!this.online) for (const id of part) { this.usersAsked.delete(id); this.userWants.add(id); }
          return;
        }
        for (const u of r.users) applyUserUpdated(this.store, u, r.seq);
        if (!r.users.length) return;
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
        this.store.addPending({ clientId, chatId: a.chatId, body: a.body, entities: a.entities ?? [], replyToId: a.replyToId ?? null, createdAt: this.lastCreated, failed: false,
          ...(a.noLinkPreview ? { noLinkPreview: true } : a.link ? { link: a.link } : {}),
          ...(a.attachment && a.attachment.id ? { attachment: a.attachment } : {}),
          ...(a.blocks && a.blocks.length ? { blocks: a.blocks } : {}),
          ...(a.threadId != null ? { threadId: a.threadId } : {}) });
        this.store.setDraft(a.chatId, '');   // отправили — черновик больше не нужен
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        return { clientId };
      }
      case 'seen': {
        if (this.store.previews.has(a.chatId)) return null;   // превью канала: читать нечего — не подписан
        if (this.store.localRead(a.chatId, a.upToId)) {
          await this.store.flush();
          this.changed();
          this.scheduleReads();
        }
        return null;
      }
      case 'markThreadRead': {
        if (this.store.localThreadRead(a.chatId, a.threadId, a.upToId)) { this.changed(); this.scheduleReads(); }
        return null;
      }
      case 'nextMention': return this.store.nextMention(a.chatId);
      case 'readBy': {
        let res: Response;
        try { res = await this.dev.fetch(`${this.cfg.httpBase}/chats/${a.chatId}/messages/${a.id}/read-by`, { credentials: 'include', headers: this.cfg.headers }); }
        catch { return { ok: false, code: 'offline' }; }
        if (this.session.unauthorized(res.status)) return { ok: false, code: 'offline' };
        const data = await res.json().catch(() => null) as { code?: string } | null;
        return res.ok ? { ok: true, data } : { ok: false, code: data?.code ?? 'internal' };
      }
      case 'loadThread': {
        await this.store.loadChatMessages(a.chatId);
        await this.loadThreadPage(a.chatId, a.threadId, (t) => t?.historyStart && t.ranges.length <= 1 ? undefined : t?.ranges[t.ranges.length - 1]?.[0] ?? null);
        return null;
      }
      case 'loadOlder': {
        this.dev.log.record('engine', 'loadOlder', { chatId: a.chatId });
        await this.store.loadChatMessages(a.chatId);
        const chat = this.store.chats.get(a.chatId);
        const span = chat && feedSpan(chat, this.store.chatMessages(a.chatId));
        if (span) await this.ensureHistory(a.chatId, undefined, span.hi - span.lo + (this.cfg.historyPage ?? 50));
        return null;
      }
      case 'refreshChats': {
        if (this.online) this.refreshList();
        return null;
      }
      case 'setDraft': {
        if (this.store.setDraft(a.chatId, a.text, a.entities)) {
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
        await this.request({ op: 'edit', reqId: '', chatId: a.chatId, id: a.id, body: a.body, entities: a.entities ?? [] });
        return null;
      }
      case 'countViews': if (!this.store.previews.has(a.chatId)) this.views.add(a.chatId, a.ids); return null;   // превью: просмотры не считаем
      case 'listened': {
        // у себя — сразу (точка гаснет), сервер разнесёт остальным; без сети — повторим при следующем прослушивании
        this.store.patchMessage(a.chatId, a.id, { listened: true });
        this.changed();
        if (this.online) this.run(async () => { await this.request({ op: 'listened', reqId: '', chatId: a.chatId, id: a.id }); });
        return null;
      }
      case 'deleteMessage': {
        if (!this.online) throw new Error('offline');
        await this.request({ op: 'delete', reqId: '', chatId: a.chatId, id: a.id });
        return null;
      }
      case 'sendTodo': {
        // чек-лист — как сообщение: в очередь (переживёт офлайн), задачи до ответа сервера пронумерованы 1..N
        const clientId = crypto.randomUUID();
        this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
        const todo = { title: a.todo.title, items: a.todo.items.map((it, i) => ({ id: i + 1, title: it.title })), othersCanAppend: a.todo.othersCanAppend, othersCanComplete: a.todo.othersCanComplete, completions: [] };
        this.store.addPending({ clientId, chatId: a.chatId, body: a.todo.title, entities: [], replyToId: a.replyToId ?? null, createdAt: this.lastCreated, failed: false, todo });
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        return { clientId };
      }
      case 'todoToggle': {
        if (!this.online) throw new Error('offline');
        // отметка — сразу у себя (галочка отзывается мгновенно); ошибка — откат
        const m = this.store.messageById(a.chatId, a.id);
        const prev = m?.todo;
        if (prev) {
          const rest = prev.completions.filter((c) => c.id !== a.itemId);
          const completions = a.done ? rest.concat([{ id: a.itemId, by: this.cfg.userId, at: new Date().toISOString() }]) : rest;
          this.store.patchMessage(a.chatId, a.id, { todo: { ...prev, completions } });
          this.changed();
        }
        try {
          await this.request({ op: 'todoToggle', reqId: '', chatId: a.chatId, id: a.id, completed: a.done ? [a.itemId] : [], incompleted: a.done ? [] : [a.itemId] });
        } catch (e) {
          if (prev) { this.store.patchMessage(a.chatId, a.id, { todo: prev }); this.changed(); }
          throw e;
        }
        return null;
      }
      case 'todoAppend': {
        if (!this.online) throw new Error('offline');
        return this.request({ op: 'todoAppend', reqId: '', chatId: a.chatId, id: a.id, items: a.items });
      }
      case 'todoEdit': {
        if (!this.online) throw new Error('offline');
        return this.request({ op: 'todoEdit', reqId: '', chatId: a.chatId, id: a.id, todo: a.todo });
      }
      case 'pressButton': {
        // как callback_query: без сети не нажимается; правку сообщения (итог, без кнопок) сервер пришлёт журналом
        if (!this.online) throw new Error('offline');
        return this.request({ op: 'button', reqId: '', chatId: a.chatId, id: a.id, data: a.data });
      }
      case 'react': {
        if (!this.online) throw new Error('offline');
        if (this.store.previews.has(a.chatId)) throw new Error('not_member');   // превью: реакции только для чтения
        const m = this.store.messageById(a.chatId, a.id);
        if (m?.post) {
          // пост канала: счётчики и моя — сразу у себя, затем точные из ответа; чужие — событием reactionCounts раз в секунду
          const prev = { reactionCounts: m.reactionCounts ?? [], myReaction: m.myReaction };
          this.store.patchMessage(a.chatId, a.id, { reactionCounts: shiftCounts(prev.reactionCounts, m.myReaction ?? null, a.emoji), myReaction: a.emoji ?? undefined });
          this.changed();
          try {
            const r = await this.request({ op: 'react', reqId: '', chatId: a.chatId, id: a.id, emoji: a.emoji }) as { counts?: [string, number][]; mine?: string | null };
            if (r.counts) { this.store.patchMessage(a.chatId, a.id, { reactionCounts: r.counts, myReaction: r.mine ?? undefined }); this.changed(); }
          } catch (err) { this.store.patchMessage(a.chatId, a.id, prev); this.changed(); throw err; }
          return null;
        }
        // сразу у себя (реакция должна отзываться мгновенно), подтверждение и чужие — через журнал
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
      case 'resetLocal': return this.resetLocal(a.keepOutbox !== false);
      case 'storageStats': return this.storageStats();
      case 'dev': return this.dev.command(a).finally(() => this.pushStatus());   // флаги имитатора — в status сразу
      case 'search': return this.search(a);
      case 'searchPeople': return this.searchPeople(a.q);
      case 'searchChannels': return this.online ? this.http<{ channels: unknown[] }>(`/search/channels?${new URLSearchParams({ q: a.q })}`).then((r) => r.channels) : [];
      case 'openPreview': return this.openPreview(a.chatId);
      case 'closePreview': return this.closePreview(a.chatId);
      case 'searchMedia': return this.searchMedia(a.kind, a.q, a.before);
      case 'topChats': return this.topChats();
      // закрепление — сразу на сервер (без сети — ошибка, интерфейс скажет); список придёт и обновлением журнала
      case 'group': {
        // управление группой: только /groups/... и /join/... (и удаление личного чата); ответ — данные или код ошибки сервера (для текста в интерфейсе)
        if (!/^\/(groups|join)\//.test(a.path) && !/^\/chats\/\d+\/delete$/.test(a.path)) return { ok: false, code: 'bad_frame' };
        let res: Response;
        try {
          res = await this.dev.fetch(this.cfg.httpBase + a.path, {
            method: a.method, credentials: 'include',
            headers: a.body !== undefined ? { ...this.cfg.headers, 'content-type': 'application/json' } : this.cfg.headers,
            ...(a.body !== undefined ? { body: JSON.stringify(a.body) } : {}),
          });
        } catch { return { ok: false, code: 'offline' }; }
        if (this.session.unauthorized(res.status)) return { ok: false, code: 'offline' };
        const data = await res.json().catch(() => null) as { code?: string } | null;
        if (!res.ok) return { ok: false, code: data?.code ?? 'internal', status: res.status };
        // изменения придут журналом; подтолкнуть синхронизацию, чтобы интерфейс увидел их сразу
        if (a.method !== 'GET' && !this.resetting) this.runSync();
        return { ok: true, data };
      }
      case 'pin': case 'unpin': {
        const res = await this.http<{ ids: number[] }>(a.type === 'pin' ? `/chats/${a.chatId}/pins` : `/chats/${a.chatId}/pins${a.id != null ? '/' + a.id : ''}`,
          a.type === 'pin' ? { method: 'POST', body: JSON.stringify({ messageId: a.id }) } : { method: 'DELETE' });
        this.store.applyUpdate({ type: 'pins', chatId: a.chatId, ids: res.ids });
        this.changed();
        return res;
      }
      case 'commonGroups': return this.http<{ groups: unknown[] }>(`/users/${a.userId}/common-groups`).then((r) => r.groups);
      case 'messagesByIds': return this.http<{ messages: Message[] }>(`/chats/${a.chatId}/messages?ids=${a.ids.slice(0, 100).join(',')}`).then((r) => r.messages);
      case 'sendFile': {
        // файл — в IDB (переживёт офлайн и перезагрузку), сообщение — в очередь; загрузка и отправка — в pumpOutbox
        // больше предела — не ставим в очередь вовсе (интерфейс уже показал, почему): сервер всё равно откажет
        if (a.file.size > MAX_FILE_BYTES) throw new Error('file_too_big');
        const clientId = crypto.randomUUID();
        this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
        // большой файл может не влезть в квоту IndexedDB — тогда держим его в памяти (не переживёт перезагрузку, но уйдёт)
        await putBlob(this.db, clientId, a.file).catch((err) => { this.dev.log.error('putBlob', err); this.memBlobs.set(clientId, a.file); });
        const photo = !a.kind && /^image\//.test(a.mime) && !!a.w && !!a.h;
        const sized = photo || a.kind === 'round' || a.kind === 'video';
        this.store.addPending({ clientId, chatId: a.chatId, body: a.body, replyToId: a.replyToId ?? null, createdAt: this.lastCreated, failed: false,
          ...(a.groupId ? { groupId: a.groupId } : {}), ...(a.threadId != null ? { threadId: a.threadId } : {}),
          attachment: { id: '', kind: a.kind ?? (photo ? 'photo' : 'file'), mime: a.mime, name: a.name, size: a.file.size, w: sized ? a.w ?? null : null, h: sized ? a.h ?? null : null, thumb: a.thumb ?? null,
            ...(a.kind ? { duration: a.duration ?? null, waveform: a.waveform ?? null } : {}),
            ...(a.kind === 'audio' ? { title: a.title ?? null, performer: a.performer ?? null } : {}),
            ...(a.spoiler && (photo || a.kind === 'video') ? { spoiler: true } : {}) } });
        this.store.setDraft(a.chatId, '');
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        return { clientId };
      }
      case 'forwardMessages': {
        // в каждый чат: подпись (если есть), затем копии по порядку — сразу в ленте «отправляется», дальше как send;
        // альбом остаётся альбомом: у копий одной группы — общий новый groupId (свой в каждом чате)
        const srcs = a.ids.map((id) => this.store.messageById(a.fromChatId, id)).filter((m): m is LocalMessage => !!m && m.id != null && !m.deleted && !m.service);
        const clientIds: string[] = [];
        const queue = (o: Omit<OutboxEntry, 'clientId' | 'createdAt' | 'failed'>) => {
          const clientId = crypto.randomUUID();
          this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
          this.store.addPending({ ...o, clientId, createdAt: this.lastCreated, failed: false });
          clientIds.push(clientId);
        };
        // ответ — у первого сообщения (подписи или первой копии), и только у копии в один чат
        let reply = a.hideSender && a.toChatIds.length === 1 ? a.replyToId ?? null : null;
        const takeReply = () => { const r = reply; reply = null; return r; };
        for (const chatId of a.toChatIds) {
          const comment = a.comment?.body.trim() ? a.comment : null;
          if (comment) queue({ chatId, body: comment.body, entities: comment.entities ?? [], replyToId: takeReply() });
          const groups = new Map<string, string>();
          for (const m of srcs) {
            const dropCaption = !!a.hideCaption && !!m.attachment;
            // пересылка поста — от имени канала (как покажет сервер): автора-админа нет
            const fwdFrom = a.hideSender ? null : m.fwdFrom ?? (m.post
              ? { userId: null, name: this.titleOfChat(a.fromChatId) ?? '', chatId: a.fromChatId, messageId: m.id!, at: m.createdAt, ...(m.postAuthor ? { postAuthor: m.postAuthor } : {}) }
              : { userId: m.senderId, name: this.nameOf(m.senderId), chatId: a.fromChatId, messageId: m.id!, at: m.createdAt });
            let groupId: string | null = null;
            if (m.groupId && m.attachment) { groupId = groups.get(m.groupId) ?? crypto.randomUUID(); groups.set(m.groupId, groupId); }
            queue({ chatId, body: dropCaption ? '' : m.body, entities: dropCaption ? [] : m.entities ?? [], replyToId: takeReply(), attachment: m.attachment ?? null,
              ...(groupId ? { groupId } : {}), forward: { chatId: a.fromChatId, id: m.id!, ...(a.hideSender ? { hideSender: true } : {}), ...(a.hideCaption ? { hideCaption: true } : {}) }, fwdFrom });
          }
          if (comment) this.store.setDraft(chatId, '');
        }
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        return { clientIds };
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
      case 'setLinks':
        await this.ops.enqueue({ key: OP_LINKS, method: 'PATCH', path: '/me', body: { links: a.links } });
        return null;
      case 'setUsername':
        await this.ops.enqueue({ key: OP_USERNAME, method: 'PUT', path: '/me/username', body: { username: a.username } });
        return null;
      case 'refreshProfilePhotos':
        this.lists.refreshPhotos(this.cfg.userId);
        return null;
      case 'refreshSettings':
        if (this.online && this.ready) this.fetchSettings();
        return null;
      case 'setMute':
        await this.ops.enqueue({ key: muteKey(a.chatId), method: 'PUT', path: `/chats/${a.chatId}/notify`, body: { muteUntil: a.muteUntil } });
        return null;
      case 'setChatFlags': {
        // в очередь — полное желаемое значение (слитые правки одного чата не теряют соседний флаг); at — время закрепления
        // для места в списке до ответа сервера (сервер поле не читает)
        const c = this.store.chats.get(a.chatId);
        if (!c) return null;
        const cur = flagsOf(c, flagsOverlay(this.ops.list).get(a.chatId));
        const archived = a.archived ?? cur.archived;
        const pinned = a.pinned ?? (archived === cur.archived && cur.pinnedAt != null);   // в другой список закрепление не переезжает
        await this.ops.enqueue({ key: flagsKey(a.chatId), method: 'PUT', path: `/chats/${a.chatId}/flags`, body: { pinned, archived, unreadMark: a.unreadMark ?? cur.unreadMark, at: Date.now() } });
        return null;
      }
      case 'setNotify': {
        // в очередь уходит полное значение вида чата: слитые правки одного ключа не теряют соседнее поле
        const cur = settingsView(this.store.settings.base, this.ops.list).notify[a.notifyType];
        const body = { muted: a.muted ?? cur.muted, preview: a.preview ?? cur.preview };
        await this.ops.enqueue({ key: notifyKey(a.notifyType), method: 'PUT', path: `/settings/notify/${a.notifyType}`, body });
        return null;
      }
      case 'setPrivacy': {
        // правило целиком: тело схлопывается с прежней неотправленной правкой этого же правила
        const body = normalizeRule(a.key, { mode: a.mode, allow: a.allow ?? [], deny: a.deny ?? [] });
        if (a.key === 'phoneDiscovery') { body.allow = []; body.deny = []; }
        await this.ops.enqueue({ key: privacyKey(a.key), method: 'PUT', path: `/privacy/${a.key}`, body });
        return null;
      }
      case 'block':
      case 'unblock':
        return this.blocks.act(a);
      case 'addProfileMusic': {
        // трек известен по сообщению в кэше — строка видна сразу (ключ по файлу: добавление и удаление схлопываются);
        // нет — просто в очередь, список обновит ответ
        const track = trackOf(this.store, a.chatId, a.messageId);
        const key = track ? musicKey(track.id) : musicKey(`m${a.chatId}:${a.messageId}`);
        await this.ops.enqueue({ key, method: 'POST', path: '/me/music', body: { chatId: a.chatId, messageId: a.messageId, ...(track ? { track } : {}) } });
        return { optimistic: !!track };   // нет трека в кэше — строки пока нет, интерфейс не обещает «добавлено»
      }
      case 'removeProfileMusic':
        await this.ops.enqueue({ key: musicKey(a.attId), method: 'DELETE', path: `/me/music/${encodeURIComponent(a.attId)}` });
        return null;
      case 'sendSticker': {
        const clientId = crypto.randomUUID();
        this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
        this.store.addPending({ clientId, chatId: a.chatId, body: '', entities: [], replyToId: a.replyToId ?? null, createdAt: this.lastCreated, failed: false, sticker: a.sticker, ...(a.threadId != null ? { threadId: a.threadId } : {}) });
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        void this.stickers.bumpRecent(a.sticker);
        return { clientId };
      }
      case 'myStickers':
      case 'stickerSet':
      case 'installStickerSet':
      case 'faveSticker':
      case 'clearRecentStickers':
      case 'featuredStickerSets':
      case 'searchStickerSets':
      case 'stickersByEmoji':
      case 'greetingSticker':
        return this.stickers.act(a);
      case 'listSessions':
      case 'terminateSession':
      case 'terminateOtherSessions':
      case 'confirmSession':
        return this.sessions.act(a);
      case 'setSessionsTtl':
        await this.ops.enqueue({ key: OP_SESSIONS_TTL, method: 'PUT', path: '/settings/sessions-ttl', body: { days: a.days } });
        return null;
      case 'saveFolder': {
        const { id, ...body } = a.folder;
        await this.ops.enqueue({ key: folderKey(id), method: 'PUT', path: `/settings/folders/${id}`, body });
        return null;
      }
      case 'deleteFolder':
        await this.ops.enqueue({ key: folderKey(a.id), method: 'DELETE', path: `/settings/folders/${a.id}` });
        return null;
      case 'reorderFolders':
        await this.ops.enqueue({ key: OP_FOLDERS_ORDER, method: 'PUT', path: '/settings/folders/order', body: { ids: a.ids } });
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
      case 'discard': {
        if (this.uploads.has(a.clientId)) { this.cancelled.add(a.clientId); this.uploads.get(a.clientId)!.abort(); }
        // загрузка частями: части на сервере выбросить сразу, а не через сутки
        const up = this.store.outbox.get(a.clientId)?.upload;
        if (up) this.dev.fetch(`${this.cfg.httpBase}/uploads/${up.id}`, { method: 'DELETE', credentials: 'include', headers: { ...(this.cfg.headers ?? {}) } }).catch(() => {});
        const ids = this.store.discard([a.clientId]);
        await this.store.flush();
        if (ids.length) await write(this.db, { put: {}, del: { messages: ids } }).catch(() => {});
        this.memBlobs.delete(a.clientId);
        delBlob(this.db, a.clientId).catch(() => {});
        this.changed();
        this.pumpOutbox();   // загруженные файлы этого чата, ждавшие отменённый, теперь могут уйти
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
    this.transport.send({ op: 'hello', lastSeq: this.store.lastSeq, since: this.store.since });
  }

  private onClose(): void {
    const wasOpen = this.online;
    this.online = false;
    this.holding = false;
    this.presence.clear();            // без связи не знаем, кто в сети
    this.presenceDirty = true;
    this.presenceFetched = false;
    this.forgetAsked();   // новое подключение — журнал мог потеряться (tooLong): спросим заново
    if (this.wantOnline) this.failures++;
    this.ready = false;
    this.changed();
    const offline: ReqError = { code: 'offline', retry: true };
    this.syncWaiter?.reject(offline);
    this.syncWaiter = null;
    for (const p of this.pending.values()) p.reject(offline);
    this.pending.clear();
    for (const k of this.watchingThreads) { const [c, t] = k.split(':').map(Number); this.store.guestWatch(c, t, false); }
    this.watchingThreads.clear(); this.refusedThreads.clear();   // подписки на треды гостя — у сокета: новое подключение подпишется заново
    for (const w of this.chatWaiters.values()) w.reject(offline);
    this.chatWaiters.clear();
    for (const st of this.chatSync.values()) { if (st.gapTimer) clearTimeout(st.gapTimer); st.gapTimer = null; st.buffer.clear(); st.again = false; st.queued = false; }
    this.chatQueue = []; this.sinceCandidate = null;   // chatActive обнулят finally своих догонок
    if (!wasOpen && this.wantOnline) this.session.probe();
  }

  /**
   * «Уже спрашивали» — забыть (новое подключение, сброс кэша, смена поколения базы): люди, участники открытых
   * подписок, вкладки медиа и списки профиля спросятся снова. Без этого после очистки кэша подписка осталась бы пустой.
   */
  private forgetAsked(): void {
    this.usersAsked.clear();
    this.membersAsked.clear();
    for (const w of this.watchers.values()) if (w.q.kind === 'members') this.membersWants.add(w.q.chatId);
    this.media.reconnect();
    this.lists.reconnect();
  }

  private onFrame(f: ServerFrame): void {
    switch (f.op) {
      case 'hello':
        if (this.resetting) { this.skipped.hello = f; return; }   // resetLocal пошлёт свой hello сама, а при отказе проиграет этот
        this.dev.counters.serverSeq = f.seq;
        this.holding = true;
        // переподключение: пока связи не было, sessionsChanged мог уйти мимо (снимок его не несёт) — интерфейс
        // перечитывает сеансы (плашка «Это вы?»); первое подключение не считаем — там интерфейс грузит список сам
        if (this.hellos++ > 0) { this.store.sessionsRev++; this.store.stickersRev++; this.changed(); }
        this.run(async () => {
          // другое поколение базы (сервер пересоздан): старый кэш недействителен целиком
          if (this.store.epoch && f.epoch && this.store.epoch !== f.epoch) { this.dev.log.record('engine', 'epochWipe', { from: this.store.epoch, to: f.epoch }); await this.store.wipe(f.epoch); this.clearAllChatState(); this.ops.forget(); this.forgetAsked(); this.changed(); }
          else if (!this.store.epoch && f.epoch) { this.store.epoch = f.epoch; this.store.markMeta(); }
          // снимок — только когда кэш пуст; lastSeq = 0 бывает и у заполненного кэша (журнал пользователя ещё пуст)
          this.fetchMe();
          this.fetchSettings();
          this.contacts.fetch();
          this.blocks.fetch();
          if (!this.store.hydrated) await this.bootstrap(f.seq);
          else this.runSync();
          this.onChatsList(f.chats ?? [], f.now);
          for (const id of this.watched) this.run(() => this.watchPreview(id));   // новый сокет: превью снова на push'ах канала
        });
        return;
      case 'chats':
        this.onChatsList(f.items, f.now);
        return;
      case 'chatUpdates':
      case 'chatTooLong':
      case 'chatGone': {
        const w = this.chatWaiters.get(f.reqId);
        if (w && w.chatId === f.chatId) w.resolve(f);
        return;
      }
      case 'updates':
      case 'tooLong': {
        const w = this.syncWaiter;
        if (w && f.op === 'updates' && f.from !== w.since) return;   // ответ на прежний запрос (повторён по таймауту) — не наш
        this.dev.counters.serverSeq = Math.max(this.dev.counters.serverSeq ?? 0, f.op === 'updates' ? f.to : f.seq);
        this.syncWaiter = null;
        w?.resolve(f);
        return;
      }
      case 'ack':
      case 'err': {
        const id = f.reqId;
        if (!id) return;
        if (f.op === 'err') { const cw = this.chatWaiters.get(id); if (cw) { cw.reject({ code: f.code, retry: f.retry }); return; } }
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (f.op === 'ack') p.resolve(f.result);
        else p.reject({ code: f.code, retry: f.retry });
        return;
      }
      case 'poke':
        if (this.resetting) this.skipped.poke = true;
        this.runSync();
        return;
      case 'threadPush': {
        // тред гостя (не участник группы): живые события без журнала; пустой кадр — перечитать край треда
        if (!this.store.isGuest(f.chatId) || !this.watchingThreads.has(f.chatId + ':' + f.threadId)) return;
        if (!f.items.length) { this.run(() => this.catchUpThread(f.chatId, f.threadId)); return; }
        this.store.applyGuestPush(f.chatId, f.items);
        this.run(async () => { await this.store.flush(); this.changed(); });   // пост канала мог получить кнопку (копия) — это пишется
        return;
      }
      case 'push':
        if (f.chatId != null) { this.onChatPush(f as ChatPush); return; }   // журнал чата — свои правила
        // событие пришло вместе с «пинком»: применяем без sync, если оно ровно следующее и мы ничего не догоняем;
        // иначе — обычная синхронизация (она принесёт и его)
        if (this.resetting) { this.skipped.poke = true; return; }
        if (!this.ready || this.syncing || this.syncWaiter || f.from !== this.store.lastSeq || !this.online) { this.runSync(); return; }
        this.run(() => this.applyPush(f));
        return;
      case 'typing': {
        // группа шлёт в топик чата всем, включая автора и тех, кто его заблокировал, — отсеиваем здесь
        if (f.userId === this.cfg.userId || this.store.blocks.table.get(f.userId)) return;
        if (this.store.chats.get(f.chatId)?.kind === 'channel') return;   // в канале «печатает…» не показывается
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
      case 'challenge':
        // сеанс привязан к устройству: сокет выполнит кадры (они ждут на сервере) после подписи вызова
        void signDevice('ws', f.nonce).then((sig) => this.transport.send({ op: 'prove', sig }), () => this.transport.drop());
        return;
      case 'sessionTerminated':
        this.session.end(f.reason === 'logout' ? 'logout' : 'terminated');
        return;
      case 'pong':
        return;
    }
  }

  /** Первый вход или tooLong: hello дал seq S → снимок → lastSeq = S → догоняем от S. */
  private async bootstrap(seq: number): Promise<void> {
    if (this.resetting) return;
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

  /** Запись журнала из push: как шаг syncLoop, под тем же флагом syncing (параллельной догонки нет). */
  private async applyPush(f: Extract<ServerFrame, { op: 'push' }>): Promise<void> {
    if (this.syncing || this.resetting || f.from !== this.store.lastSeq) { this.runSync(); return; }
    this.syncing = true;
    try {
      for (const chatId of patchedChats(f.items, this.store.lastSeq)) await this.store.loadChatMessages(chatId);
      for (const it of f.items) {
        if (it.seq <= this.store.lastSeq) continue;
        this.store.applyUpdate(it.update, it.seq);
        this.store.lastSeq = it.seq;
      }
      await this.store.flush();
      this.dev.counters.serverSeq = Math.max(this.dev.counters.serverSeq ?? 0, f.to);
      this.dev.counters.pushed = (this.dev.counters.pushed ?? 0) + 1;
      this.changed();
    } finally {
      this.syncing = false;
    }
    if (this.syncAgain) { this.runSync(); return; }
    // как после догонки: чат, известный только по сообщению, — имя с сервера; открытые чаты, люди и участники, которых не хватает
    if (this.store.unnamed().length) this.refreshList();
    this.loadOpenChats();
    this.fetchUsers();
    this.fetchMembers();
  }


  // =====================================================================
  // Журнал чата (группы, каналы)
  // =====================================================================
  //
  // У каждой группы свой журнал (chat_seq): событие — одна запись, всем участникам один и тот же push
  // {chatId, from, to, items}. Клиент держит store.chatSeq[chatId] — номер, до которого применил, — и правила:
  //  • push с from === номер применяется сразу, открыт чат или нет (строка списка и кэш ленты двигаются);
  //  • from > номер — уведомления разных транзакций могут прийти не по порядку: кадр ждёт в буфере chatGapMs,
  //    недостающий пришёл — применяется цепочка, нет — syncChat;
  //  • пустые items (события не влезли в уведомление) или push во время догонки — буфер/syncChat;
  //  • чат незнаком — строку подтягивает refreshRows (она несёт seq), после этого push применяются;
  //  • hello {since} и chatsSince возвращают группы, менявшиеся после since: открытые и верхние в списке
  //    догоняются сразу, остальные — тем же механизмом в фоне, не больше 4 одновременно;
  //  • chatTooLong — сброс только этого чата (resetChat), chatGone — чат удалён; ничего из этого не трогает
  //    личный журнал и другие чаты.
  // since записывается, только когда личная догонка и все syncChat закончились: обрыв посреди догонки не
  // уводит его вперёд (отставшие чаты не потеряются).

  private chatState(chatId: number): ChatSyncState {
    let st = this.chatSync.get(chatId);
    if (!st) this.chatSync.set(chatId, (st = { syncing: false, again: false, queued: false, buffer: new Map(), gapTimer: null }));
    return st;
  }

  private clearAllChatState(): void {
    for (const st of this.chatSync.values()) if (st.gapTimer) clearTimeout(st.gapTimer);
    this.chatSync.clear();
    this.chatQueue = [];
    this.refreshIds.clear();
    this.unknownAsked.clear();
    this.sinceCandidate = null;
  }

  private isOpenChat(chatId: number): boolean {
    for (const w of this.watchers.values()) if (w.q.kind === 'messages' && w.q.chatId === chatId) return true;
    return false;
  }

  /** Верхние группы списка — их догоняем сразу, остальные в фоне. */
  private topGroupChats(n = 20): Set<number> {
    return new Set([...this.store.chats.values()].filter((c) => c.kind !== 'direct' && !this.store.previews.has(c.id)).sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, n).map((c) => c.id));
  }

  /** Ответ hello / chats: какие группы менялись после since. now — кандидат в следующий since. */
  private onChatsList(items: [number, number][], now: number): void {
    if (typeof now === 'number' && now > 0) this.sinceCandidate = Math.max(this.sinceCandidate ?? 0, now);
    const top = this.topGroupChats();
    for (const [chatId, seq] of items) {
      const local = this.store.chatSeq.get(chatId);
      if (local == null) { this.askUnknownChat(chatId); continue; }
      if (seq > local) this.scheduleChatSync(chatId, this.isOpenChat(chatId) || top.has(chatId));
    }
    this.commitSince();
  }

  /** Чат, о котором сокет знает, а кэш нет (вне загруженных страниц, вступили без строки): его строку — не чаще раза в 10 с. */
  private askUnknownChat(chatId: number): void {
    const at = this.unknownAsked.get(chatId) ?? 0;
    if (Date.now() - at < 10_000) return;
    this.unknownAsked.set(chatId, Date.now());
    this.refreshRows([chatId]);
  }

  private onChatPush(f: ChatPush): void {
    if (this.resetting || !this.online) return;
    if (f.gone) { this.run(() => this.onChatDeleted(f.chatId)); return; }
    const local = this.store.chatSeq.get(f.chatId);
    if (local == null) { this.askUnknownChat(f.chatId); return; }
    const st = this.chatState(f.chatId);
    if (st.syncing) { this.bufferPush(st, f); return; }
    if (!f.items.length) { this.scheduleChatSync(f.chatId, this.isOpenChat(f.chatId)); return; }
    if (f.from === local) {
      st.syncing = true;
      this.run(async () => {
        let gap = false;
        try { await this.applyChatItems(f.chatId, f.items, f.to); gap = await this.drainChatBuffer(f.chatId); }
        finally { st.syncing = false; }
        if (gap) this.scheduleChatSync(f.chatId, this.isOpenChat(f.chatId));
        else if (st.again) { st.again = false; this.scheduleChatSync(f.chatId, this.isOpenChat(f.chatId)); }
      });
      return;
    }
    if (f.from > local) { this.bufferPush(st, f); this.startGapTimer(f.chatId); }
    // from < local — повтор уже применённого
  }

  /** Кадр push с gone: чат удалён. Убираем у себя сразу, без syncChat (на большом канале — ни одного чтения журнала). */
  private async onChatDeleted(chatId: number): Promise<void> {
    this.dev.log.record('engine', 'chatGone', { chatId });
    if (this.store.previews.has(chatId)) { await this.forgetPreview(chatId, false); return; }
    const st = this.chatSync.get(chatId);
    if (st?.gapTimer) clearTimeout(st.gapTimer);
    this.chatSync.delete(chatId);
    this.store.removeChat(chatId);
    await this.store.flush();
    this.changed();
  }

  private bufferPush(st: ChatSyncState, f: ChatPush): void {
    if (st.buffer.size >= 200) { st.buffer.clear(); this.scheduleChatSync(f.chatId, true); return; }
    st.buffer.set(f.from, f);
  }

  private startGapTimer(chatId: number): void {
    const st = this.chatState(chatId);
    if (st.gapTimer) return;
    st.gapTimer = setTimeout(() => {
      st.gapTimer = null;
      if (st.buffer.size && !st.syncing) { this.dev.log.record('engine', 'chatGap', { chatId }); this.scheduleChatSync(chatId, this.isOpenChat(chatId)); }
    }, this.cfg.chatGapMs ?? 700);
  }

  /** Применить подряд идущие кадры из буфера; true — в буфере осталась дыра (нужен syncChat). Вызывать под st.syncing. */
  private async drainChatBuffer(chatId: number): Promise<boolean> {
    const st = this.chatState(chatId);
    for (;;) {
      const local = this.store.chatSeq.get(chatId);
      if (local == null) { st.buffer.clear(); return false; }
      for (const k of [...st.buffer.keys()]) if (k < local) st.buffer.delete(k);
      const next = st.buffer.get(local);
      if (!next) { const gap = st.buffer.size > 0; if (!gap && st.gapTimer) { clearTimeout(st.gapTimer); st.gapTimer = null; } return gap; }
      st.buffer.delete(local);
      if (!next.items.length) { st.buffer.clear(); return true; }
      await this.applyChatItems(chatId, next.items, next.to);
    }
  }

  private scheduleChatSync(chatId: number, urgent: boolean): void {
    const st = this.chatState(chatId);
    if (st.syncing) { st.again = true; return; }
    if (st.queued) { if (urgent) this.chatQueue = [chatId, ...this.chatQueue.filter((id) => id !== chatId)]; return; }
    st.queued = true;
    if (urgent) this.chatQueue.unshift(chatId); else this.chatQueue.push(chatId);
    this.pumpChatQueue();
  }

  private pumpChatQueue(): void {
    while (this.chatActive < 4 && this.chatQueue.length && this.online && !this.resetting) {
      const chatId = this.chatQueue.shift()!;
      const st = this.chatState(chatId);
      st.queued = false;
      if (st.syncing) { st.again = true; continue; }
      st.syncing = true;
      this.chatActive++;
      this.run(() => this.runSyncChat(chatId).finally(() => {
        st.syncing = false;
        this.chatActive = Math.max(0, this.chatActive - 1);
        this.pumpChatQueue();
        this.commitSince();
      }));
    }
  }

  private async runSyncChat(chatId: number): Promise<void> {
    const st = this.chatState(chatId);
    for (let round = 0; round < 50 && this.online; round++) {
      st.again = false;
      let more = true;
      while (more && this.online) {
        const since = this.store.chatSeq.get(chatId);
        if (since == null) return;
        let f: ChatReply;
        try { f = await this.requestSyncChat(chatId, since); } catch { return; }   // таймаут или обрыв: следующий push или сверка догонят
        if (f.op === 'chatGone') {
          this.dev.log.record('engine', 'chatGone', { chatId });
          if (this.store.previews.has(chatId)) { st.buffer.clear(); await this.forgetPreview(chatId); return; }   // превью удалённого канала: и сокет отписать
          this.store.removeChat(chatId);
          st.buffer.clear();
          await this.store.flush();
          this.changed();
          return;
        }
        if (f.op === 'chatTooLong') {
          // журнал чата подрезан дальше, чем мы знаем: лента этого чата заново, остальное приложение не трогаем
          this.dev.log.record('engine', 'chatTooLong', { chatId, seq: f.seq });
          await this.store.resetChat(chatId);
          this.store.setChatSeq(chatId, f.seq);
          st.buffer.clear();
          await this.store.flush();
          for (const w of this.watchers.values()) if (w.q.kind === 'messages' && w.q.chatId === chatId) { const q = w.q; this.run(() => this.ensureWindow(q)); }
          this.changed();
          return;
        }
        await this.applyChatItems(chatId, f.items, f.to);
        more = f.more;
      }
      const gap = await this.drainChatBuffer(chatId);
      if (!gap && !st.again) break;
    }
  }

  private requestSyncChat(chatId: number, since: number): Promise<ChatReply> {
    return new Promise((resolve, reject) => {
      const reqId = 'c' + ++this.reqSeq;
      let tries = 0, stop = () => {};
      const w = {
        chatId,
        resolve: (f: ChatReply) => { stop(); this.chatWaiters.delete(reqId); resolve(f); },
        reject: (e: ReqError) => { stop(); this.chatWaiters.delete(reqId); reject(e); },
      };
      this.chatWaiters.set(reqId, w);
      const send = () => this.transport.send({ op: 'syncChat', reqId, chatId, since });
      // dev: имитатор потерял кадр — тот же запрос ещё раз; после трёх раз сдаёмся без обрыва сокета (его живость держит ping)
      const resend = () => {
        if (!this.chatWaiters.has(reqId)) return;
        this.dev.log.record('engine', 'syncChatTimeout', { chatId, since, tries: ++tries });
        if (tries >= 3 || !send()) { w.reject({ code: 'offline', retry: true }); return; }
        stop = watchLoss(this.dev.sim, this.cfg.syncTimeoutMs ?? 5000, resend);
      };
      if (!send()) { w.reject({ code: 'offline', retry: true }); return; }
      stop = watchLoss(this.dev.sim, this.cfg.syncTimeoutMs ?? 5000, resend);
    });
  }

  /** Записи журнала чата → стор; номер чата = to. Скрытая история (вступил позже) — события по старым сообщениям мимо. */
  private async applyChatItems(chatId: number, items: JournalEntry[], to: number): Promise<void> {
    const local = this.store.chatSeq.get(chatId);
    if (local == null) return;
    const chat = this.store.chats.get(chatId);
    const historyFrom = chat?.me?.historyFrom ?? 0;
    // правка/удаление/реакция меняют сообщение на месте: закрытый чат сначала читаем из кэша, иначе правка потеряется
    for (const id of patchedChats(items, local)) await this.store.loadChatMessages(id);
    for (const it of items) {
      if (it.seq <= local) continue;
      const u = it.update;
      const mid = u.type === 'newMessage' ? u.message.id : u.type !== 'pins' && 'id' in u && typeof (u as { id?: unknown }).id === 'number' ? (u as { id: number }).id : null;
      if (mid != null && historyFrom && mid < historyFrom) continue;
      if (u.type === 'newMessage' && chat) this.maybeUnarchive(chat, u.message);
      this.store.applyUpdate(u, it.seq);
    }
    this.store.setChatSeq(chatId, Math.max(local, to));
    this.dev.counters.pushed = (this.dev.counters.pushed ?? 0) + 1;
    await this.store.flush();   // данные и номер чата — одной транзакцией
    this.changed();
    if (this.store.unnamed().length) this.refreshList();
    this.fetchUsers();
    this.fetchMembers();
  }

  /**
   * Сообщение в архивную незаглушённую группу: как в Telegram, чат возвращается из архива — условной операцией
   * сервера (он сверит с границей archived_at_id: повтор старых событий архив не снимет). Пока операция в очереди,
   * чат показан вне архива оверлеем (flagsOverlay); ручная операция флагов в очереди побеждает.
   */
  private maybeUnarchive(chat: LocalChat, m: Message): void {
    if (chat.kind === 'direct' || !chat.archived || m.senderId === this.cfg.userId) return;
    const mute = chat.muteUntil;
    if (mute === 0 || (mute != null && mute > Date.now())) return;
    if (m.id <= (chat.archivedAtId ?? 0)) return;
    if (this.ops.list.some((o) => o.key === flagsKey(chat.id))) return;
    void this.ops.enqueue({ key: 'unarchive:' + chat.id, method: 'POST', path: `/chats/${chat.id}/unarchive`, body: { messageId: m.id } });
  }

  // =====================================================================
  // Превью канала (публичный канал без подписки)
  // =====================================================================
  //
  // Как в Telegram: публичный канал (с @именем) открывается и без подписки — лента только для чтения. Строка с
  // сервера (GET /groups/:id) ложится в стор как превью (store.previews): лента, отрезки и журнал чата работают как
  // у обычного канала, но строки в списке нет и в IndexedDB ничего не пишется. Новые посты — push'ами канала:
  // сокет подписан на него кадром watchChat, пока превью открыто (после переподключения — заново); ответ несёт seq
  // канала — что прошло мимо, догоняет syncChat. Просмотры, прочтение и реакции у превью не уходят. Вступил —
  // membership из личного журнала превращает превью в обычный чат (store.promote) без перезагрузки ленты.

  private async openPreview(chatId: number): Promise<{ member: boolean; requested: boolean } | { error: string }> {
    let res: Response;
    try { res = await this.dev.fetch(`${this.cfg.httpBase}/groups/${chatId}`, { credentials: 'include', headers: this.cfg.headers }); }
    catch { return { error: 'offline' }; }
    if (this.session.unauthorized(res.status)) return { error: 'offline' };
    const data = await res.json().catch(() => null) as { member?: boolean; requested?: boolean; chat?: ChatSummary; code?: string } | null;
    if (!res.ok || !data?.chat) return { error: data?.code ?? 'internal' };
    if (data.member) {
      // уже подписан: обычная строка списка (могла не попасть в загруженные страницы)
      this.store.applyChats([data.chat], this.store.lastSeq);
    } else if (!this.store.chats.has(chatId) || this.store.previews.has(chatId)) {
      const again = this.watched.has(chatId);   // уже смотрим (повторное открытие, заявка подана) — только строка
      this.store.applyPreview(data.chat, !!data.requested);
      if (!again && this.online) {
        // подписка на push'и — до ответа: отказ (превью в других вкладках исчерпали предел) интерфейс покажет сразу
        const err = await this.watchPreview(chatId);
        if (err) return { error: err };
      }
    }
    await this.store.flush();
    this.changed();
    return { member: !!data.member, requested: !!data.requested };
  }

  /**
   * watchChat: push'и канала в этот сокет; seq сервера впереди нашего — догнать журнал. Отказ — код ошибки, и превью
   * закрывается: канал удалили или сделали приватным (not_found / not_member) или открыто слишком много превью
   * (flood) — без push'ей лента молча устарела бы. Обрыв связи — null: после hello подпишемся снова.
   */
  private async watchPreview(chatId: number): Promise<string | null> {
    if (!this.store.previews.has(chatId)) { this.watched.delete(chatId); return null; }
    this.watched.add(chatId);
    if (!this.online) return null;
    let r: Record<string, unknown>;
    try { r = await this.request({ op: 'watchChat', reqId: '', chatId }); }
    catch (e) {
      const code = (e as ReqError).code;
      if (code === 'offline' || (e as ReqError).retry) return null;
      await this.forgetPreview(chatId, false);
      return code;
    }
    const local = this.store.chatSeq.get(chatId);
    if (typeof r.seq === 'number' && local != null && r.seq > local) this.scheduleChatSync(chatId, true);
    return null;
  }

  /** Превью больше не нужно (закрыто, канал удалён, отказ): отписать сокет (освободить место из WATCH_MAX) и забыть. */
  private async forgetPreview(chatId: number, unwatch = true): Promise<void> {
    this.watched.delete(chatId);
    if (unwatch && this.online) this.transport.send({ op: 'unwatchChat', chatId });
    if (!this.store.previews.has(chatId)) return;
    const st = this.chatSync.get(chatId);
    if (st?.gapTimer) clearTimeout(st.gapTimer);
    this.chatSync.delete(chatId);
    this.store.dropPreview(chatId);
    await this.store.flush();
    this.changed();
  }

  /** Превью закрыли (лента ушла со стека): сокет отписывается; не вступил — превью забывается целиком. */
  private async closePreview(chatId: number): Promise<null> {
    if (!this.watched.has(chatId)) return null;
    for (const w of this.watchers.values()) if ((w.q.kind === 'messages' || w.q.kind === 'media') && w.q.chatId === chatId) return null;   // ещё открыто (другая вкладка)
    if (this.store.previews.has(chatId)) await this.forgetPreview(chatId);
    else { this.watched.delete(chatId); if (this.online) this.transport.send({ op: 'unwatchChat', chatId }); }   // подписался: сокет и так на канале
    return null;
  }

  /** Строки списка по id пачкой (не чаще раза в 300 мс, один запрос в полёте): незнакомые чаты, вступление. */
  private refreshRows(ids: number[]): void {
    for (const id of ids) this.refreshIds.add(id);
    if (this.refreshTimer || !this.online) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.runRefreshRows(); }, 300);
  }

  private runRefreshRows(): void {
    if (this.rowsInFlight || !this.refreshIds.size || !this.online || !this.store.hydrated) return;
    // идёт догонка журнала: строка, снятая посреди неё, уже учла события, которые догонка ещё применит (unread
    // уменьшился бы дважды) — после догонки
    if (this.syncing || this.chatActive) { this.refreshRows([]); return; }
    const ids = [...this.refreshIds].slice(0, 500);
    for (const id of ids) this.refreshIds.delete(id);
    this.rowsInFlight = true;
    this.run(async () => {
      try {
        const seq = this.store.lastSeq;
        const list = await this.http<ChatSummary[]>(`/chats?ids=${ids.join(',')}`);
        this.store.applyChats(list, seq);   // строка старее применённых push'ей отбрасывается в applyChats
        await this.store.flush();
        this.changed();
      } finally {
        this.rowsInFlight = false;
        if (this.refreshIds.size) this.refreshRows([]);
      }
    });
  }

  /** Подсказки стора после applyChats/membership: новый чат — его строку; журнал чата впереди — догнать. */
  private handleSeqHints(): void {
    if (!this.store.seqHints.size) return;
    const hints = [...this.store.seqHints];
    this.store.seqHints.clear();
    const top = this.topGroupChats();
    for (const [chatId, h] of hints) {
      if (h === 'new') this.refreshRows([chatId]);
      else if (this.online) this.scheduleChatSync(chatId, this.isOpenChat(chatId) || top.has(chatId));
    }
  }

  /** since (время сервера из hello/chats) записывается, когда личная догонка и все syncChat закончились. */
  private commitSince(): void {
    if (this.sinceCandidate == null || this.syncing || this.chatActive || this.chatQueue.length || !this.online || !this.ready) return;
    const v = this.sinceCandidate;
    this.sinceCandidate = null;
    this.store.setSince(v);
    this.run(() => this.store.flush());
  }

  private runSync(): void {
    if (this.resetting) return;
    if (this.syncing) { this.syncAgain = true; return; }
    this.run(() => this.syncLoop());
  }

  private async syncLoop(): Promise<void> {
    if (this.resetting) return;
    if (this.syncing) { this.syncAgain = true; return; }
    this.syncing = true;
    // последнее из снимка, известное до догонки: журнал обязан его доставить, иначе — дыра (settleSnapshots)
    const snaps = this.store.pendingSnapshots();
    let caughtUp = false;
    try {
      do {
        this.syncAgain = false;
        let more = true;
        while (more && this.online) {
          const f = await this.requestSync(this.store.lastSeq);
          // защита: пустая пачка с more от сервера означает дыру — лечим снимком
          const gap = f.op === 'updates' && f.more && f.items.length === 0;
          if (f.op === 'tooLong' || gap) {
            this.dev.counters.tooLongCount++;
            this.dev.log.record('engine', 'snapshot', { reason: gap ? 'gap' : 'tooLong' });
            this.store.resetForSnapshot();
            this.store.resetDialogs();
            this.contacts.fetch();
            this.blocks.fetch();
            this.fetchSettings();
            this.store.stickersRev++;
            this.store.sessionsRev++;   // снимок пропустил записи журнала, в т.ч. sessionsChanged — список сеансов заново
            await this.loadFirstDialogs();
            this.store.lastSeq = f.op === 'tooLong' ? f.seq : f.to;
            await this.store.flush();
            this.changed();
            if (gap) break; // seq сервера неизвестен — не крутимся, ждём следующего poke
            continue;
          }
          // правка/удаление/реакция меняют сообщение на месте: чат, не открытый с запуска, сначала читаем из кэша,
          // иначе изменение потеряется, а lastSeq уйдёт дальше — и в кэше навсегда останется старая копия
          for (const chatId of patchedChats(f.items, this.store.lastSeq)) await this.store.loadChatMessages(chatId);
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
      caughtUp = this.online;
    } finally {
      this.syncing = false;
    }
    if (caughtUp && snaps.size) { this.store.settleSnapshots(snaps); await this.store.flush(); }
    if (this.online) {
      this.ready = true;
      this.dev.counters.lastSyncAt = Date.now();
      this.holding = false;   // всё накопленное уйдёт одним патчем
      this.changed();
      this.pumpOutbox();
      this.flushReads();
      this.pushDrafts();
      if (this.store.unnamed().length) this.refreshList();
      this.loadOpenChats();
      if (!this.presenceFetched) this.fetchPresence();
      this.ops.resume();
      if (!this.peersRefreshed) this.refreshPeers();
      this.fetchUsers();
      this.fetchMembers();
      this.commitSince();
    }
  }

  /**
   * Раз за сессию — свежие профили собеседников верхних личных чатов, даже если они уже в кэше. Смену фото или имени
   * присылают по журналу только тем, с кем есть общий чат в тот момент; кто познакомился позже, держал бы старое
   * (фото появлялось лишь при открытии чата). Ответ /users несёт seq сервера — новее старого кэша, журнал не откатывает.
   */
  private refreshPeers(): void {
    this.peersRefreshed = true;
    const top = [...this.store.chats.values()]
      .filter((c) => c.kind === 'direct' && c.peerId != null && !c.system && c.peerId !== this.cfg.userId)
      .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0))
      .slice(0, this.cfg.dialogsPage ?? 100);
    for (const c of top) if (!this.usersAsked.has(c.peerId!)) this.userWants.add(c.peerId!);
  }

  /** Снимок присутствия собеседников — раз на подключение; дальше приходят кадры presence. */
  private fetchPresence(): void {
    this.presenceFetched = true;
    this.run(async () => {
      const list = await this.http<{ userId: number; online: boolean | null; lastSeen: string | null }[]>('/presence');
      if (!this.online) return;
      for (const p of list) if (!this.presence.has(p.userId)) this.presence.set(p.userId, { online: p.online, lastSeen: p.lastSeen }); // живой кадр, пришедший раньше снимка, свежее
      this.presenceDirty = true;
      this.changed();
    });
  }

  /** Первая страница диалогов и все чаты с непрочитанными (папка «Непрочитанные» и её счётчик — полные). */
  private async loadFirstDialogs(): Promise<void> {
    const seq = this.store.lastSeq;   // ответы не старее этой позиции журнала — их собеседники перетирают профиль, записанный раньше
    // закреплённые и архив — целиком сразу: закреплённый может быть старше курсора страниц, а строке «Архив» нужен весь архив
    const [page, unread, pinned, archived] = await Promise.all([
      this.http<{ chats: ChatSummary[]; next: { at: string; id: number } | null; total?: number }>(`/chats/page?limit=${this.cfg.dialogsPage ?? 100}`),
      this.http<ChatSummary[]>('/chats?unread=1'),
      this.http<ChatSummary[]>('/chats?pinned=1'),
      this.http<ChatSummary[]>('/chats?archived=1'),
    ]);
    this.store.applyChats([...page.chats, ...unread, ...pinned, ...archived], seq);
    this.store.setDialogsCursor(page.next, page.total);
  }

  /** Следующая страница диалогов (список докрутили до конца). Один запрос за раз. */
  private loadMoreChats(): Promise<void> {
    if (this.store.dialogsDone || !this.store.hydrated) return Promise.resolve();
    this.moreChats ??= (async () => {
      try {
        const at = new Date(this.store.dialogsAt).toISOString();
        const seq = this.store.lastSeq;
        const page = await this.http<{ chats: ChatSummary[]; next: { at: string; id: number } | null }>(`/chats/page?limit=${this.cfg.dialogsPage ?? 100}&beforeAt=${encodeURIComponent(at)}&beforeId=${this.store.dialogsId}`);
        this.store.applyChats(page.chats, seq);
        this.store.setDialogsCursor(page.next);
        await this.store.flush();
        this.changed();
      } finally {
        this.moreChats = null;
      }
    })();
    return this.moreChats;
  }

  /**
   * Открытый чат, которого нет среди загруженных страниц диалогов (ссылка #chat=N, глубоко в списке): подтянуть
   * только его. Ждём снимка — applyChats на пустом кэше отметил бы его загруженным и сорвал bootstrap; без сети
   * и до снимка догрузит loadOpenChats после синхронизации. Строка в «Все» не всплывает: список показывает
   * только непрерывный диапазон до курсора страниц, а чат старше курсора.
   */
  private ensureOpenChat(chatId: number): Promise<void> {
    const c = this.store.chats.get(chatId);
    if ((c && !Store.unnamed(c)) || !this.store.hydrated || !this.online) return Promise.resolve();
    let p = this.chatLoads.get(chatId);
    if (!p) {
      p = (async () => {
        const seq = this.store.lastSeq;
        const list = await this.http<ChatSummary[]>(`/chats?ids=${chatId}`);
        if (!list.length) return;   // нет доступа или чата нет — шапка останется «Чат №N»
        this.store.applyChats(list, seq);
        await this.store.flush();
        this.changed();
      })().finally(() => this.chatLoads.delete(chatId));
      this.chatLoads.set(chatId, p);
    }
    return p;
  }

  /** После синхронизации: ленты, открытые до снимка или без сети, получают свой чат и историю. */
  private loadOpenChats(): void {
    for (const w of this.watchers.values()) {
      const q = w.q;
      // тред, открытый без сети (перезагрузка с адресом треда): страница не грузилась — гостю строки чата не будет
      if (q.kind === 'thread') { if (!this.store.threadRanges(q.chatId, q.threadId)) this.run(() => this.ensureThreadWindow(q)); continue; }
      if (q.kind !== 'messages') continue;
      const c = this.store.chats.get(q.chatId);
      if (c && !Store.unnamed(c)) continue;
      this.run(() => this.ensureOpenChat(q.chatId).then(() => this.ensureWindow(q)));
    }
  }

  /** Сообщение пришло в чат, которого не было в снимке: подтянуть названия и собеседников. */
  private refreshList(): void {
    if (this.refreshing) return;
    this.refreshing = true;
    this.run(async () => {
      try {
        // чаты, известные только по сообщениям, — точечно по id; иначе (новый чат) — свежая первая страница
        const unnamed = this.store.unnamed();
        const seq = this.store.lastSeq;
        const list = unnamed.length
          ? await this.http<ChatSummary[]>(`/chats?ids=${unnamed.slice(0, 500).join(',')}`)
          : (await this.http<{ chats: ChatSummary[] }>(`/chats/page?limit=${this.cfg.dialogsPage ?? 100}`)).chats;
        this.store.applyChats(list, seq);
        await this.store.flush();
        this.changed();
      } finally {
        this.refreshing = false;
      }
    });
  }

  private requestSync(since: number): Promise<SyncReply> {
    return new Promise((resolve, reject) => {
      // dev: имитатор потерял кадр (потери, «Дыра в журнале») — тот же диапазон ещё раз, после трёх раз — обрыв
      let tries = 0, stop = () => {};
      const resend = () => {
        if (this.syncWaiter !== w) return;
        this.dev.log.record('engine', 'syncTimeout', { since, tries: ++tries });
        if (tries >= 3 || !this.transport.send({ op: 'sync', since })) { this.syncWaiter = null; w.reject({ code: 'offline', retry: true }); this.transport.drop(); return; }
        stop = watchLoss(this.dev.sim, this.cfg.syncTimeoutMs ?? 5000, resend);
      };
      const w = { since, resolve: (f: SyncReply) => { stop(); resolve(f); }, reject: (e: ReqError) => { stop(); reject(e); } };
      this.syncWaiter = w;
      if (!this.transport.send({ op: 'sync', since })) {
        this.syncWaiter = null;
        reject({ code: 'offline', retry: true });
        return;
      }
      stop = watchLoss(this.dev.sim, this.cfg.syncTimeoutMs ?? 5000, resend);
    });
  }

  private request(frame: Extract<ClientFrame, { reqId: string }>): Promise<Record<string, unknown>> {
    const reqId = 'r' + ++this.reqSeq;
    return new Promise((resolve, reject) => {
      // dev: ответ мог потерять имитатор — обрыв, переподключение, очередь уйдёт снова (сервер узнаёт повтор по clientId)
      let stop = () => {};
      this.pending.set(reqId, { resolve: (r) => { stop(); resolve(r); }, reject: (e) => { stop(); reject(e); } });
      if (!this.transport.send({ ...frame, reqId })) {
        this.pending.delete(reqId);
        reject({ code: 'offline', retry: true });
        return;
      }
      stop = watchLoss(this.dev.sim, this.cfg.requestTimeoutMs ?? 15_000, () => {
        if (!this.pending.delete(reqId)) return;
        this.dev.log.record('engine', 'requestTimeout', { op: frame.op, reqId });
        reject({ code: 'offline', retry: true });
        this.transport.drop();
      });
    });
  }

  // =====================================================================
  // Раздел «Для разработчиков»
  // =====================================================================

  /** Снимок без очистки кэша: профиль, настройки, контакты, блок-лист, первая страница диалогов; затем догон журнала. */
  private async resync(): Promise<void> {
    if (!this.online || !this.ready) throw new Error('offline');
    this.fetchMe();
    this.fetchSettings();
    this.contacts.fetch();
    this.blocks.fetch();
    await this.loadFirstDialogs();
    await this.store.flush();
    this.changed();
    this.runSync();
  }

  /** Офлайн имитатора: новые кадры и HTTP сразу получают отказ, а уже ушедшие запросы дожидаются ответа
   *  (сервер их выполнил — отказ привёл бы к повтору); затем сокет закрывается (не дольше 5 с). */
  private simOffline(on: boolean): void {
    this.netDown = on || (typeof navigator !== 'undefined' && navigator.onLine === false);
    this.changed();
    if (!on) { this.transport.setOffline(false); return; }
    this.run(async () => {
      const end = Date.now() + 5000;
      while ((this.pending.size || this.syncWaiter) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      if (this.dev.sim.offline) this.transport.setOffline(true);
    });
  }

  /** «Повторить все»: неотправленные с отказом — снова в очередь; очередь операций — без паузы. */
  private async retryFailed(): Promise<number> {
    let n = 0;
    for (const o of [...this.store.outbox.values()]) if (o.failed && this.store.unfail(o.clientId)) n++;
    await this.store.flush();
    this.changed();
    this.pumpOutbox();
    this.ops.resume();
    return n;
  }

  /** «Отбросить failed»: неотправленные с отказом уходят из очереди и из ленты (и их файлы — из IDB). */
  private async discardFailed(): Promise<number> {
    const ids = this.store.discardFailed();
    await this.store.flush();
    if (ids.length) await write(this.db, { put: {}, del: { messages: ids } }).catch(() => {});
    for (const id of ids) { this.memBlobs.delete(id); delBlob(this.db, id).catch(() => {}); }
    this.changed();
    return ids.length;
  }

  // =====================================================================
  // Очередь отправки
  // =====================================================================

  /** Повтор очереди при живой сети (5xx, истёкшая ссылка на загрузку): 1, 2, 5, 10, 30 с. Обрыв сети ждёт переподключения. */
  private outboxTimer: ReturnType<typeof setTimeout> | null = null;
  private outboxAttempt = 0;
  private retryOutboxLater(): void {
    if (this.outboxTimer || this.closed) return;
    const ms = [1000, 2000, 5000, 10_000, 30_000][Math.min(this.outboxAttempt++, 4)];
    this.outboxTimer = setTimeout(() => { this.outboxTimer = null; this.pumpOutbox(); }, ms);
  }

  /** Файлы, которые сейчас грузятся в фоне: до UPLOAD_SLOTS сразу, берутся в порядке очереди. */
  private uploading = new Set<string>();
  /** Отменённые из ленты: их прерванный PUT — отказ без повтора, а не обрыв сети. */
  private cancelled = new Set<string>();
  /** Ещё не загруженное вложение: сообщение ждёт загрузчика, остальная очередь идёт мимо. */
  private static needsUpload(o: OutboxEntry): boolean { return !!o.attachment && !o.attachment.id && !o.forward; }

  /**
   * Очередь отправки. Как в Telegram, текст не ждёт видео на 500 МБ: файлы грузятся в фоне по несколько (startUpload),
   * а готовые к отправке сообщения уходят по порядку, обходя те, чей файл ещё грузится. Файлы одного чата между собой
   * порядок сохраняют: загруженный раньше соседа ждёт, пока догрузятся файлы, поставленные в этот чат до него (альбом не перемешается).
   */
  private pumpOutbox(): void {
    if (this.resetting || !this.online || !this.ready) return;
    this.startUpload();
    if (this.pumping) return;
    this.pumping = true;
    this.run(async () => {
      try {
        for (;;) {
          const next = this.nextToSend();
          if (!next || !this.online) break;
          try {
            const att = next.attachment ? { id: next.attachment.id, thumb: next.attachment.thumb ?? null, ...(next.attachment.spoiler ? { spoiler: true } : {}) } : null;
            const r = await this.request({ op: 'send', reqId: '', clientId: next.clientId, chatId: next.chatId, body: next.body, entities: next.entities ?? [], replyToId: next.replyToId, attachment: next.forward ? null : att, ...(next.groupId ? { groupId: next.groupId } : {}), ...(next.forward ? { forward: next.forward } : {}), ...(next.noLinkPreview ? { noLinkPreview: true } : {}), ...(next.blocks ? { blocks: next.blocks } : {}), ...(next.sticker ? { sticker: { id: next.sticker.id } } : {}), ...(next.todo ? { todo: { title: next.todo.title, items: next.todo.items.map((x) => ({ title: x.title })), othersCanAppend: next.todo.othersCanAppend, othersCanComplete: next.todo.othersCanComplete } } : {}), ...(next.threadId != null ? { threadId: next.threadId } : {}) });
            this.store.ack(next.clientId, r.id as number, r.createdAt as string);
            // своё опустило начало живого отрезка ниже seed — сообщения между ними догрузить (страница перед seed)
            const c = this.store.chats.get(next.chatId), live = c?.ranges[c.ranges.length - 1];
            if (c?.seed != null && live && live[0] < c.seed) { const id = next.chatId; this.run(() => this.ensureHistory(id, undefined, 0)); }
            this.outboxAttempt = 0;
            if (att) { this.memBlobs.delete(next.clientId); delBlob(this.db, next.clientId).catch(() => {}); }
          } catch (e) {
            // отказ сервера: код остаётся у сообщения (blocked — интерфейс заменит поле ввода плашкой)
            if ((e as ReqError).retry === false) this.store.fail(next.clientId, (e as ReqError).code);
            else { if ((e as ReqError).code !== 'offline') this.retryOutboxLater(); break; } // сеть — дождёмся переподключения, порядок сохранится
          }
          await this.store.flush();
          this.changed();
        }
      } finally {
        this.pumping = false;
      }
    });
  }

  /** Первое готовое к отправке: текст и пересылки — сразу; файл — когда в его чате нет недогруженных файлов, поставленных раньше. */
  private nextToSend(): OutboxEntry | undefined {
    const waiting = new Set<number>();   // чаты, где выше по очереди ещё грузится файл
    for (const o of this.store.outbox.values()) {
      if (o.failed) continue;
      if (Engine.needsUpload(o)) { waiting.add(o.chatId); continue; }
      if (o.attachment && !o.forward && waiting.has(o.chatId)) continue;
      return o;
    }
    return undefined;
  }

  /** Фоновая загрузка: занимает свободные места первыми незагруженными файлами очереди; по готовности каждого — снова очередь. */
  private startUpload(): void {
    while (this.uploading.size < UPLOAD_SLOTS && !this.resetting && this.online && this.ready) {
      const next = [...this.store.outbox.values()].find((o) => !o.failed && Engine.needsUpload(o) && !this.uploading.has(o.clientId));
      if (!next) return;
      this.uploadOne(next);
    }
  }

  private uploadOne(next: OutboxEntry): void {
    const clientId = next.clientId;
    this.uploading.add(clientId);
    let again = true;
    this.run(async () => {
      try {
        const blob = this.memBlobs.get(clientId) ?? await getBlob(this.db, clientId);
        if (!blob) { this.store.fail(clientId); return; }
        const up = await this.upload(clientId, blob, next.attachment!);
        if (this.store.outbox.has(clientId)) this.store.setUploaded(clientId, up.id);   // иначе отменили, пока шёл confirm
      } catch (e) {
        if ((e as ReqError).retry === false) this.store.fail(clientId, (e as ReqError).code);
        else { again = false; if ((e as ReqError).code !== 'offline') this.retryOutboxLater(); }   // сеть — дождёмся переподключения
      } finally {
        this.uploading.delete(clientId);
        this.cancelled.delete(clientId);
        await this.store.flush();
        this.changed();
        if (again) this.pumpOutbox();
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
    if (!this.online || !this.ready || (!this.store.pendingReads.size && !this.store.pendingThreadReads.size)) return;
    this.run(async () => {
      // треды: PUT …/read, отказ (не участник, тред удалён) — не повторять
      for (const [k, upToId] of [...this.store.pendingThreadReads]) {
        const [chatId, threadId] = k.split(':').map(Number);
        try {
          await this.http(`/chats/${chatId}/threads/${threadId}/read`, { method: 'PUT', body: JSON.stringify({ upToId }) });
          if ((this.store.pendingThreadReads.get(k) ?? 0) <= upToId) this.store.pendingThreadReads.delete(k);
        } catch (e) {
          if (/HTTP 4\d\d/.test(String((e as Error)?.message ?? ''))) this.store.pendingThreadReads.delete(k);
          else break;
        }
      }
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
      if ((this.store.pendingReads.size || this.store.pendingThreadReads.size) && this.online) this.scheduleReads(); // указатель вырос, пока отправляли
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
      if (!chat) return;
      // окно — внутри отрезка истории у якоря: считаем его сообщения, а не все загруженные (медиа за дырой не в счёт)
      const all = this.store.chatMessages(q.chatId);
      const span = feedSpan(chat, all, q.anchor?.sort);
      const { from, to } = messageWindow(all, q, span.lo, span.hi);
      const have = span.hi - span.lo;
      // старый отрезок, окно у его нового края — страница новее него, в фоне (одна на сдвиг окна)
      if (guard === 0 && !span.live && span.hi - to < page) this.run(() => this.loadNewer(q.chatId, chat.ranges[span.i][1]));
      if (span.start) return;
      let short: boolean;
      if (!q.anchor) short = have < q.limit;
      else {
        const reached = have > 0 && all[span.lo].sort <= q.anchor.sort;   // якорь уже среди загруженных
        short = !reached || (q.anchor.side !== 'start' && from === span.lo && to - from < q.limit);
      }
      // далеко в истории (переход к сообщению) — крупными страницами, а не десятками мелких запросов
      const far = q.anchor && have > 0 && all[span.lo].sort > q.anchor.sort;
      if (short) { await this.ensureHistory(q.chatId, q.anchor?.sort, have + (far ? 200 : page), far ? 200 : undefined); continue; }
      // окно близко к старому краю — страница наперёд, в фоне, чтобы прокрутка вверх не упиралась
      if (from - span.lo < page) this.run(() => this.ensureHistory(q.chatId, q.anchor?.sort, have + page));
      return;
    }
  }

  /** В отрезке у sort (нет — в живом) не меньше limit сообщений или он от начала истории: страницы перед его началом. */
  private ensureHistory(chatId: number, sort: number | undefined, limit: number, pageSize?: number): Promise<void> {
    return this.loadHistory(chatId, pageSize ?? this.cfg.historyPage ?? 50, () => {
      const chat = this.store.chats.get(chatId);
      if (!chat) return null;
      const span = feedSpan(chat, this.store.chatMessages(chatId), sort);
      // живой отрезок начат снимком, а своё отправленное опустило его начало ниже seed: страница перед seed
      // догрузит сообщения между ними, сколько бы их уже ни было в окне
      const verify = span.live && span.i >= 0 && chat.seed != null && chat.ranges[span.i][0] < chat.seed;
      if (!verify && (span.hi - span.lo >= limit || span.start)) return null;
      return { before: verify ? chat.seed! : span.i >= 0 ? chat.ranges[span.i][0] : null };
    });
  }

  /**
   * Одна страница новее старого отрезка, кончающегося на sort (?after): дошла до следующего отрезка — сливаются.
   * По чату — один такой запрос за раз; загрузку старых страниц (historyLoads) не держит.
   */
  private loadNewer(chatId: number, sort: number): Promise<void> {
    if (this.newerLoads.has(chatId)) return this.newerLoads.get(chatId)!;
    const ranges = this.store.chats.get(chatId)?.ranges ?? [];
    const i = rangeAt(ranges, sort);
    if (i < 0 || i === ranges.length - 1) return Promise.resolve();   // живой отрезок — новее ничего не нужно
    const after = ranges[i][1], page = this.cfg.historyPage ?? 50, gen = this.store.resetGen;
    const p = (async () => {
      const res = await this.http<{ messages: Message[]; hasMore: boolean }>(`/chats/${chatId}/messages?limit=${page}&after=${after}`);
      this.store.applyNewerHistory(chatId, res.messages, res.hasMore, after, gen);
      await this.store.flush();
      this.changed();
    })().finally(() => this.newerLoads.delete(chatId));
    this.newerLoads.set(chatId, p);
    return p;
  }
  private newerLoads = new Map<number, Promise<void>>();

  /** Догрузить тред под окно запроса (как ensureWindow ленты, без страниц новее: открытие треда — с живого края). */
  private async ensureThreadWindow(q: Extract<Query, { kind: 'thread' }>): Promise<void> {
    const page = this.cfg.historyPage ?? 50;
    for (let guard = 0; guard < 50; guard++) {
      if (!this.store.chats.has(q.chatId) && !this.online) return;
      const { all, span, from, to } = threadView(this.store, q);
      if (span.start) return;
      const have = span.hi - span.lo;
      const short = !q.anchor ? have < q.limit
        : have === 0 || all[span.lo].sort > q.anchor.sort || (q.anchor.side !== 'start' && from === span.lo && to - from < q.limit);
      const before = () => { const t = this.store.threadRanges(q.chatId, q.threadId); return span.i >= 0 && t ? t.ranges[span.i][0] : null; };
      if (short) { if (!(await this.loadThreadPage(q.chatId, q.threadId, before))) return; continue; }
      if (from - span.lo < page) this.run(() => this.loadThreadPage(q.chatId, q.threadId, before));
      return;
    }
  }

  /** Страница треда старее before() (null — с живого края; undefined — грузить нечего). Одна загрузка на тред за раз; ответ — сколько пришло. */
  private loadThreadPage(chatId: number, threadId: number, before: (t: ReturnType<Store['threadRanges']>) => number | null | undefined): Promise<number> {
    const k = chatId + ':' + threadId, running = this.threadLoads.get(k);
    if (running) return running.then(() => 0);
    const at = before(this.store.threadRanges(chatId, threadId));
    if (at === undefined) return Promise.resolve(0);
    const page = this.cfg.historyPage ?? 50, gen = this.store.resetGen;
    const p = (async () => {
      const res = await this.http<ThreadPage>(`/chats/${chatId}/threads/${threadId}/messages?limit=${page}${at ? `&before=${at}` : ''}`);
      if (gen !== this.store.resetGen) return 0;
      this.store.applyThreadPage(chatId, threadId, res.header, res.messages, res.hasMore, at, 'older', gen, res.guest ?? null);
      await this.store.flush();
      this.changed();
      return res.messages.length;
    })().finally(() => this.threadLoads.delete(k));
    this.threadLoads.set(k, p);
    return p;
  }
  private threadLoads = new Map<string, Promise<number>>();

  /**
   * Треды гостя (store.guests): журнала группы у меня нет — пока тред открыт, сокет подписан на него (watchThread) и
   * получает threadPush. Подписка — по открытым подпискам thread на чат без строки; закрыли — unwatchThread.
   * После подписки (и после переподключения) край треда догружается страницами новее (catchUpThread): то, что
   * пришло между страницей и подпиской или пока связи не было.
   */
  private watchingThreads = new Set<string>();
  private refusedThreads = new Set<string>();   // сервер отказал (вышел из канала…): до переподключения не просим
  private syncThreadWatches(): void {
    if (!this.online || this.closed) return;
    const want = new Set<string>();
    for (const w of this.watchers.values()) if (w.q.kind === 'thread' && this.store.isGuest(w.q.chatId)) want.add(w.q.chatId + ':' + w.q.threadId);
    for (const k of want) {
      if (this.watchingThreads.has(k) || this.refusedThreads.has(k)) continue;
      this.watchingThreads.add(k);
      const [chatId, threadId] = k.split(':').map(Number);
      this.request({ op: 'watchThread', reqId: '', chatId, threadId })
        .then(() => { if (!this.watchingThreads.has(k)) return; this.store.guestWatch(chatId, threadId, true); this.run(() => this.catchUpThread(chatId, threadId)); })
        .catch((e: ReqError) => { if (this.watchingThreads.delete(k) && e?.code !== 'offline' && !e?.retry) this.refusedThreads.add(k); });   // временный отказ — спросим снова
    }
    for (const k of [...this.watchingThreads]) {
      if (want.has(k)) continue;
      this.watchingThreads.delete(k);
      const [chatId, threadId] = k.split(':').map(Number);
      this.store.guestWatch(chatId, threadId, false);
      this.request({ op: 'unwatchThread', reqId: '', chatId, threadId }).catch(() => {});
      // вступил, пока тред открыт: дальше — журнал группы; край между последним threadPush и ним — страницей
      if (!this.store.isGuest(chatId) && [...this.watchers.values()].some((w) => w.q.kind === 'thread' && w.q.chatId === chatId && w.q.threadId === threadId)) this.run(() => this.catchUpThread(chatId, threadId));
    }
  }

  /** Край треда гостя: страницы новее последнего известного (не больше десяти); дальше — страница с живого края (новый отрезок). */
  private async catchUpThread(chatId: number, threadId: number): Promise<void> {
    const page = this.cfg.historyPage ?? 50;
    for (let i = 0; i < 10; i++) {
      const t = this.store.threadRanges(chatId, threadId);
      const last = t?.ranges[t.ranges.length - 1]?.[1];
      if (last == null) { await this.loadThreadPage(chatId, threadId, () => null); return; }
      const gen = this.store.resetGen;
      const res = await this.http<ThreadPage>(`/chats/${chatId}/threads/${threadId}/messages?limit=${page}&after=${last}`);
      if (gen !== this.store.resetGen) return;
      this.store.applyThreadPage(chatId, threadId, res.header, res.messages, res.hasMore, last, 'newer', gen, res.guest ?? null);
      await this.store.flush();
      this.changed();
      if (!res.hasMore) return;
    }
    await this.loadThreadPage(chatId, threadId, () => null);
  }

  /** Посты, у которых журнал принёс replies без кнопки в кэше: перечитать по id (история несёт copyId и прочитанность). */
  private fetchPosts(): void {
    if (!this.online || !this.postWants.size) return;
    const wants = [...this.postWants.entries()];
    this.postWants.clear();
    for (const [chatId, ids] of wants) {
      this.run(async () => {
        const asked = [...ids].slice(0, 100);
        const res = await this.http<{ messages: Message[] }>(`/chats/${chatId}/messages?ids=${asked.join(',')}`);
        // без replies (или пост не пришёл) — запомнить: следующие replies по нему перечитывания не вызывают
        const withReplies = new Set(res.messages.filter((m) => m.replies).map((m) => m.id));
        for (const id of asked) if (!withReplies.has(id)) this.postsNoReplies.add(chatId + ':' + id);
        this.store.addLoose(chatId, res.messages);
        await this.store.flush();
        this.changed();
      });
    }
  }
  private postWants = new Map<number, Set<number>>();
  /** «канал:пост», перечитанные без replies (в памяти, на сессию) */
  private postsNoReplies = new Set<string>();

  /** Страницы истории одна за другой, пока next() говорит, перед чем грузить (null — с новейшего края). Одна загрузка на чат за раз. */
  private loadHistory(chatId: number, page: number, next: () => { before: number | null } | null): Promise<void> {
    const running = this.historyLoads.get(chatId);
    if (running) return running.then(() => this.loadHistory(chatId, page, next));
    if (!next()) return Promise.resolve();
    const p = (async () => {
      for (let n = next(); n; n = next()) {
        const { before } = n, gen = this.store.resetGen;
        const res = await this.http<{ messages: Message[]; hasMore: boolean }>(`/chats/${chatId}/messages?limit=${page}${before ? `&before=${before}` : ''}`);
        if (gen !== this.store.resetGen) break;   // кэш сбросили, пока грузили, — страница к нему не относится
        this.store.applyHistory(chatId, res.messages, res.hasMore, before, gen);
        await this.store.flush();
        this.changed();
        if (!res.messages.length) break;
      }
    })().finally(() => this.historyLoads.delete(chatId));
    this.historyLoads.set(chatId, p);
    return p;
  }

  // =====================================================================
  // Уборка кэша (evict.ts)
  // =====================================================================

  private evictTimer: ReturnType<typeof setTimeout> | null = null;
  private evicting: Promise<EvictStats> | null = null;
  private lastEvict = 0;

  /** После записи в IDB: уборка в простое, не чаще раза в evictEveryMs (по умолчанию 10 минут). */
  private scheduleEvict(): void {
    if (this.closed || this.evictTimer || this.evicting || Date.now() - this.lastEvict < (this.cfg.evictEveryMs ?? 10 * 60_000)) return;
    this.evictTimer = setTimeout(() => {
      this.evictTimer = null;
      if (this.closed) return;
      // идёт догонка, запросы или загрузки — позже
      if (this.syncing || this.holding || this.busy > 0 || this.pending.size > 0 || this.historyLoads.size > 0) { this.scheduleEvict(); return; }
      this.run(() => this.evict());
    }, this.cfg.evictDelayMs ?? 5000);
  }

  /** Уборка сейчас (и для тестов): limits — пределы вместо согласованных. */
  evict(limits: EvictLimits = EVICT_LIMITS, opts: EvictOpts = {}): Promise<EvictStats> {
    if (this.evicting) return this.evicting;
    this.lastEvict = Date.now();
    const t0 = Date.now();
    const forget = (id: number) => { this.usersAsked.delete(id); this.lists.forgetUser(id); };
    const p = evict(this.store, this.db, () => this.evictKeep(), limits, { closed: () => this.closed, onUserEvicted: forget, ...opts })
      .then((st) => { this.dev.log.record('engine', 'evict', st, undefined, Date.now() - t0); this.changed(); return st; })
      .finally(() => { this.evicting = null; this.lastEvict = Date.now(); });
    this.evicting = p;
    return p;
  }

  /** Что сейчас видит интерфейс: окна лент (то, что показано, и то, что посчитается сейчас) с исходниками цитат, вкладки медиа, люди подписок. */
  private evictKeep(): EvictKeep {
    const keep: EvictKeep = { windows: new Map(), people: new Set(this.contacts.view().keys()), members: new Set(), busy: new Set() };
    // грузятся: история, страница новее, точечная подгрузка, медиа
    for (const id of [...this.historyLoads.keys(), ...this.newerLoads.keys(), ...this.chatLoads.keys()]) keep.busy.add(id);
    for (const id of this.media.busyChats()) keep.busy.add(id);
    const win = (chatId: number) => { let s = keep.windows.get(chatId); if (!s) { s = new Set(); keep.windows.set(chatId, s); } return s; };
    for (const w of this.watchers.values()) {
      const q = w.q;
      if (q.kind === 'messages') {
        // лента только открывается (сообщения ещё не прочитаны, первый снимок не готов) — окна ещё не знаем
        if (w.gated || !this.store.isLoaded(q.chatId)) keep.busy.add(q.chatId);
        const set = win(q.chatId), all = this.store.chatMessages(q.chatId);
        const span = feedSpan(this.store.chats.get(q.chatId), all, q.anchor?.sort);
        const { from, to } = messageWindow(all, q, span.lo, span.hi);
        const add = (m: LocalMessage) => {
          set.add(m.key);
          const r = m.replyToId != null ? this.store.messageById(q.chatId, m.replyToId) : undefined;
          if (r) set.add(r.key);
        };
        for (let k = from; k < to; k++) add(all[k]);
        for (const k of w.prev?.order ?? []) { const m = this.store.loadedMessage(q.chatId, k); if (m) add(m); }
      } else if (q.kind === 'thread') {
        if (w.gated || !this.store.isLoaded(q.chatId) || this.threadLoads.has(q.chatId + ':' + q.threadId)) keep.busy.add(q.chatId);
        const set = win(q.chatId), { all, from, to } = threadView(this.store, q);
        const h = this.store.messageById(q.chatId, q.threadId);
        if (h) set.add(h.key);
        for (let k = from; k < to; k++) { set.add(all[k].key); const r = all[k].replyToId != null ? this.store.messageById(q.chatId, all[k].replyToId!) : undefined; if (r) set.add(r.key); }
      } else if (q.kind === 'media') {
        const set = win(q.chatId);
        for (const m of tabMessages(this.store, q.chatId, q.tab).slice(-q.limit)) set.add(m.key);
      } else if (q.kind === 'people') for (const id of q.ids) keep.people.add(id);
      else if (q.kind === 'user' || q.kind === 'presence' || q.kind === 'profileMusic' || q.kind === 'profilePhotos') keep.people.add(q.userId);
      else if (q.kind === 'members') keep.members.add(q.chatId);
    }
    return keep;
  }

  // =====================================================================
  // Служебное
  // =====================================================================

  private async http<T>(path: string, init?: { method: string; body?: string }): Promise<T> {
    const headers = init?.body ? { ...this.cfg.headers, 'content-type': 'application/json' } : this.cfg.headers;
    const res = await this.dev.fetch(this.cfg.httpBase + path, { headers, credentials: 'include', ...(init ?? {}) });
    if (this.session.unauthorized(res.status)) throw { code: 'offline', retry: false } satisfies ReqError;   // сеанс завершён — не ошибка движка
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return (await res.json()) as T;
  }

  private run(fn: () => Promise<unknown>): void {
    this.busy++;
    fn().catch((err) => { if (!(err && (err as ReqError).code === 'offline')) { console.error('sync engine:', err); this.dev.log.error('engine', err); } })
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
