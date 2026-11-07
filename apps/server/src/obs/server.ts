import type { Server } from 'bun';
import { renderMetrics, setProcessRole } from './metrics';
import { readyResponse } from './ready';
import { log, setLogProc } from './log';

/**
 * Внутренний порт процесса (METRICS_PORT, по умолчанию 9091): /metrics, /health, /ready. Не публикуется в
 * docker-compose и не проксируется nginx — его опрашивает только VictoriaMetrics из профиля observability
 * (deploy/docker-compose.observability.yml). METRICS_PORT=off — не открывать.
 */
export function startMetricsServer(opts: { role: 'server' | 'worker'; port?: number | string; hostname?: string } ): Server | null {
  setProcessRole(opts.role);
  setLogProc(opts.role);
  const raw = opts.port ?? process.env.METRICS_PORT ?? 9091;
  if (raw === 'off' || raw === '') return null;
  try {
    return serve(Number(raw), opts.hostname ?? process.env.METRICS_HOST ?? '0.0.0.0');
  } catch (e) {
    // порт занят (второй процесс в том же контейнере) — без метрик, но процесс работает
    log.warn('metrics port unavailable', { port: Number(raw), error: e });
    return null;
  }
}

function serve(port: number, hostname: string): Server {
  return Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
      if (pathname === '/metrics') return new Response(await renderMetrics(), { headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' } });
      if (pathname === '/health') return Response.json({ ok: true });
      if (pathname === '/ready') return readyResponse();
      return new Response('not found', { status: 404 });
    },
  });
}
