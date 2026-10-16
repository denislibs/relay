import type { Server } from 'bun';
import { createSession, createUser, readSessionToken, sessionCookie, userIdFromToken } from './auth';
import { createChat, getHistory, listChats } from './domain/chats';
import { DomainError } from './domain/errors';

const STATUS: Record<string, number> = { bad_frame: 400, too_long: 400, unauthorized: 401, not_member: 403, not_found: 404 };
const fail = (code: string) => Response.json({ code }, { status: STATUS[code] ?? 500 });

export type WsData = { userId: number };

export function createServer(opts: { port: number }): Server {
  return Bun.serve<WsData>({
    port: opts.port,
    async fetch(req, server) {
      const url = new URL(req.url);
      try {
        if (url.pathname === '/health') return Response.json({ ok: true });

        if (process.env.DEV_LOGIN === '1' && req.method === 'POST' && url.pathname === '/dev/login') {
          const { name } = (await req.json()) as { name: string };
          const userId = await createUser(String(name ?? 'user'));
          const token = await createSession(userId);
          return Response.json({ userId, token }, { headers: { 'set-cookie': sessionCookie(token) } });
        }

        const userId = await userIdFromToken(readSessionToken(req));
        if (!userId) return fail('unauthorized');

        if (url.pathname === '/ws') {
          return server.upgrade(req, { data: { userId } }) ? undefined : fail('bad_frame');
        }
        if (process.env.DEV_LOGIN === '1' && req.method === 'POST' && url.pathname === '/dev/chats') {
          const { kind, title, memberIds } = (await req.json()) as { kind: 'direct' | 'group'; title: string | null; memberIds: number[] };
          const ids = memberIds.includes(userId) ? memberIds : [userId, ...memberIds];
          return Response.json({ id: await createChat(kind, title, ids) });
        }
        if (req.method === 'GET' && url.pathname === '/chats') {
          return Response.json(await listChats(userId));
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
      message() {},
    },
  });
}
