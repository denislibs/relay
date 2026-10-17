import type { ClientFrame, ServerFrame } from '@relay/protocol';
import type { DevAction, Item, NetProfile, OutboxEntry, Patch, Query } from './types';

/**
 * Раздел «Для разработчиков»: журнал движка, снимок состояния и имитатор сети.
 *
 * - журнал — кольцевой буфер на LOG_CAP событий: record() пишет всегда (одна запись в массив, без копий),
 *   а наружу события уходят, только пока есть подписка devLog — пачкой раз в 250 мс;
 * - тела сообщений обрезаются до BODY_MAX символов: снимок журнала можно показать, не показывая переписку;
 * - имитатор (sim) читают транспорт (кадры) и simFetch (HTTP движка): офлайн, задержка, потери, выброс кадра.
 *   Состояние — в памяти воркера; с persist — ещё и в IDB meta (devSim), применяется при открытии движка.
 */
export type DevKind = 'ws-in' | 'ws-out' | 'engine' | 'error';
export interface DevEvent { id: number; t: number; kind: DevKind; type: string; data: object | null; size: number | undefined; ms: number | undefined }

export const LOG_CAP = 2000;
export const BODY_MAX = 40;
const STATS_MS = 1000;
const LOG_MS = 250;
const IDB_TTL_MS = 5000;
const EWMA = 0.5;

const cut = (s: string) => (s.length > BODY_MAX ? s.slice(0, BODY_MAX) + '…' : s);

function trimOwn(o: Record<string, unknown>): Record<string, unknown> {
  if (typeof o.body !== 'string' && typeof o.text !== 'string') return o;
  const c = { ...o };
  if (typeof c.body === 'string') c.body = cut(c.body);
  if (typeof c.text === 'string') c.text = cut(c.text);
  return c;
}
const nest = (v: unknown): unknown => (Array.isArray(v) ? v.map(nest1) : nest1(v));
const nest1 = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? trimOwn(v as Record<string, unknown>) : v);

/** Копия с обрезанными body/text: на верхнем уровне и на один уровень внутрь items / message / result. */
export function trimBodies(o: object): object {
  const r = trimOwn(o as Record<string, unknown>);
  let c = r === o ? null : r;
  for (const k of ['items', 'message', 'result'] as const) {
    const v = (o as Record<string, unknown>)[k];
    if (v && typeof v === 'object') { c ??= { ...o }; c[k] = nest(v); }
  }
  return c ?? o;
}

export class DevLog {
  private buf: (DevEvent | undefined)[] = new Array(LOG_CAP);
  private next = 1;          // id следующего события (растёт всегда, буфер — по модулю)
  private floor = 0;         // «Очистить»: события с id ≤ floor больше не отдаём
  private reqs = new Map<string, number>();   // reqId → когда ушёл запрос
  private syncAt = 0;
  private pingAt = 0;
  /** задержка последнего ping → pong по сокету, мс */
  rtt: number | null = null;

  record(kind: DevKind, type: string, data: object | null, size?: number, ms?: number): DevEvent {
    const e: DevEvent = { id: this.next, t: Date.now(), kind, type, data, size, ms };
    this.buf[(this.next - 1) % LOG_CAP] = e;
    this.next++;
    return e;
  }

  get lastId(): number { return this.next - 1; }
  /** id самого старого события, которое ещё в буфере */
  get firstId(): number { return Math.max(this.floor + 1, this.next - LOG_CAP, 1); }
  get size(): number { return this.next - this.firstId; }

  /** События новее cursor, от старых к новым. */
  since(cursor: number): DevEvent[] {
    const out: DevEvent[] = [];
    for (let id = Math.max(cursor + 1, this.firstId); id < this.next; id++) out.push(this.buf[(id - 1) % LOG_CAP]!);
    return out;
  }

  clear(): void { this.floor = this.next - 1; }

  error(where: string, err: unknown): void {
    const e = err as { message?: unknown; stack?: unknown; code?: unknown } | null;
    this.record('error', where, {
      message: String(e?.message ?? e?.code ?? err),
      ...(typeof e?.stack === 'string' ? { stack: e.stack.split('\n').slice(0, 6).join('\n') } : {}),
    });
  }

  /** Исходящий кадр: запоминаем время запросов, чтобы ответу дать задержку «запрос → ответ». */
  frameOut(f: ClientFrame, size: number): void {
    const now = Date.now();
    if (f.op === 'sync') this.syncAt = now;
    else if (f.op === 'ping') this.pingAt = now;
    else if ('reqId' in f && f.reqId) {
      if (this.reqs.size > 1000) this.reqs.clear();   // ответы потеряны (обрыв без close) — не копим
      this.reqs.set(f.reqId, now);
    }
    this.record('ws-out', f.op, f.op === 'send' || f.op === 'draft' || f.op === 'edit' ? trimBodies(f) : f, size);
  }

  /** Входящий кадр; updates — только сводка (from, to, сколько записей, типы), без самих записей. */
  frameIn(f: ServerFrame, size: number, note?: string): void {
    const now = Date.now();
    let ms: number | undefined;
    let data: object = f;
    switch (f.op) {
      case 'updates': {
        // типы записей подряд обычно одинаковые: считаем сериями — вдвое дешевле, чем инкремент на каждую
        const types: Record<string, number> = {};
        const items = f.items;
        let prev = '', run = 0;
        for (let i = 0; i < items.length; i++) {
          const k = items[i].update.type;
          if (k === prev) { run++; continue; }
          if (run) types[prev] = (types[prev] ?? 0) + run;
          prev = k; run = 1;
        }
        if (run) types[prev] = (types[prev] ?? 0) + run;
        data = { from: f.from, to: f.to, count: f.items.length, more: f.more, types };
        if (this.syncAt) ms = now - this.syncAt;
        break;
      }
      case 'tooLong':
        if (this.syncAt) ms = now - this.syncAt;
        break;
      case 'ack':
      case 'err': {
        const at = f.reqId ? this.reqs.get(f.reqId) : undefined;
        if (at !== undefined) { ms = now - at; this.reqs.delete(f.reqId!); }
        if (f.op === 'ack') data = trimBodies(f);
        break;
      }
      case 'pong':
        if (this.pingAt) { ms = this.rtt = now - this.pingAt; this.pingAt = 0; }
        break;
      case 'presence':
        data = { count: f.items.length };
        break;
    }
    this.record('ws-in', note ? f.op + ':' + note : f.op, data, size, ms);
  }

  /** Сокет закрылся: ответов на прежние запросы уже не будет. */
  closed(): void { this.reqs.clear(); this.syncAt = 0; this.pingAt = 0; }
}

// =====================================================================
// Имитатор сети
// =====================================================================

export interface SimState {
  offline: boolean;
  profile: NetProfile | null;
  /** выбросить следующий входящий updates (проверка дыр в seq) */
  dropNextUpdates: boolean;
  /** следующий ответ на sync — как tooLong */
  forceTooLong: boolean;
  /** offline и profile переживают перезапуск (IDB meta.devSim) */
  persist: boolean;
}

const SIM_META = 'devSim';

export async function loadSim(db: IDBDatabase): Promise<Pick<SimState, 'offline' | 'profile'> | null> {
  try {
    const row = await new Promise<{ v: Pick<SimState, 'offline' | 'profile'> } | undefined>((resolve, reject) => {
      const r = db.transaction('meta').objectStore('meta').get(SIM_META);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return row?.v ?? null;
  } catch { return null; }
}

function saveSim(db: IDBDatabase, s: SimState): void {
  try {
    const os = db.transaction('meta', 'readwrite').objectStore('meta');
    if (s.persist && (s.offline || s.profile)) os.put({ k: SIM_META, v: { offline: s.offline, profile: s.profile } });
    else os.delete(SIM_META);
  } catch { /* база закрыта */ }
}

/** Задержка одного направления: половина latency, джиттер, время на передачу size байт при kbps. */
export function oneWay(p: NetProfile, size: number): number {
  const d = p.latency / 2 + Math.random() * (p.jitter || 0) / 2 + (p.kbps > 0 ? (size * 8) / p.kbps : 0);
  return Math.max(0, d);
}
export const lost = (p: NetProfile | null) => !!p && p.lossPct > 0 && Math.random() * 100 < p.lossPct;

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
function pathOf(url: string): string {
  try { const u = new URL(url); return u.pathname + (u.search ? cut(u.search) : ''); } catch { return cut(url); }
}
const bodySize = (b: unknown): number => (typeof b === 'string' ? b.length : b && typeof (b as Blob).size === 'number' ? (b as Blob).size : 0);

// =====================================================================
// Снимок состояния
// =====================================================================

/** Подписка с точки зрения раздела: счётчики патчей ведёт DevTools.patched. */
export interface SubStat { n: number; prevN: number; rate: number; bytes: number | null; snapAt: number }
export interface DevWatcher { id: number; q: Query; prev: { order: string[] } | null; stat?: SubStat; cursor?: number; first?: number; force: boolean; cb: (p: Patch) => void }

export type SocketState = 'open' | 'connecting' | 'waiting' | 'closed' | 'offline';
export interface TransportView { state: SocketState; attempt: number; nextDelay: number | null; nextAt: number | null }

/** Что движок отдаёт снимку (engine.ts собирает это из своих полей). */
export interface EngineView {
  userId: number;
  epoch: string | null;
  lastSeq: number;
  phase: string;
  ready: boolean;
  syncing: boolean;
  socket: TransportView;
  outbox: Iterable<OutboxEntry>;
  pendingReads: number;
  ops: { pending: number; keys: string[]; failures: number };
  watchers: Iterable<DevWatcher>;
}

/** Хост (host-core.ts): сборка, тип, сколько вкладок, когда стартовал. */
export interface HostInfo { build: string; kind: 'shared' | 'dedicated-leader' | 'dedicated-follower'; clients(): number; startedAt: number }

export interface DevHooks {
  view(): EngineView;
  /** разбудить проход подписок */
  schedule(): void;
  /** ping по сокету (если открыт) — для RTT */
  ping(): void;
  offline(on: boolean): void;
  dropSocket(): void;
  /** догнать журнал (forceTooLong — сразу) */
  sync(): void;
  /** снимок без очистки кэша */
  resync(): Promise<void>;
  /** перезапуск движка; без хоста — переподключение */
  restart(): Promise<unknown>;
  retryFailed(): Promise<number>;
  discardFailed(): Promise<number>;
}

const STORES = ['chats', 'messages', 'outbox', 'pendingReads', 'meta', 'users', 'ops', 'blobs'];

export class DevTools {
  readonly log = new DevLog();
  sim: SimState = { offline: false, profile: null, dropNextUpdates: false, forceTooLong: false, persist: false };
  host: HostInfo | null = null;
  readonly openedAt = Date.now();
  /** seq сервера: из последнего hello, дальше — максимум из ответов sync */
  serverSeq: number | null = null;
  lastSyncAt: number | null = null;
  tooLongCount = 0;
  /** есть подписка devStats: пока она есть, патчи меряются в байтах */
  watching = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private logTimer: ReturnType<typeof setInterval> | null = null;
  private statsDirty = false;
  private logTick = false;
  private logSeen = 0;
  private passPatches = 0;
  private statsAt = 0;
  private idb: { at: number; counts: Record<string, number> | null; loading: boolean } = { at: 0, counts: null, loading: false };

  constructor(private db: IDBDatabase, private hooks: DevHooks) {}

  /** Сохранённый режим сети (persist) — при открытии движка. */
  restore(s: Pick<SimState, 'offline' | 'profile'> | null): void {
    if (!s) return;
    this.sim.offline = !!s.offline;
    this.sim.profile = s.profile ?? null;
    this.sim.persist = true;
  }

  get simActive(): boolean { return this.sim.offline || !!this.sim.profile || this.sim.dropNextUpdates || this.sim.forceTooLong; }

  /** HTTP движка: все запросы идут через эту обёртку — имитатор и журнал. */
  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const t0 = Date.now();
    const method = init?.method ?? 'GET';
    const path = pathOf(url);
    if (this.sim.offline) { this.log.record('engine', 'http', { method, path, error: 'offline (dev)' }); throw new TypeError('Failed to fetch (dev: offline)'); }
    const p = this.sim.profile;
    if (p) await sleep(oneWay(p, bodySize(init?.body)));
    let res: Response;
    try { res = await fetch(url, init); }
    catch (err) { this.log.record('engine', 'http', { method, path, error: String((err as Error)?.message ?? err) }, undefined, Date.now() - t0); throw err; }
    const size = Number(res.headers.get('content-length')) || undefined;
    if (this.sim.profile) await sleep(oneWay(this.sim.profile, size ?? 0));
    if (this.sim.offline) { this.log.record('engine', 'http', { method, path, error: 'offline (dev)' }); throw new TypeError('Failed to fetch (dev: offline)'); }
    this.log.record('engine', 'http', { method, path, status: res.status }, size, Date.now() - t0);
    return res;
  };

  // ---------- подписки ----------

  /** Пересчитать подписчиков раздела: таймеры работают, только пока подписка есть. */
  track(watchers: Iterable<{ q: Query }>): void {
    let stats = false, log = false;
    for (const w of watchers) { if (w.q.kind === 'devStats') stats = true; else if (w.q.kind === 'devLog') log = true; }
    this.watching = stats;
    if (stats && !this.statsTimer) {
      this.statsTimer = setInterval(() => { this.statsDirty = true; this.hooks.ping(); this.refreshIdb(); this.hooks.schedule(); }, STATS_MS);
      this.refreshIdb();
    } else if (!stats && this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    if (log && !this.logTimer) {
      this.logTimer = setInterval(() => { if (this.log.lastId !== this.logSeen) { this.logTick = true; this.hooks.schedule(); } }, LOG_MS);
    } else if (!log && this.logTimer) { clearInterval(this.logTimer); this.logTimer = null; }
  }

  /** Подписчиков раздела нет — ни таймеров, ни патчей. */
  get idle(): boolean { return !this.statsTimer && !this.logTimer; }

  stop(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.logTimer) clearInterval(this.logTimer);
    this.statsTimer = this.logTimer = null;
    this.watching = false;
  }

  /** devStats пересчитывается не чаще раза в секунду. */
  get statsDue(): boolean { return this.statsDirty; }

  /** Патч ушёл подписке: счётчики для снимка; размер — только пока раздел открыт. */
  patched(w: DevWatcher, p: Patch): void {
    const s = (w.stat ??= { n: 0, prevN: 0, rate: 0, bytes: null, snapAt: 0 });
    s.n++;
    if (p.op === 'snapshot') s.snapAt = Date.now();
    if (w.q.kind === 'devStats') return;
    this.passPatches++;
    if (this.watching) s.bytes = JSON.stringify(p).length;
  }

  /** Журнал подписке devLog: при подписке (force) — снимок новее since, дальше — новые события на такте 250 мс. */
  pushLog(w: DevWatcher): void {
    if (w.q.kind !== 'devLog') return;
    let patch: Patch;
    const last = this.log.lastId;
    if (w.force) {
      w.force = false;
      const ev = this.log.since(w.q.since);
      w.first = ev.length ? ev[0].id : last + 1;
      w.cursor = last;
      patch = { op: 'snapshot', items: ev.map(item), order: ev.map(keyOf) };
    } else {
      if (!this.logTick || last === w.cursor) return;
      const ev = this.log.since(w.cursor ?? 0);
      w.cursor = last;
      // вытесненные из буфера — убрать и у вкладки, чтобы её зеркало не росло
      const first = Math.max(w.first ?? 1, this.log.firstId);
      const remove: string[] = [];
      for (let id = w.first ?? first; id < first; id++) remove.push('e' + id);
      w.first = first;
      const order: string[] = [];
      for (let id = first; id <= last; id++) order.push('e' + id);
      patch = { op: 'diff', upsert: ev.map(item), remove, order };
    }
    try { w.cb(patch); } catch (err) { this.log.error('devLog callback', err); }
  }

  /** Конец прохода подписок: одно событие «патчи» на проход (без патчей самого раздела). */
  afterEmit(): void {
    if (this.passPatches) this.log.record('engine', 'patches', { count: this.passPatches });
    this.passPatches = 0;
    if (this.logTick) { this.logTick = false; this.logSeen = this.log.lastId; }
    this.statsDirty = false;
  }

  private refreshIdb(): void {
    if (this.idb.loading || Date.now() - this.idb.at < IDB_TTL_MS) return;
    this.idb.loading = true;
    countStores(this.db).then((counts) => { this.idb = { at: Date.now(), counts, loading: false }; this.statsDirty = true; this.hooks.schedule(); },
      () => { this.idb = { ...this.idb, at: Date.now(), loading: false }; });
  }

  // ---------- снимок ----------

  stats(): Item {
    const v = this.hooks.view();
    const now = Date.now();
    const dt = this.statsAt ? (now - this.statsAt) / 1000 : 0;
    this.statsAt = now;
    let pending = 0, failed = 0;
    const byChat: Record<string, { pending: number; failed: number }> = {};
    for (const o of v.outbox) {
      const c = (byChat[o.chatId] ??= { pending: 0, failed: 0 });
      if (o.failed) { failed++; c.failed++; } else { pending++; c.pending++; }
    }
    const subs = [];
    for (const w of v.watchers) {
      const s = w.stat;
      if (s && dt > 0) { s.rate = EWMA * ((s.n - s.prevN) / dt) + (1 - EWMA) * s.rate; s.prevN = s.n; }
      subs.push({
        id: w.id, kind: w.q.kind, key: subKey(w.q),
        items: w.q.kind === 'devLog' ? (w.cursor ?? 0) - (w.first ?? 0) + 1 : w.prev?.order.length ?? 0,
        patchesPerSec: s ? Math.round(s.rate * 10) / 10 : 0,
        lastPatchBytes: s?.bytes ?? null,
        sinceSnapshotMs: s?.snapAt ? now - s.snapAt : null,
      });
    }
    const h = this.host;
    return {
      key: 'devStats',
      at: now,
      build: h?.build ?? null,
      epoch: v.epoch,
      userId: v.userId,
      idbVersion: this.db.version,
      host: h ? { kind: h.kind, clients: h.clients(), uptimeMs: now - h.startedAt } : null,
      engineUptimeMs: now - this.openedAt,
      pingMs: this.log.rtt,
      sync: {
        lastSeq: v.lastSeq, serverSeq: this.serverSeq, lag: this.serverSeq == null ? null : Math.max(0, this.serverSeq - v.lastSeq),
        phase: v.phase, ready: v.ready, syncing: v.syncing, lastSyncAt: this.lastSyncAt, tooLongCount: this.tooLongCount,
      },
      socket: v.socket,
      queues: { outbox: { pending, failed, byChat }, pendingReads: v.pendingReads, ops: v.ops },
      subscriptions: subs,
      idb: this.idb.counts,
      log: { size: this.log.size, lastId: this.log.lastId, cap: LOG_CAP },
      sim: { offline: this.sim.offline, profile: this.sim.profile, dropNextUpdates: this.sim.dropNextUpdates, forceTooLong: this.sim.forceTooLong, persist: this.sim.persist, active: this.simActive },
    };
  }

  // ---------- команды ----------

  async command(a: DevAction): Promise<unknown> {
    this.log.record('engine', 'dev:' + a.cmd, a.args ?? null);
    switch (a.cmd) {
      case 'offline':
        this.sim.offline = a.args.on;
        if (a.args.persist !== undefined) this.sim.persist = a.args.persist;
        saveSim(this.db, this.sim);
        this.hooks.offline(a.args.on);
        break;
      case 'netProfile':
        this.sim.profile = a.args.profile ? { latency: +a.args.profile.latency || 0, jitter: +a.args.profile.jitter || 0, lossPct: Math.min(100, +a.args.profile.lossPct || 0), kbps: +a.args.profile.kbps || 0 } : null;
        if (a.args.persist !== undefined) this.sim.persist = a.args.persist;
        saveSim(this.db, this.sim);
        break;
      case 'persist':
        this.sim.persist = a.args.on;
        saveSim(this.db, this.sim);
        break;
      case 'dropSocket': this.hooks.dropSocket(); break;
      case 'dropNextUpdates': this.sim.dropNextUpdates = true; break;   // сработает на следующем ответе sync (poke)
      case 'forceTooLong': this.sim.forceTooLong = true; this.hooks.sync(); break;
      case 'resync': await this.hooks.resync(); break;
      case 'restartWorker': return this.hooks.restart();
      case 'retryFailed': return { count: await this.hooks.retryFailed() };
      case 'discardFailed': return { count: await this.hooks.discardFailed() };
      case 'clearLog': this.log.clear(); break;
    }
    this.statsDirty = true;
    this.hooks.schedule();
    return null;
  }
}

const keyOf = (e: DevEvent) => 'e' + e.id;
const item = (e: DevEvent): Item => ({ key: 'e' + e.id, ...e });

function subKey(q: Query): string {
  switch (q.kind) {
    case 'messages': return 'messages:' + q.chatId;
    case 'presence': return 'presence:' + q.userId;
    case 'user': return 'user:' + q.userId;
    default: return q.kind;
  }
}

function countStores(db: IDBDatabase): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    const names = STORES.filter((s) => db.objectStoreNames.contains(s));
    const t = db.transaction(names);
    const out: Record<string, number> = {};
    for (const s of names) { const r = t.objectStore(s).count(); r.onsuccess = () => { out[s] = r.result; }; }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
