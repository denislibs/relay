import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { startMetricsServer } from '../src/obs/server';
import { counter, gauge, histogram, renderMetrics, BUILD_ID } from '../src/obs/metrics';
import { checks, resetReadinessCache } from '../src/obs/ready';
import { log, setLogSink } from '../src/obs/log';
import { PER_IP_MIN, MAX_BODY, scrub } from '../src/obs/clientReports';
import { createKeyService, parseTokens } from '../src/keyService';
import { FakeKms } from '../src/crypto/kms';
import { enqueue } from '../src/jobs/queue';
import { drainJobs } from '../src/jobs/worker';
import { collectQueueMetrics } from '../src/obs/jobsMetrics';
import { sql } from '../src/db';
import { resetDb } from './helpers';

const server = createServer({ port: 0 });
const metrics = startMetricsServer({ role: 'server', port: 0, hostname: '127.0.0.1' })!;
const base = `http://localhost:${server.port}`;
const mbase = `http://127.0.0.1:${metrics.port}`;
collectQueueMetrics();
afterAll(() => { server.stop(true); metrics.stop(true); });
beforeEach(async () => { await resetDb(); resetReadinessCache(); });

const scrape = async () => {
  const res = await fetch(`${mbase}/metrics`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  return res.text();
};
/** значение серии: имя и метки (подстроки), сумма по совпавшим строкам */
function value(text: string, name: string, ...labels: string[]): number {
  let sum = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name + '{') || !labels.every((l) => line.includes(l))) continue;
    sum += Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return sum;
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('the registry renders counters, gauges and histograms in the Prometheus text format, every series labelled with the build', async () => {
  const c = counter('relay_test_things_total', 'Тест'), g = gauge('relay_test_level', 'Тест'), h = histogram('relay_test_seconds', 'Тест', [0.1, 1]);
  c.inc({ kind: 'a' }); c.inc({ kind: 'a' }, 2); c.inc({ kind: 'b"x' });
  g.set({}, 7);
  h.observe({ route: 'r' }, 0.05); h.observe({ route: 'r' }, 0.5); h.observe({ route: 'r' }, 5);
  const text = await renderMetrics();
  expect(text).toContain('# TYPE relay_test_things_total counter');
  expect(text).toContain(`relay_test_things_total{build="${BUILD_ID}",kind="a"} 3`);
  expect(text).toContain(`relay_test_things_total{build="${BUILD_ID}",kind="b\\"x"} 1`);   // кавычка в метке экранирована
  expect(text).toContain(`relay_test_level{build="${BUILD_ID}"} 7`);
  expect(text).toContain(`relay_test_seconds_bucket{build="${BUILD_ID}",route="r",le="0.1"} 1`);
  expect(text).toContain(`relay_test_seconds_bucket{build="${BUILD_ID}",route="r",le="1"} 2`);
  expect(text).toContain(`relay_test_seconds_bucket{build="${BUILD_ID}",route="r",le="+Inf"} 3`);
  expect(text).toContain(`relay_test_seconds_count{build="${BUILD_ID}",route="r"} 3`);
  for (const line of text.split('\n')) if (line && !line.startsWith('#')) expect(line).toContain(`build="${BUILD_ID}"`);
});

test('/metrics counts HTTP requests by route group and status, with latency; requests carry an x-request-id', async () => {
  const before = await scrape();
  const res = await fetch(`${base}/chats`);   // без сеанса — 401
  expect(res.status).toBe(401);
  expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  const own = await fetch(`${base}/health`, { headers: { 'x-request-id': 'nginx-req-12345678' } });
  expect(own.headers.get('x-request-id')).toBe('nginx-req-12345678');   // id от nginx сохраняется
  const after = await scrape();
  expect(value(after, 'relay_http_requests_total', 'route="chats"', 'status="401"') - value(before, 'relay_http_requests_total', 'route="chats"', 'status="401"')).toBe(1);
  expect(value(after, 'relay_http_request_duration_seconds_count', 'route="chats"')).toBeGreaterThanOrEqual(1);
  expect(value(after, 'relay_build_info', 'proc="server"')).toBe(1);
  expect(value(after, 'relay_process_memory_bytes', 'kind="rss"')).toBeGreaterThan(0);
  // имена путей с id не становятся метками
  await fetch(`${base}/no-such-thing/123`);
  expect(await scrape()).not.toContain('no-such-thing');
});

test('/metrics is not served on the public port (nginx routes everything there)', async () => {
  const res = await fetch(`${base}/metrics`);
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain('relay_');
});

test('/ready checks Postgres, Valkey and the KMS; a failed dependency is 503 and relay_dependency_up 0', async () => {
  const ok = await fetch(`${base}/ready`);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true, checks: { postgres: true, valkey: true, kms: true } });
  expect((await fetch(`${mbase}/ready`)).status).toBe(200);

  const real = checks.valkey;
  checks.valkey = async () => { throw new Error('connection refused'); };
  resetReadinessCache();
  try {
    const bad = await fetch(`${base}/ready`);
    expect(bad.status).toBe(503);
    expect(((await bad.json()) as { checks: Record<string, boolean> }).checks).toEqual({ postgres: true, valkey: false, kms: true });
    expect((await fetch(`${base}/health`)).status).toBe(200);   // жив, но не готов
    resetReadinessCache();
    const text = await scrape();
    expect(value(text, 'relay_dependency_up', 'dep="valkey"')).toBe(0);
    expect(value(text, 'relay_dependency_up', 'dep="postgres"')).toBe(1);
  } finally { checks.valkey = real; resetReadinessCache(); }
});

test('the key service answers /ready without a token: 503 while the KMS (OpenBao) is sealed', async () => {
  let sealed = false;
  const kms = Object.assign(new FakeKms(), { ready: async () => !sealed });
  const svc = createKeyService({ port: 0, kms: () => kms, tokens: parseTokens('server:server-token-0123456789abcdef'), audit: () => {} });
  try {
    const url = `http://localhost:${svc.port}`;
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/ready`)).status).toBe(200);
    sealed = true;
    const r = await fetch(`${url}/ready`);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false });   // ничего, кроме «не готов»
    expect((await fetch(`${url}/info`)).status).toBe(401);   // остальное — по-прежнему с токеном
  } finally { svc.stop(true); }
});

test('WebSocket: open connections and frames by op and result are counted', async () => {
  const { token } = (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name: 'metrics' }) })).json()) as { token: string };
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { cookie: `relay_session=${token}` } } as never);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const err = new Promise<string>((r) => { ws.onmessage = (e) => { const f = JSON.parse(String(e.data)); if (f.op === 'err') r(f.code); }; });
  ws.send('not json');
  expect(await err).toBe('bad_frame');
  ws.send(JSON.stringify({ op: 'typing', chatId: 999999 }));   // чужой чат — молча, ответа нет
  await Bun.sleep(150);
  const text = await scrape();
  expect(value(text, 'relay_ws_connections')).toBeGreaterThanOrEqual(1);
  expect(value(text, 'relay_ws_frames_total', 'op="unknown"', 'result="bad_frame"')).toBeGreaterThanOrEqual(1);
  expect(value(text, 'relay_ws_frames_total', 'op="typing"', 'result="ok"')).toBeGreaterThanOrEqual(1);
  ws.close();
});

test('POST /client-errors counts errors by source and client build and logs them without query strings or tokens', async () => {
  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  try {
    const before = await scrape();
    const res = await post('/client-errors', { build: 'abc123', errors: [
      { source: 'window', message: 'TypeError: x is undefined at https://relay/join/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789?sig=secret', stack: 'at f (main-abc.js:1:2)', count: 3 },
      { source: 'call', message: 'ICE failed' },
      { source: 'evil<script>', message: 'x' },
    ] });
    expect(res.status).toBe(204);
    const after = await scrape();
    const d = (src: string) => value(after, 'relay_client_errors_total', `source="${src}"`, 'client_build="abc123"') - value(before, 'relay_client_errors_total', `source="${src}"`, 'client_build="abc123"');
    expect(d('window')).toBe(3);
    expect(d('call')).toBe(1);
    expect(d('other')).toBe(1);   // неизвестный источник — other, а не новая метка
    const logged = lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'client error');
    expect(logged).toHaveLength(3);
    expect(logged[0]).toMatchObject({ level: 'warn', build: BUILD_ID, clientBuild: 'abc123', source: 'window', count: 3 });
    expect(logged[0].reqId).toBeString();
    expect(JSON.stringify(logged)).not.toContain('secret');
    expect(JSON.stringify(logged)).not.toContain('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  } finally { restore(); }
});

test('POST /client-errors is size-capped, validated and rate-limited per IP', async () => {
  expect((await post('/client-errors', 'x'.repeat(MAX_BODY + 1))).status).toBe(413);
  expect((await post('/client-errors', '{not json')).status).toBe(400);
  expect((await post('/client-errors', { errors: 'nope' })).status).toBe(400);
  // поток без Content-Length тоже обрывается на пределе
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode('x'.repeat(1024))); c.close(); } });
  expect((await fetch(`${base}/client-errors`, { method: 'POST', body: stream })).status).toBe(413);
  let last = 0;
  for (let i = 0; i < PER_IP_MIN + 2; i++) last = (await post('/client-errors', { errors: [] })).status;
  expect(last).toBe(429);
  expect(value(await scrape(), 'relay_client_reports_dropped_total', 'reason="rate"')).toBeGreaterThanOrEqual(1);
});

test('POST /client-stats counts call paths (direct vs relayed via TURN) as reported by clients', async () => {
  const before = await scrape();
  expect((await post('/client-stats', { build: 'abc123', calls: [{ kind: 'p2p', path: 'relay' }, { kind: 'p2p', path: 'direct' }, { kind: 'p2p', path: 'bogus' }] })).status).toBe(204);
  const after = await scrape();
  const d = (p: string) => value(after, 'relay_call_paths_total', 'kind="p2p"', `path="${p}"`) - value(before, 'relay_call_paths_total', 'kind="p2p"', `path="${p}"`);
  expect(d('relay')).toBe(1);
  expect(d('direct')).toBe(1);
  expect(after).not.toContain('bogus');
});

test('jobs: failures by kind and queue depth are exported', async () => {
  await enqueue(sql, 'no.such.kind', { secret: 'do-not-log' });
  await enqueue(sql, 'no.such.kind', {}, { runAt: new Date(Date.now() - 60_000) });
  let text = await scrape();
  expect(value(text, 'relay_jobs_ready', 'kind="no.such.kind"')).toBe(2);
  expect(value(text, 'relay_jobs_lag_seconds', 'kind="no.such.kind"')).toBeGreaterThanOrEqual(59);
  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  try { await drainJobs(); } finally { restore(); }
  text = await scrape();
  expect(value(text, 'relay_jobs_processed_total', 'kind="no.such.kind"', 'result="dead"')).toBeGreaterThanOrEqual(2);
  expect(value(text, 'relay_jobs_dead', 'kind="no.such.kind"')).toBe(2);
  expect(value(text, 'relay_jobs_ready', 'kind="no.such.kind"')).toBe(0);
  expect(lines.join('\n')).toContain('job failed permanently');
  expect(lines.join('\n')).not.toContain('do-not-log');
});

test('structured logs: one JSON line with build and process, secrets dropped by field name', () => {
  const lines: string[] = [];
  const restore = setLogSink((l) => lines.push(l));
  try {
    log.info('login code sent', { userId: 7, reqId: 'r1', code: '123456', token: 't', phone: '+79990000000', password: 'p', route: 'auth' });
    log.error('boom', { error: new Error('bad thing') });
  } finally { restore(); }
  const [a, b] = lines.map((l) => JSON.parse(l));
  expect(a).toMatchObject({ level: 'info', msg: 'login code sent', build: BUILD_ID, userId: 7, reqId: 'r1', route: 'auth' });
  expect(a.ts).toBeString();
  for (const k of ['code', 'token', 'phone', 'password']) expect(a).not.toHaveProperty(k);
  expect(b).toMatchObject({ level: 'error', err: 'bad thing', errName: 'Error' });
});

test('scrub strips query strings and long tokens from client text', () => {
  expect(scrub('GET https://x/y?token=abc&sig=1 failed', 100)).toBe('GET https://x/y?… failed');
  expect(scrub('invite AbCdEfGhIjKlMnOpQrStUvWxYz012345 bad', 100)).toBe('invite :tok bad');
  expect(scrub('x '.repeat(500), 10)).toHaveLength(10);
});
