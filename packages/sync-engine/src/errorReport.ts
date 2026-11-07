// Отчёты об ошибках на сервер (POST /client-errors, docs/observability.md): страница, SharedWorker движка и
// звонки шлют сюда то, что иначе видно только в консоли пользователя. Сервер считает их по источнику и сборке —
// канарейка сравнивает сборки и по ошибкам клиентов.
//
// Дёшево и безопасно для пользователя: пачка раз в FLUSH_MS, одинаковые ошибки склеиваются со счётчиком, за жизнь
// страницы (воркера) — не больше MAX_SENT записей, сообщение и стек обрезаны. Ошибка отправки — молча: отчёт не
// должен порождать новые ошибки.

export type ReportSource = 'window' | 'promise' | 'worker' | 'engine' | 'host' | 'op' | 'call' | 'groupCall';
export interface ReportItem { source: ReportSource; message: string; stack?: string; count: number }

const FLUSH_MS = 5000;
const MAX_BATCH = 10;
/** записей за жизнь страницы: зацикленная ошибка не шлёт отчёт вечно */
const MAX_SENT = 50;
const MSG_MAX = 300;
const STACK_MAX = 1500;

type Post = (url: string, body: string, keepalive: boolean) => Promise<unknown>;
const defaultPost: Post = (url, body, keepalive) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive, credentials: 'same-origin' });

export interface ErrorReporter {
  report(source: ReportSource, message: unknown, stack?: unknown): void;
  /** каким путём соединился звонок: direct — напрямую, relay — через TURN */
  callPath(kind: 'p2p' | 'group', path: 'direct' | 'relay'): void;
  /** отправить накопленное сейчас (pagehide) */
  flush(keepalive?: boolean): void;
}

export function createErrorReporter(opts: { build: string; post?: Post; flushMs?: number; maxSent?: number; base?: string }): ErrorReporter {
  const post = opts.post ?? defaultPost;
  const base = opts.base ?? '';
  const maxSent = opts.maxSent ?? MAX_SENT;
  let pending: ReportItem[] = [];
  let paths: { kind: 'p2p' | 'group'; path: 'direct' | 'relay' }[] = [];
  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const send = (url: string, body: object, keepalive: boolean) => {
    try { void post(base + url, JSON.stringify({ build: opts.build, ...body }), keepalive).catch(() => {}); } catch { /* без сети — и ладно */ }
  };
  const flush = (keepalive = false) => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending.length) { send('/client-errors', { errors: pending.slice(0, MAX_BATCH) }, keepalive); pending = pending.slice(MAX_BATCH); }
    if (paths.length) { send('/client-stats', { calls: paths }, keepalive); paths = []; }
    if (pending.length) schedule();
  };
  const schedule = () => { timer ??= setTimeout(() => flush(), opts.flushMs ?? FLUSH_MS); };

  return {
    report(source, message, stack) {
      const msg = String(message ?? 'Error').slice(0, MSG_MAX);
      const st = typeof stack === 'string' && stack ? stack.slice(0, STACK_MAX) : undefined;
      const same = pending.find((p) => p.source === source && p.message === msg);
      if (same) { same.count++; return; }
      if (sent >= maxSent) return;
      sent++;
      pending.push({ source, message: msg, ...(st ? { stack: st } : {}), count: 1 });
      schedule();
    },
    callPath(kind, path) { paths.push({ kind, path }); schedule(); },
    flush,
  };
}

/** Необработанные ошибки и отказы промисов глобального объекта (окно или воркер) — в отчёт. */
export function reportUncaught(scope: { addEventListener(type: string, fn: (e: Event) => void): void }, r: ErrorReporter, sources: { error: ReportSource; rejection: ReportSource }): void {
  scope.addEventListener('error', (ev) => {
    const e = ev as ErrorEvent;
    if (!e.message && !e.error) return;   // ошибка загрузки ресурса (img, script) — не ошибка кода
    const err = e.error as { stack?: unknown } | undefined;
    r.report(sources.error, e.message || String(e.error), typeof err?.stack === 'string' ? err.stack : e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined);
  });
  scope.addEventListener('unhandledrejection', (ev) => {
    const reason = (ev as PromiseRejectionEvent).reason as { message?: unknown; stack?: unknown } | undefined;
    r.report(sources.rejection, reason && typeof reason === 'object' && 'message' in reason ? String(reason.message) : String(reason), reason?.stack);
  });
}
