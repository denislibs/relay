import { parseClientFrame } from '@relay/protocol';
import type { Server } from 'bun';
import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { createSession, createUser, readSessionToken, sessionCookie, userIdFromToken } from './auth';
import { createChat, getHistory, listChats, listChatsPage } from './domain/chats';
import { sql } from './db';
import { DomainError } from './domain/errors';
import { connected, disconnected, listPresence, type Publish } from './domain/presence';
import { handleFrame } from './ws';

const STATUS: Record<string, number> = { bad_frame: 400, too_long: 400, unauthorized: 401, not_member: 403, not_found: 404 };
const fail = (code: string) => Response.json({ code }, { status: STATUS[code] ?? 500 });

export type WsData = { userId: number };

const API = /^\/(health|me|chats|presence|ws|dev)(\/|$)/;

/** Статика клиента из WEB_DIST. Путь не может выйти за папку; пути без расширения — SPA, отдаём index.html. */
function serveStatic(pathname: string): Response {
  const dist = resolve(process.env.WEB_DIST ?? join(import.meta.dir, '..', '..', 'web', 'dist'));
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return new Response('Bad request', { status: 400 }); }
  const file = resolve(dist, '.' + (decoded === '/' ? '/index.html' : decoded));
  const inside = file === dist || file.startsWith(dist + sep);
  if (inside && existsSync(file) && statSync(file).isFile()) {
    const res = new Response(Bun.file(file));
    // имена файлов без хэша: браузер обязан перепроверять (ETag/Last-Modified), иначе после сборки держит старый CSS/JS
    res.headers.set('cache-control', 'no-cache');
    return res;
  }
  if (!extname(decoded) && existsSync(join(dist, 'index.html'))) {
    return new Response(Bun.file(join(dist, 'index.html')), { headers: { 'cache-control': 'no-cache' } });
  }
  return new Response('Not found', { status: 404 });
}

export function createServer(opts: { port: number }): Server {
  const publish: Publish = (topic, msg) => { server.publish(topic, msg); };
  const server = Bun.serve<WsData>({
    port: opts.port,
    async fetch(req, server) {
      const url = new URL(req.url);
      try {
        if (url.pathname === '/health') return Response.json({ ok: true });
        if ((req.method === 'GET' || req.method === 'HEAD') && !API.test(url.pathname)) return serveStatic(url.pathname);

        if (process.env.DEV_LOGIN === '1' && req.method === 'POST' && url.pathname === '/dev/login') {
          const { name } = (await req.json()) as { name: string };
          // dev: вход по имени — существующий пользователь (в т.ч. из сида) или новый
          const [found] = await sql`select id from users where name = ${String(name ?? '')} order by id limit 1`;
          const userId = found ? (found.id as number) : await createUser(String(name ?? 'user'));
          const token = await createSession(userId);
          return Response.json({ userId, token }, { headers: { 'set-cookie': sessionCookie(token) } });
        }

        const userId = await userIdFromToken(readSessionToken(req));
        if (!userId) return fail('unauthorized');

        if (req.method === 'GET' && url.pathname === '/me') {
          const [u] = await sql`select id, name from users where id = ${userId}`;
          return Response.json({ userId: u.id, name: u.name });
        }
        if (url.pathname === '/ws') {
          return server.upgrade(req, { data: { userId } }) ? undefined : fail('bad_frame');
        }
        if (process.env.DEV_LOGIN === '1' && req.method === 'POST' && url.pathname === '/dev/chats') {
          const { kind, title, memberIds } = (await req.json()) as { kind: 'direct' | 'group'; title: string | null; memberIds: number[] };
          const ids = memberIds.includes(userId) ? memberIds : [userId, ...memberIds];
          return Response.json({ id: await createChat(kind, title, ids) });
        }
        if (req.method === 'GET' && url.pathname === '/presence') {
          return Response.json(await listPresence(userId));
        }
        if (req.method === 'GET' && url.pathname === '/chats/page') {
          // страница диалогов: ?limit=100&beforeAt=ISO&beforeId=N (курсор из предыдущей страницы)
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 500);
          const at = url.searchParams.get('beforeAt'), id = url.searchParams.get('beforeId');
          return Response.json(await listChatsPage(userId, limit, at && id ? { at, id: Number(id) } : undefined));
        }
        if (req.method === 'GET' && url.pathname === '/chats') {
          // ?ids=1,2,3 — конкретные чаты; ?unread=1 — все с непрочитанными; без параметров — весь список
          const ids = url.searchParams.get('ids');
          return Response.json(await listChats(userId, {
            ids: ids ? ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500) : undefined,
            unreadOnly: url.searchParams.get('unread') === '1',
          }));
        }
        const hist = /^\/chats\/(\d+)\/messages$/.exec(url.pathname);
        if (req.method === 'GET' && hist) {
          const before = url.searchParams.get('before');
          const limit = Number(url.searchParams.get('limit') ?? 50);
          return Response.json(await getHistory(userId, Number(hist[1]), before ? Number(before) : null, limit));
        }
        return new Response('Not found', { status: 404 });
      } catch (err) {
        if (err instanceof DomainError) return fail(err.code);
        console.error(err);
        return fail('internal');
      }
    },
    websocket: {
      open(ws) {
        ws.subscribe(`user:${ws.data.userId}`);
        connected(publish, ws.data.userId).catch((err) => console.error('presence:', err));
      },
      close(ws) {
        disconnected(publish, ws.data.userId);
      },
      async message(ws, raw) {
        const frame = parseClientFrame(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
        if (!frame) {
          ws.send(JSON.stringify({ op: 'err', code: 'bad_frame', retry: false }));
          return;
        }
        for (const out of await handleFrame(ws.data.userId, frame)) ws.send(JSON.stringify(out));
      },
    },
  });
  return server;
}
