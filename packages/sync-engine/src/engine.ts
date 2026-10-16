import type { ClientFrame, Message, ServerFrame } from '@relay/protocol';
import { openDb } from './idb';
import { affects, computeQuery, diffResults, type Result } from './queries';
import { Store, type ChatSummary } from './store';
import { WsTransport } from './transport';
import type { Action, EngineConfig, Patch, Query } from './types';

export interface WatchHandle { update(q: Query): void; close(): void }

interface Watcher { id: number; q: Query; cb: (p: Patch) => void; prev: Result | null; force: boolean }
type ReqError = { code: string; retry: boolean };
type SyncReply = Extract<ServerFrame, { op: 'updates' | 'tooLong' }>;

/**
 * Движок синхронизации: владеет Store, держит соединение, догоняет журнал,
 * отправляет очередь, схлопывает прочтение и раздаёт подпискам патчи раз в кадр.
 */
export class Engine {
  private transport: WsTransport;
  private watchers = new Map<number, Watcher>();
  private nextWatch = 1;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private readTimer: ReturnType<typeof setTimeout> | null = null;

  private online = false;   // сокет открыт
  private ready = false;    // первый sync после подключения завершён
  private syncing = false;
  private syncAgain = false;
  private syncWaiter: { resolve(f: SyncReply): void; reject(e: ReqError): void } | null = null;
  private reqSeq = 0;
  private pending = new Map<string, { resolve(r: Record<string, unknown>): void; reject(e: ReqError): void }>();
  private pumping = false;
  private busy = 0;
  private historyLoads = new Map<number, Promise<void>>();
  private lastCreated = 0;
  private closed = false;

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

  connect(): void { if (!this.closed) this.transport.start(); }
  disconnect(): void { this.transport.stop(); }

  async close(): Promise<void> {
    this.closed = true;
    this.disconnect();
    if (this.frameTimer) clearTimeout(this.frameTimer);
    if (this.readTimer) clearTimeout(this.readTimer);
    this.watchers.clear();
    await this.whenIdle(2000).catch(() => {});
    await this.store.flush();
    this.db.close();
  }

  // =====================================================================
  // Подписки
  // =====================================================================

  watch(q: Query, cb: (p: Patch) => void): WatchHandle {
    const w: Watcher = { id: this.nextWatch++, q, cb, prev: null, force: true };
    this.watchers.set(w.id, w);
    this.prepare(w);
    this.schedule();
    return {
      update: (q2) => { w.q = q2; w.force = true; this.prepare(w); this.schedule(); },
      close: () => { this.watchers.delete(w.id); },
    };
  }

  private prepare(w: Watcher): void {
    if (w.q.kind !== 'messages') return;
    const { chatId, limit } = w.q;
    this.run(async () => {
      await this.store.loadChatMessages(chatId);
      this.changed();
      await this.ensureHistory(chatId, limit);
    });
  }

  private changed(): void { this.schedule(); }

  private schedule(): void {
    if (this.frameTimer || this.closed) return;
    this.frameTimer = setTimeout(() => { this.frameTimer = null; this.emit(); }, this.cfg.frameMs ?? 16);
  }

  private emit(): void {
    const touched = new Set(this.store.touched);
    this.store.touched.clear();
    for (const w of this.watchers.values()) {
      if (!w.force && !affects(w.q, touched)) continue;
      w.force = false;
      const next = computeQuery(this.store, w.q);
      const patch = diffResults(w.prev, next);
      w.prev = next;
      if (patch) {
        try { w.cb(patch); } catch (err) { console.error('watch callback failed', err); }
      }
    }
  }

  // =====================================================================
  // Действия интерфейса
  // =====================================================================

  async call(a: Action): Promise<unknown> {
    switch (a.type) {
      case 'sendMessage': {
        const clientId = crypto.randomUUID();
        this.lastCreated = Math.max(Date.now(), this.lastCreated + 1); // порядок черновиков внутри одной миллисекунды
        this.store.addPending({ clientId, chatId: a.chatId, body: a.body, replyToId: a.replyToId ?? null, createdAt: this.lastCreated, failed: false });
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
    this.ready = false;
    this.transport.send({ op: 'hello', lastSeq: this.store.lastSeq });
  }

  private onClose(): void {
    this.online = false;
    this.ready = false;
    const offline: ReqError = { code: 'offline', retry: true };
    this.syncWaiter?.reject(offline);
    this.syncWaiter = null;
    for (const p of this.pending.values()) p.reject(offline);
    this.pending.clear();
  }

  private onFrame(f: ServerFrame): void {
    switch (f.op) {
      case 'hello':
        if (this.store.lastSeq === 0) this.run(() => this.bootstrap(f.seq));
        else this.runSync();
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
      case 'pong':
        return;
    }
  }

  /** Первый вход или tooLong: hello дал seq S → снимок → lastSeq = S → догоняем от S. */
  private async bootstrap(seq: number): Promise<void> {
    this.syncing = true;
    try {
      const list = await this.http<ChatSummary[]>('/chats');
      this.store.applySnapshot(list);
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
            const list = await this.http<ChatSummary[]>('/chats');
            this.store.applySnapshot(list);
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
      this.pumpOutbox();
      this.flushReads();
    }
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

  private ensureHistory(chatId: number, limit: number): Promise<void> {
    const have = this.store.chatMessages(chatId).length;
    const chat = this.store.chats.get(chatId);
    if (have >= limit || chat?.historyComplete) return Promise.resolve();
    const running = this.historyLoads.get(chatId);
    if (running) return running.then(() => this.ensureHistory(chatId, limit));
    const page = this.cfg.historyPage ?? 50;
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
    const res = await fetch(this.cfg.httpBase + path, { headers: this.cfg.authHeaders?.() });
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
      if (Date.now() > end) throw new Error('engine did not become idle');
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
