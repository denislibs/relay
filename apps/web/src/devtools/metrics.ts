// Раздел «Для разработчиков»: метрики главного потока и сбор ошибок.
// - метрики (FPS, long tasks, память, DOM-узлы, очередь кадра) считаются, только пока раздел открыт: startMetrics() → stop;
// - ошибки (window error, unhandledrejection, ошибки движка/хоста из журнала, err-кадры сервера, отказы очереди)
//   собираются всегда — в кольцо на 200 записей; это одна запись в массив на ошибку.

import { START, cursorAt, isAfter, type LogCursor } from './logCursor';
import { frameStats } from '@relay/ui';

// ---------- ошибки ----------

export type ErrorSource = 'window' | 'promise' | 'engine' | 'host' | 'server' | 'op';
export interface DevError { id: number; t: number; source: ErrorSource; message: string; stack: string | null; count: number }

export const ERRORS_CAP = 200;
const MSG_MAX = 300;
const STACK_LINES = 8;

let errors: DevError[] = [];
let errSeq = 0;
let errSeen = 0;
const errSubs = new Set<() => void>();

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Записать ошибку; повтор той же подряд — счётчик у прежней записи, а не новая строка. */
export function pushError(source: ErrorSource, message: string, stack?: string | null, t = Date.now()): void {
  const msg = cut(String(message || 'Ошибка'), MSG_MAX);
  const st = stack ? stack.split('\n').slice(0, STACK_LINES).join('\n') : null;
  const last = errors[errors.length - 1];
  if (last && last.source === source && last.message === msg && last.stack === st) {
    errors = errors.slice(0, -1).concat({ ...last, count: last.count + 1, t });
  } else {
    errors = errors.length >= ERRORS_CAP ? errors.slice(errors.length - ERRORS_CAP + 1) : errors.slice();
    errors.push({ id: ++errSeq, t, source, message: msg, stack: st, count: 1 });
  }
  for (const fn of errSubs) { try { fn(); } catch { /* подписчик не ломает сбор */ } }
}

export const getErrors = (): DevError[] => errors;
/** Новых с последнего просмотра вкладки «Ошибки». */
export const newErrorCount = (): number => errors.filter((e) => e.id > errSeen).length;
export function markErrorsSeen(): void { if (errSeen === errSeq) return; errSeen = errSeq; for (const fn of errSubs) fn(); }
export function subscribeErrors(fn: () => void): () => void { errSubs.add(fn); return () => { errSubs.delete(fn); }; }
export function clearErrors(): void { errors = []; errSeen = errSeq; for (const fn of errSubs) fn(); }

let installed = false;
/** Один раз при старте приложения. */
export function installErrorCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  addEventListener('error', (e: ErrorEvent) => {
    // ошибка загрузки ресурса (img/script) приходит без message — у неё свой путь (сеть), не считаем
    if (!e.message && !e.error) return;
    const err = e.error as { stack?: unknown } | undefined;
    pushError('window', e.message || String(e.error), typeof err?.stack === 'string' ? err.stack : e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null);
  });
  addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const r = e.reason as { message?: unknown; stack?: unknown } | undefined;
    pushError('promise', r && typeof r === 'object' && 'message' in r ? String(r.message) : String(e.reason), typeof r?.stack === 'string' ? r.stack : null);
  });
}

/** События журнала движка, которые считаем ошибками (журнал приходит, пока открыт раздел; в буфере движка — 2000 последних). */
let engineSeen: LogCursor = START;
export function ingestLogErrors(events: { id: number; ep?: string; t: number; kind: string; type: string; data: unknown }[]): void {
  for (const ev of events) {
    if (!isAfter(ev, engineSeen)) continue;
    engineSeen = cursorAt(ev);   // новая эпоха (перезапуск движка) — курсор начинается заново
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.kind === 'error') pushError(ev.type === 'host' ? 'host' : 'engine', `${ev.type}: ${String(d.message ?? '')}`, typeof d.stack === 'string' ? d.stack : null, ev.t);
    else if (ev.kind === 'ws-in' && ev.type === 'err') pushError('server', `err ${String(d.code ?? '')}${d.retry ? ' (повтор)' : ''}`, null, ev.t);
    else if (ev.kind === 'engine' && ev.type === 'opFail') pushError('op', `opFail ${String(d.key ?? '')} ${String(d.code ?? '')}`.trim(), null, ev.t);
  }
}

// ---------- метрики главного потока ----------

export interface MainMetrics {
  fps: number | null;
  longTasks: { count: number; maxMs: number } | null;   // null — PerformanceObserver('longtask') не поддерживается
  memory: { used: number; total: number; limit: number } | null;   // только Chromium
  domNodes: number;
  frame: { measures: number; mutations: number; heavy: boolean; deferred: number; waiting: number };
}

const WINDOW_MS = 60_000;
const DOM_MS = 5000;

let users = 0;
let rafId = 0;
let frames = 0;
let fpsFrom = 0;
let fps: number | null = null;
let tasks: { t: number; ms: number }[] = [];
let observer: PerformanceObserver | null = null;
let longTaskSupported = false;
let domNodes = 0;
let domTimer: ReturnType<typeof setInterval> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<(m: MainMetrics) => void>();

function loop(now: number): void {
  frames++;
  if (!fpsFrom) fpsFrom = now;
  else if (now - fpsFrom >= 1000) { fps = Math.round((frames * 1000) / (now - fpsFrom)); frames = 0; fpsFrom = now; }
  rafId = requestAnimationFrame(loop);
}

function countDom(): void { domNodes = document.getElementsByTagName('*').length; }

export function snapshot(): MainMetrics {
  const cutoff = performance.now() - WINDOW_MS;
  if (tasks.length && tasks[0].t < cutoff) tasks = tasks.filter((x) => x.t >= cutoff);
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const f = frameStats();
  return {
    fps,
    longTasks: longTaskSupported ? { count: tasks.length, maxMs: tasks.reduce((m, x) => Math.max(m, x.ms), 0) } : null,
    memory: mem ? { used: mem.usedJSHeapSize, total: mem.totalJSHeapSize, limit: mem.jsHeapSizeLimit } : null,
    domNodes,
    frame: { measures: f.measures, mutations: f.mutations, heavy: f.heavy, deferred: f.deferred, waiting: f.waiting },
  };
}

/** Пока есть хоть один подписчик — rAF-счётчик, наблюдатель long tasks, DOM раз в 5 с и снимок раз в секунду. */
export function startMetrics(onTick: (m: MainMetrics) => void): () => void {
  subs.add(onTick);
  if (users++ === 0) {
    frames = 0; fpsFrom = 0; fps = null; tasks = [];
    rafId = requestAnimationFrame(loop);
    try {
      observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) tasks.push({ t: e.startTime, ms: Math.round(e.duration) }); });
      observer.observe({ type: 'longtask', buffered: true });
      longTaskSupported = true;
    } catch { observer = null; longTaskSupported = false; }
    countDom();
    domTimer = setInterval(countDom, DOM_MS);
    tickTimer = setInterval(() => { const m = snapshot(); for (const fn of subs) fn(m); }, 1000);
  }
  onTick(snapshot());
  let done = false;
  return () => {
    if (done) return;
    done = true;
    subs.delete(onTick);
    if (--users > 0) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
    observer?.disconnect();
    observer = null;
    if (domTimer) clearInterval(domTimer);
    if (tickTimer) clearInterval(tickTimer);
    domTimer = tickTimer = null;
    tasks = [];
  };
}

/** Для проверки «раздел закрыт — ничего не работает». */
export const metricsRunning = (): boolean => users > 0 || rafId !== 0 || domTimer !== null || tickTimer !== null;
