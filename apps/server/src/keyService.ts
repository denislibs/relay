// Сервис ключей (этап 9 плана шифрования): единственный процесс с доступом к KMS. server и worker не знают
// учётных данных KMS — они просят этот процесс завернуть или развернуть ключ чата/файла (RemoteKms в crypto/kms.ts).
// Зачем: взлом процесса, который смотрит в интернет, не даёт прямого доступа к главному ключу; каждое обращение
// видно в журнале аудита; массовая выгрузка ключей упирается в предел и поднимает тревогу.
//
//   POST /wrap   {dek}               → {wrapped, kekId}
//   POST /unwrap {wrapped, kekId?}   → {dek}
//   POST /stale  {wrapped}           → {stale}
//   POST /rewrap {wrapped}           → {wrapped, kekId}
//   GET  /info                       → {kekId}
// Байты — base64. Доступ — Bearer-токен клиента (KEY_SERVICE_TOKENS: «server:токен,worker:токен»); в продакшене —
// ещё и внутренняя сеть + mTLS (docker-compose.secure.yml). Запуск: bun apps/server/src/keyService.ts
import { getKms, kmsFor, type Kms } from './crypto/kms';
import { assertTransportSecure } from './tls';
import { auditKeyFromEnv, createAuditChain } from './auditLog';

export interface KeyServiceOptions {
  port: number;
  kms?: () => Kms;
  /** KMS по kek_id (прежний главный ключ при смене); по умолчанию — crypto/kms.ts kmsFor */
  kmsFor?: (kekId: string | null) => Kms;
  /** токен → имя клиента */
  tokens: Map<string, string>;
  /** развёртываний на клиента в минуту, сверх — 429 и тревога в журнале */
  unwrapPerMinute?: number;
  audit?: (entry: Record<string, unknown>) => void;
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const bytes = (s: unknown) => (typeof s === 'string' ? new Uint8Array(Buffer.from(s, 'base64')) : null);

export function parseTokens(raw = process.env.KEY_SERVICE_TOKENS ?? ''): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i > 0 && part.length - i > 16) m.set(part.slice(i + 1), part.slice(0, i));   // токен короче 16 символов не принимаем
  }
  return m;
}

export function createKeyService(o: KeyServiceOptions) {
  const kms = o.kms ?? getKms;
  const byKek = o.kmsFor ?? ((id: string | null) => kmsFor(id));
  const limit = o.unwrapPerMinute ?? 6000;
  // по умолчанию — цепочка с HMAC (auditLog.ts): файл KEY_SERVICE_AUDIT_FILE и stdout
  const chain = o.audit ? null : createAuditChain({ key: auditKeyFromEnv(), file: process.env.KEY_SERVICE_AUDIT_FILE || undefined });
  const audit = o.audit ?? ((e: Record<string, unknown>) => { chain!.append(e); });
  const windows = new Map<string, { start: number; n: number; alarmed: boolean }>();

  /** Счёт развёртываний клиента за минуту; превышение — отказ и одна тревога на окно. */
  function allow(client: string, n = 1): boolean {
    const now = Date.now();
    let w = windows.get(client);
    if (!w || now - w.start >= 60_000) { w = { start: now, n: 0, alarmed: false }; windows.set(client, w); }
    w.n += n;
    if (w.n <= limit) return true;
    if (!w.alarmed) { w.alarmed = true; audit({ alarm: 'unwrap-rate', client, count: w.n, limit }); }
    return false;
  }

  // TLS сервиса ключей (production): сертификат из KEY_SERVICE_TLS_CERT/KEY; клиенты доверяют внутреннему CA
  const tls = process.env.KEY_SERVICE_TLS_CERT && process.env.KEY_SERVICE_TLS_KEY
    ? { cert: Bun.file(process.env.KEY_SERVICE_TLS_CERT), key: Bun.file(process.env.KEY_SERVICE_TLS_KEY) } : undefined;
  return Bun.serve({
    port: o.port,
    ...(tls ? { tls } : {}),
    async fetch(req) {
      const url = new URL(req.url);
      const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
      const client = token ? o.tokens.get(token) : undefined;
      if (!client) { audit({ denied: url.pathname, reason: 'token' }); return new Response('unauthorized', { status: 401 }); }
      if (req.method === 'GET' && url.pathname === '/info') return Response.json({ kekId: kms().id });
      if (req.method !== 'POST') return new Response('not found', { status: 404 });
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      try {
        switch (url.pathname) {
          case '/wrap': {
            const dek = bytes(body?.dek);
            if (!dek || dek.length !== 32) return new Response('bad dek', { status: 400 });
            const k = kms();
            audit({ client, op: 'wrap' });
            return Response.json({ wrapped: b64(await k.wrap(dek)), kekId: k.id });
          }
          case '/unwrap': {
            const wrapped = bytes(body?.wrapped);
            if (!wrapped) return new Response('bad wrapped', { status: 400 });
            if (!allow(client)) return new Response('rate limited', { status: 429 });
            audit({ client, op: 'unwrap' });
            return Response.json({ dek: b64(await byKek(typeof body?.kekId === 'string' ? body.kekId : null).unwrap(wrapped)) });
          }
          case '/stale': {
            const wrapped = bytes(body?.wrapped);
            if (!wrapped) return new Response('bad wrapped', { status: 400 });
            return Response.json({ stale: (await kms().stale?.(wrapped)) ?? false });
          }
          case '/rewrap': {
            const wrapped = bytes(body?.wrapped);
            if (!wrapped) return new Response('bad wrapped', { status: 400 });
            const k = kms();
            audit({ client, op: 'rewrap' });
            const kekId = typeof body?.kekId === 'string' ? body.kekId : null;
            const next = kekId === k.id && k.rewrap ? await k.rewrap(wrapped) : await k.wrap(await byKek(kekId).unwrap(wrapped));
            return Response.json({ wrapped: b64(next), kekId: k.id });
          }
        }
        return new Response('not found', { status: 404 });
      } catch (e) {
        audit({ client, op: url.pathname.slice(1), error: String(e) });
        return new Response('kms error', { status: 502 });
      }
    },
  });
}

if (import.meta.main) {
  assertTransportSecure();
  const tokens = parseTokens();
  if (!tokens.size) throw new Error('KEY_SERVICE_TOKENS is empty: set "server:<token>,worker:<token>"');
  const chain = createAuditChain({ key: auditKeyFromEnv(), file: process.env.KEY_SERVICE_AUDIT_FILE || undefined });
  const s = createKeyService({ port: Number(process.env.KEY_SERVICE_PORT ?? 7800), tokens, unwrapPerMinute: Number(process.env.KEY_SERVICE_UNWRAP_PER_MIN) || undefined, audit: (e) => { chain.append(e); } });
  chain.append({ event: 'start', kms: getKms().id });
  // «жив» раз в минуту: обрезанный хвост журнала виден по разрыву во времени, а голова цепочки — в собранных логах
  setInterval(() => chain.append({ event: 'heartbeat' }), 60_000).unref();
  console.log(`relay key service on :${s.port} (kms: ${getKms().id}, clients: ${[...tokens.values()].join(', ')})`);
}
