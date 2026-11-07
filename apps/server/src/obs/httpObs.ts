import { httpDuration, httpRequests } from './appMetrics';
import { log } from './log';

/** Запрос в работе: id для логов (x-request-id) и пользователь, когда он известен (после authenticate). */
export interface ReqCtx { reqId: string; userId?: number; t0: number }

const REQ_ID = /^[A-Za-z0-9_.:-]{8,64}$/;
/** медленнее — строка в лог (warn) */
const SLOW_MS = 2000;

/** id запроса: от nginx/клиента (x-request-id), если он похож на id, иначе свой. */
export function requestCtx(req: Request): ReqCtx {
  const h = req.headers.get('x-request-id');
  return { reqId: h && REQ_ID.test(h) ? h : crypto.randomUUID(), t0: performance.now() };
}

const GROUP = /^\/([a-z-]+)(?:\/|$)/;
const KNOWN = new Set(['health', 'ready', 'me', 'users', 'contacts', 'settings', 'privacy', 'blocks', 'chats', 'presence', 'search', 'uploads', 'files', 'push',
  'calls', 'sessions', 'session', 'ws', 'dev', 'logout', 'auth', 'link-preview', 'groups', 'join', 'sticker-sets', 'my-stickers', 'my-gifs',
  'stickers-by-emoji', 'stickers', 'reactions', 'animated-emoji', 'emoji-groups', 'maptile', 'themes', 'client-errors', 'client-stats']);

/** Группа маршрута — первый сегмент пути из известного набора (метка с ограниченным числом значений). */
export function routeGroup(pathname: string): string {
  if (/^\/(stk|rx|emj)\//.test(pathname)) return 'static';
  const g = GROUP.exec(pathname)?.[1];
  return g && KNOWN.has(g) ? g : 'other';
}

/** Путь для лога: длинные токены (ссылки-приглашения, id загрузок) — заменены. */
export const logPath = (pathname: string) => pathname.replace(/[A-Za-z0-9_-]{16,}/g, ':tok').slice(0, 200);

/** Ответ готов: метрики, x-request-id, строка в лог для 5xx и медленных. undefined — WebSocket принят (101). */
export function finishRequest(req: Request, url: URL, ctx: ReqCtx, res: Response | undefined): Response | undefined {
  const status = res ? res.status : 101;
  const route = routeGroup(url.pathname);
  const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(req.method) ? req.method : 'OTHER';
  const sec = (performance.now() - ctx.t0) / 1000;
  httpRequests.inc({ route, method, status });
  httpDuration.observe({ route }, sec);
  if (res) { try { res.headers.set('x-request-id', ctx.reqId); } catch { /* неизменяемые заголовки */ } }
  if (status >= 500 || sec * 1000 >= SLOW_MS) {
    log.warn(status >= 500 ? 'http 5xx' : 'http slow', { reqId: ctx.reqId, userId: ctx.userId, method, route, path: logPath(url.pathname), status, ms: Math.round(sec * 1000) });
  }
  return res;
}
