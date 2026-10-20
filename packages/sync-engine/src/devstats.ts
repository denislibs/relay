import type { DevLog } from './devlog';
import { LOG_CAP } from './devlog';
import { simActive, type SimState } from './devsim';
import { STORES, type StoreName } from './schema';
import type { Item, OutboxEntry, Patch, Query } from './types';

/** Снимок состояния движка для раздела «Для разработчиков» (подписка devStats). */

/** Подписка с точки зрения раздела: счётчики патчей ведёт DevTools.patched. */
export interface SubStat { n: number; prevN: number; rate: number; bytes: number | null; bytesAt: number; snapAt: number }
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

/** Счётчики, которые движок ведёт для снимка. */
export interface SyncCounters { serverSeq: number | null; lastSyncAt: number | null; tooLongCount: number }

const EWMA = 0.5;
const SAMPLE = 8;

/**
 * Размер патча — оценка без сериализации большого снимка: до SAMPLE элементов — точно,
 * больше — средний размер первых SAMPLE × число элементов, плюс ключи порядка.
 */
export function estimateBytes(p: Patch): number {
  const items = p.op === 'snapshot' ? p.items : p.upsert;
  let n = 0;
  const k = Math.min(items.length, SAMPLE);
  for (let i = 0; i < k; i++) n += JSON.stringify(items[i]).length;
  const itemsBytes = items.length > k ? Math.round((n / k) * items.length) : n;
  const keys = (p.op === 'diff' ? p.remove.length : 0) + (p.order?.length ?? 0);
  return itemsBytes + keys * 12 + 40;
}

function subKey(q: Query): string {
  switch (q.kind) {
    case 'messages': return 'messages:' + q.chatId;
    case 'presence': return 'presence:' + q.userId;
    case 'user': return 'user:' + q.userId;
    default: return q.kind;
  }
}

export function buildStats(v: EngineView, o: { db: IDBDatabase; log: DevLog; sim: SimState; host: HostInfo | null; openedAt: number; counters: SyncCounters; idb: Record<string, number> | null; dt: number }): Item {
  const now = Date.now();
  let pending = 0, failed = 0;
  const byChat: Record<string, { pending: number; failed: number }> = {};
  for (const e of v.outbox) {
    const c = (byChat[e.chatId] ??= { pending: 0, failed: 0 });
    if (e.failed) { failed++; c.failed++; } else { pending++; c.pending++; }
  }
  const subs = [];
  for (const w of v.watchers) {
    const s = w.stat;
    if (s && o.dt > 0) { s.rate = EWMA * ((s.n - s.prevN) / o.dt) + (1 - EWMA) * s.rate; s.prevN = s.n; }
    subs.push({
      id: w.id, kind: w.q.kind, key: subKey(w.q),
      items: w.q.kind === 'devLog' ? Math.max(0, (w.cursor ?? 0) - (w.first ?? 1) + 1) : w.prev?.order.length ?? 0,
      patchesPerSec: s ? Math.round(s.rate * 10) / 10 : 0,
      lastPatchBytes: s?.bytes ?? null,
      sinceSnapshotMs: s?.snapAt ? now - s.snapAt : null,
    });
  }
  const { serverSeq, lastSyncAt, tooLongCount } = o.counters;
  const h = o.host, sim = o.sim;
  return {
    key: 'devStats',
    at: now,
    build: h?.build ?? null,
    epoch: v.epoch,
    userId: v.userId,
    idbVersion: o.db.version,
    host: h ? { kind: h.kind, clients: h.clients(), uptimeMs: now - h.startedAt } : null,
    engineUptimeMs: now - o.openedAt,
    logEpoch: o.log.epoch,
    pingMs: o.log.rtt,
    sync: {
      lastSeq: v.lastSeq, serverSeq, lag: serverSeq == null ? null : Math.max(0, serverSeq - v.lastSeq),
      phase: v.phase, ready: v.ready, syncing: v.syncing, lastSyncAt, tooLongCount,
    },
    socket: v.socket,
    queues: { outbox: { pending, failed, byChat }, pendingReads: v.pendingReads, ops: v.ops },
    subscriptions: subs,
    idb: o.idb,
    log: { size: o.log.size, lastId: o.log.lastId, cap: LOG_CAP },
    sim: { offline: sim.offline, profile: sim.profile, dropNextUpdates: sim.dropNextUpdates, forceTooLong: sim.forceTooLong, persist: sim.persist, active: simActive(sim) },
  };
}


/** Число записей по сторам IDB (count() — дёшево, без чтения записей). */
export function countStores(db: IDBDatabase): Promise<Record<StoreName, number>> {
  return new Promise((resolve, reject) => {
    const names = STORES.filter((s) => db.objectStoreNames.contains(s));
    const t = db.transaction(names);
    const out = Object.fromEntries(STORES.map((s) => [s, 0])) as Record<StoreName, number>;
    for (const s of names) { const r = t.objectStore(s).count(); r.onsuccess = () => { out[s] = r.result; }; }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
