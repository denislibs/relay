import type { ClientFrame, ServerFrame } from '@relay/protocol';
import { lossy, newSim, normProfile, saveSim, simActive, simFetch, type SimState } from './devsim';
import { buildStats, countStores, estimateBytes, type DevWatcher, type HostInfo, type EngineView, type SyncCounters } from './devstats';
import type { DevAction, Item, Patch, Query } from './types';
import { readStore } from './devdata';

/**
 * Раздел «Для разработчиков»: журнал движка и его доставка подпискам (devLog), команды dev.*.
 * Имитатор сети — devsim.ts, снимок состояния (devStats) — devstats.ts.
 *
 * - журнал — кольцевой буфер на LOG_CAP событий: record() пишет всегда (одна запись в массив, без копий),
 *   а наружу события уходят, только пока есть подписка devLog — пачкой раз в 250 мс;
 * - тела сообщений обрезаются до BODY_MAX символов, у адресов отрезается query, data:-адреса (превью) — только длина:
 *   снимок журнала можно показать, не показывая переписку; у служебного сообщения с кодом входа (login_code)
 *   цифры заменяются точками — код не попадает ни в журнал, ни в просмотр хранилища.
 */
export type DevKind = 'ws-in' | 'ws-out' | 'engine' | 'error';
/** ep — эпоха журнала: случайный id экземпляра движка. После «Перезапустить воркер» id событий снова с 1,
 *  и курсоры клиента (ошибки, «Очистить», кэш сводок) сбрасываются по смене ep. */
export interface DevEvent { id: number; ep: string; t: number; kind: DevKind; type: string; data: object | null; size: number | undefined; ms: number | undefined }

export const LOG_CAP = 2000;
export const BODY_MAX = 40;
const STATS_MS = 1000;
const LOG_MS = 250;
const IDB_TTL_MS = 5000;
const MSG_MAX = 160;

const cut = (s: string, max = BODY_MAX) => (s.length > max ? s.slice(0, max) + '…' : s);
/** Адреса в журнале — без query (там бывает текст поиска) и без содержимого data:. */
export function cutUrl(s: string): string {
  return cut(s.replace(/data:[^\s"']*/g, (d) => `data:…(${d.length})`).replace(/\?[^\s"']*/g, '?…'), MSG_MAX);
}

/** Код входа — точками, как в превью и уведомлениях клиента (hideCode); здесь прячем все цифры. */
export const hideDigits = (s: string): string => s.replace(/\d/g, '•');
const isLoginCode = (o: Record<string, unknown>) => (o.service as { type?: unknown } | null | undefined)?.type === 'login_code';

function trimOwn(o: Record<string, unknown>): Record<string, unknown> {
  const b = typeof o.body === 'string', t = typeof o.text === 'string', th = typeof o.thumb === 'string';
  if (!b && !t && !th) return o;
  const c = { ...o };
  if (b) c.body = cut(isLoginCode(o) ? hideDigits(c.body as string) : c.body as string);
  if (t) c.text = cut(c.text as string);
  if (th) c.thumb = cutUrl(c.thumb as string);
  return c;
}
const nest = (v: unknown): unknown => (Array.isArray(v) ? v.map(nest1) : nest1(v));
const nest1 = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? trimOwn(v as Record<string, unknown>) : v);

/** Копия с обрезанными body/text/thumb: на верхнем уровне и на один уровень внутрь items / message / result / attachment. */
export function trimBodies(o: object): object {
  const r = trimOwn(o as Record<string, unknown>);
  let c = r === o ? null : r;
  for (const k of ['items', 'message', 'result', 'attachment'] as const) {
    const v = (o as Record<string, unknown>)[k];
    if (v && typeof v === 'object') { c ??= { ...o }; c[k] = nest(v); }
  }
  return c ?? o;
}

export class DevLog {
  private buf: (DevEvent | undefined)[] = new Array(LOG_CAP);
  /** эпоха: новая на каждый экземпляр (движок создаёт свой DevLog при каждом старте) */
  readonly epoch: string = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  private next = 1;          // id следующего события (растёт всегда, буфер — по модулю)
  private floor = 0;         // «Очистить»: события с id ≤ floor больше не отдаём
  private reqs = new Map<string, number>();   // reqId → когда ушёл запрос
  private syncAt = 0;
  private pingAt = 0;
  /** задержка последнего ping → pong по сокету, мс */
  rtt: number | null = null;

  record(kind: DevKind, type: string, data: object | null, size?: number, ms?: number): DevEvent {
    const e: DevEvent = { id: this.next, ep: this.epoch, t: Date.now(), kind, type, data, size, ms };
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
      message: cutUrl(String(e?.message ?? e?.code ?? err)),
      ...(typeof e?.stack === 'string' ? { stack: e.stack.split('\n').slice(1, 6).map((l) => cutUrl(l.trim())).join('\n') } : {}),
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

export class DevTools {
  readonly log = new DevLog();
  readonly sim: SimState = newSim();
  host: HostInfo | null = null;
  readonly openedAt = Date.now();
  /** для снимка: seq сервера (hello, дальше — максимум из ответов sync), последний sync, сколько tooLong */
  readonly counters: SyncCounters = { serverSeq: null, lastSyncAt: null, tooLongCount: 0 };
  /** HTTP движка через имитатор и журнал */
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** есть подписка devStats: пока она есть, патчи меряются в байтах (оценка, раз в секунду на подписку) */
  watching = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private logTimer: ReturnType<typeof setInterval> | null = null;
  private statsDirty = false;
  private logTick = false;
  private logSeen = 0;
  private passPatches = 0;
  private statsAt = 0;
  private idb: { at: number; counts: Record<string, number> | null; loading: boolean } = { at: 0, counts: null, loading: false };

  constructor(private db: IDBDatabase, private hooks: DevHooks) {
    this.fetch = simFetch(this.log, this.sim);
  }

  /** Сохранённый режим сети (persist) — при открытии движка. */
  restore(s: Pick<SimState, 'offline' | 'profile'> | null): void {
    if (!s) return;
    this.sim.offline = !!s.offline;
    this.sim.profile = normProfile(s.profile ?? null);
    this.sim.persist = true;
  }

  get simActive(): boolean { return simActive(this.sim); }
  /** имитатор может терять кадры — только тогда движок ждёт ответов с таймаутом */
  get lossy(): boolean { return lossy(this.sim); }

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

  /** devStats пересчитывается только на такте раз в секунду (и при подписке). */
  get statsDue(): boolean { return this.statsDirty; }

  /** Патч ушёл подписке: счётчики для снимка; размер — оценка, не чаще раза в секунду на подписку и только пока раздел открыт. */
  patched(w: DevWatcher, p: Patch): void {
    const s = (w.stat ??= { n: 0, prevN: 0, rate: 0, bytes: null, bytesAt: 0, snapAt: 0 });
    s.n++;
    if (p.op === 'snapshot') s.snapAt = Date.now();
    if (w.q.kind === 'devStats') return;
    this.passPatches++;
    if (this.watching && Date.now() - s.bytesAt >= STATS_MS) { s.bytes = estimateBytes(p); s.bytesAt = Date.now(); }
  }

  /**
   * Журнал подписке devLog: при подписке (force) — снимок новее since; дальше на такте 250 мс — diff с append:
   * только новые события и ключи вытесненных из буфера (у вкладки они старейшие), без полного порядка.
   */
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
      const had = w.cursor ?? 0;
      const ev = this.log.since(had);
      w.cursor = last;
      // у вкладки — события [first, had]; всё, что старше нового начала буфера, ей пора убрать
      const first = this.log.firstId, from = w.first ?? first;
      const remove: string[] = [];
      for (let id = from, to = Math.min(first, had + 1); id < to; id++) remove.push('e' + id);
      w.first = Math.max(from, first);
      patch = { op: 'diff', upsert: ev.map(item), remove, append: true };
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
    // готовые счётчики уйдут со следующим тактом
    countStores(this.db).then((counts) => { this.idb = { at: Date.now(), counts, loading: false }; },
      () => { this.idb = { ...this.idb, at: Date.now(), loading: false }; });
  }

  stats(): Item {
    const now = Date.now();
    const dt = this.statsAt ? (now - this.statsAt) / 1000 : 0;
    this.statsAt = now;
    return buildStats(this.hooks.view(), { db: this.db, log: this.log, sim: this.sim, host: this.host, openedAt: this.openedAt, counters: this.counters, idb: this.idb.counts, dt });
  }

  // ---------- команды ----------

  /** Команда меняет состояние сразу; снимок devStats покажет его на следующем такте. */
  async command(a: DevAction): Promise<unknown> {
    this.log.record('engine', 'dev:' + a.cmd, a.args ?? null);
    switch (a.cmd) {
      case 'offline':
        this.sim.offline = a.args.on;
        if (a.args.persist !== undefined) this.sim.persist = a.args.persist;
        saveSim(this.db, this.sim);
        this.hooks.offline(a.args.on);
        return null;
      case 'netProfile':
        this.sim.profile = normProfile(a.args.profile);
        if (a.args.persist !== undefined) this.sim.persist = a.args.persist;
        saveSim(this.db, this.sim);
        return null;
      case 'persist':
        this.sim.persist = a.args.on;
        saveSim(this.db, this.sim);
        return null;
      case 'dropSocket': this.hooks.dropSocket(); return null;
      case 'dropNextUpdates': this.sim.dropNextUpdates = true; return null;   // сработает на следующем ответе sync (poke)
      case 'forceTooLong': this.sim.forceTooLong = true; this.hooks.sync(); return null;
      case 'resync': await this.hooks.resync(); return null;
      case 'restartWorker': return this.hooks.restart();
      case 'retryFailed': return { count: await this.hooks.retryFailed() };
      case 'discardFailed': return { count: await this.hooks.discardFailed() };
      case 'clearLog': this.log.clear(); return null;
      case 'idbRead': return readStore(this.db, a.args);
    }
  }
}

const keyOf = (e: DevEvent) => 'e' + e.id;
const item = (e: DevEvent): Item => ({ key: 'e' + e.id, ...e });

export { loadSim, type SimState } from './devsim';
export type { SubStat, HostInfo, TransportView } from './devstats';
