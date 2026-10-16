import type { Server } from 'bun';

export function createServer(opts: { port: number }): Server {
  return Bun.serve({
    port: opts.port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return Response.json({ ok: true });
      return new Response('Not found', { status: 404 });
    },
  });
}
