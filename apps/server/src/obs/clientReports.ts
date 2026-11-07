import type { Server } from 'bun';
import { authenticate } from '../auth';
import { clientIp } from '../device';
import { hit } from '../valkey';
import { callPaths, clientErrors, clientReportsDropped } from './appMetrics';
import type { ReqCtx } from './httpObs';
import { log } from './log';
import { BUILD_ID } from './metrics';

/**
 * Отчёты клиентов (docs/observability.md, «Ошибки клиентов»):
 *   POST /client-errors {build, errors: [{source, message, stack?, count?}]} — window.onerror, unhandledrejection,
 *        SharedWorker движка, сбои звонков (ICE failed, LiveKit не подключился);
 *   POST /client-stats  {build, calls: [{kind: 'p2p' | 'group', path: 'direct' | 'relay'}]} — каким путём пошёл звонок.
 * Принимаются и до входа (ошибка экрана входа), поэтому — предел на IP, размер тела и число записей; сверх —
 * 429/413 без разбора. В лог — сообщение и начало стека без длинных токенов и строк запроса; в метрики — только
 * источник и сборка клиента.
 */
export const MAX_BODY = 16 * 1024;
const MAX_ERRORS = 10;
const MAX_CALLS = 5;
/** отчётов с одного IP в минуту */
export const PER_IP_MIN = 20;
/** строк ошибок клиентов в лог в минуту на процесс: поток одинаковых ошибок не забивает лог */
const LOG_PER_MIN = 300;

const SOURCES = new Set(['window', 'promise', 'worker', 'engine', 'host', 'op', 'call', 'groupCall']);
const BUILD = /^[A-Za-z0-9._-]{1,40}$/;
/** сборок клиента в метке — не больше стольких на процесс (первые увиденные), остальные — other: метку не раздуть */
const MAX_BUILDS = 8;
const builds = new Set<string>([BUILD_ID]);   // своя сборка — всегда своей меткой
function buildLabel(b: unknown): string {
  if (typeof b !== 'string' || !BUILD.test(b)) return 'unknown';
  if (builds.has(b)) return b;
  if (builds.size >= MAX_BUILDS) return 'other';
  builds.add(b);
  return b;
}

let logWindow = { at: 0, n: 0 };
function logAllowed(now = Date.now()): boolean {
  if (now - logWindow.at >= 60_000) logWindow = { at: now, n: 0 };
  return ++logWindow.n <= LOG_PER_MIN;
}

/** Текст от клиента для лога: без строк запроса и длинных токенов (ссылки-приглашения, подписи S3), обрезан. */
export function scrub(s: unknown, max: number): string {
  return String(s ?? '')
    .replace(/\?[^\s)'"]*/g, '?…')
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, ':tok')
    .slice(0, max);
}

/** Тело не больше max байт; Content-Length не верим — читаем поток и обрываем на пределе. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const len = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(len) && len > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const drop = (reason: 'rate' | 'size' | 'bad', status: number) => { clientReportsDropped.inc({ reason }); return new Response(null, { status }); };

export async function clientReport(req: Request, path: string, server: Server, ctx: ReqCtx): Promise<Response> {
  const ip = clientIp(req, server) ?? 'unknown';
  if ((await hit(`client-report:${ip}`, 60)) > PER_IP_MIN) return drop('rate', 429);
  const text = await readCapped(req, MAX_BODY);
  if (text === null) return drop('size', 413);
  let body: { build?: unknown; errors?: unknown; calls?: unknown };
  try { body = JSON.parse(text); } catch { return drop('bad', 400); }
  if (!body || typeof body !== 'object') return drop('bad', 400);
  const clientBuild = buildLabel(body.build);

  if (path === '/client-stats') {
    if (!Array.isArray(body.calls)) return drop('bad', 400);
    for (const c of body.calls.slice(0, MAX_CALLS) as { kind?: unknown; path?: unknown }[]) {
      const kind = c?.kind === 'p2p' || c?.kind === 'group' ? c.kind : null;
      const p = c?.path === 'direct' || c?.path === 'relay' ? c.path : null;
      if (kind && p) callPaths.inc({ kind, path: p, client_build: clientBuild });
    }
    return new Response(null, { status: 204 });
  }

  if (!Array.isArray(body.errors)) return drop('bad', 400);
  // кто прислал — если вошёл (для поиска по логам); не вошёл — тоже принимаем
  const auth = await authenticate(req).catch(() => null);
  ctx.userId = auth && auth !== 'refresh' ? auth.userId : undefined;
  for (const e of body.errors.slice(0, MAX_ERRORS) as { source?: unknown; message?: unknown; stack?: unknown; count?: unknown }[]) {
    if (!e || typeof e !== 'object') continue;
    const source = typeof e.source === 'string' && SOURCES.has(e.source) ? e.source : 'other';
    const count = Math.min(1000, Math.max(1, Math.floor(Number(e.count) || 1)));
    clientErrors.inc({ source, client_build: clientBuild }, count);
    if (logAllowed()) {
      log.warn('client error', { reqId: ctx.reqId, userId: ctx.userId, clientBuild, source, message: scrub(e.message, 300), stack: e.stack ? scrub(e.stack, 1500) : undefined, count });
    }
  }
  return new Response(null, { status: 204 });
}
