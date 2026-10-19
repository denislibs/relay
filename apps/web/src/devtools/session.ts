// Данные раздела «Для разработчиков», пока он открыт: подписки devStats и devLog движка, метрики главного потока,
// опрос /dev/stats сервера. Закрыли раздел — closeDevSession(): ни таймеров, ни подписок.

import { Mirror } from '@relay/sync-engine/src/client';
import type { Item } from '@relay/sync-engine/src/types';
import { useEffect, useState } from 'preact/hooks';
import { watchDev } from '../settingsData';
import { ingestLogErrors, startMetrics, type MainMetrics } from './metrics';

export interface ServerStats { at: number; userId: number; seq: number; sockets: number; journal: { size: number; minSeq: number | null }; notifyMs: number | null; storage?: StorageStats }
/** Хранилище пользователя и израсходованная квота загрузок (apps/server/src/domain/uploadLimits.ts storageUsage). */
export interface StorageStats {
  files: number; bytes: number; pending: number; variantsBytes: number;
  quota: { hourBytes: number; dayBytes: number; minuteUploads: number; maxPending: number; perMinute: number; bytesPerHour: number; bytesPerDay: number };
}
export type ServerState = { stats: ServerStats | null; error: 'unavailable' | 'offline' | null };

const SERVER_MS = 2000;

let users = 0;
let stats: Item | null = null;
let main: MainMetrics | null = null;
let server: ServerState = { stats: null, error: null };
const logM = new Mirror();
let logList: Item[] = [];
let logVersion = 0;
let closers: (() => void)[] = [];
let serverWanted = false;
let serverTimer: ReturnType<typeof setTimeout> | null = null;
let serverGen = 0;

type Topic = 'stats' | 'log' | 'main' | 'server';
const subs: Record<Topic, Set<() => void>> = { stats: new Set(), log: new Set(), main: new Set(), server: new Set() };
const emit = (t: Topic) => { for (const fn of subs[t]) fn(); };

/** Открыть раздел (счётчик: повторное открытие не дублирует подписки). Возвращает закрытие. */
export function openDevSession(): () => void {
  if (users++ === 0) {
    serverStopped = false;   // новое открытие раздела — сервер спросим снова
    const sm = new Mirror();
    const ws = watchDev({ kind: 'devStats' }, (p) => { sm.apply(p); stats = sm.list()[0] ?? null; emit('stats'); });
    logM.items.clear(); logM.order = []; logList = [];
    const wl = watchDev({ kind: 'devLog', since: 0 }, (p) => {
      logM.apply(p);
      logList = logM.list();
      logVersion++;
      // ошибки движка, err-кадры, отказы очереди — во «Ошибки» (курсор по id: повторов не будет)
      ingestLogErrors((p.op === 'snapshot' ? p.items : p.upsert) as never);
      emit('log');
    });
    const stopMain = startMetrics((m) => { main = m; emit('main'); });
    const vis = () => pumpServer();
    document.addEventListener('visibilitychange', vis);
    closers = [() => ws.close(), () => wl.close(), stopMain, () => document.removeEventListener('visibilitychange', vis)];
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--users > 0) return;
    for (const c of closers) c();
    closers = [];
    setServerPolling(false);
    stats = null; main = null; logList = []; logM.items.clear(); logM.order = [];
  };
}

/** Сервер опрашивается раз в 2 с, только пока видна вкладка «Обзор» и документ виден.
 *  404 (сервер без DEV_LOGIN) и 401 (сеанса нет) — опрос встаёт до следующего открытия раздела. */
export function setServerPolling(on: boolean): void {
  serverWanted = on;
  pumpServer();
}
let serverStopped = false;
/** Ответ сервера → что делать с опросом (чистая логика, для тестов). */
export function pollVerdict(status: number): 'ok' | 'stop' | 'retry' {
  if (status === 404 || status === 401) return 'stop';
  return status >= 200 && status < 300 ? 'ok' : 'retry';
}
function pumpServer(): void {
  const run = serverWanted && users > 0 && !serverStopped && document.visibilityState === 'visible';
  if (!run) { if (serverTimer) clearTimeout(serverTimer); serverTimer = null; serverGen++; return; }
  if (serverTimer) return;
  const gen = ++serverGen;
  const tick = async () => {
    try {
      const res = await fetch('/dev/stats', { credentials: 'include' });
      if (gen !== serverGen) return;
      const v = pollVerdict(res.status);
      if (v === 'stop') { serverStopped = true; server = { stats: null, error: 'unavailable' }; emit('server'); serverTimer = null; return; }
      const body = v === 'ok' ? (await res.json()) as ServerStats : null;
      if (gen !== serverGen) return;   // пока читали тело, опрос остановили
      server = { stats: body ?? server.stats, error: body ? null : 'offline' };
    } catch { if (gen !== serverGen) return; server = { stats: server.stats, error: 'offline' }; }
    emit('server');
    serverTimer = setTimeout(tick, SERVER_MS);
  };
  serverTimer = setTimeout(tick, 0);
}

export const devRunning = (): boolean => users > 0 || serverTimer !== null;

function useTopic<T>(t: Topic, get: () => T): T {
  const [, force] = useState(0);
  useEffect(() => { const fn = () => force((x) => x + 1); subs[t].add(fn); return () => { subs[t].delete(fn); }; }, []);
  return get();
}
export const useDevStats = (): Item | null => useTopic('stats', () => stats);
export const useMainMetrics = (): MainMetrics | null => useTopic('main', () => main);
export const useServerStats = (): ServerState => useTopic('server', () => server);
export const useDevLog = (): { list: Item[]; version: number } => useTopic('log', () => ({ list: logList, version: logVersion }));

/** Текущее состояние для «Скачать диагностику». */
export const devSnapshot = () => ({ stats, main, server: server.stats, log: logList });
