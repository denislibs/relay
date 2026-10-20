// TLS между сервисами (этап 1 плана шифрования): Postgres, Valkey, а для HTTPS-клиентов (S3, Meilisearch,
// сервис ключей) — общий доверенный CA через NODE_EXTRA_CA_CERTS. В dev всё в одной docker-сети — без TLS;
// в production без TLS к базе и Valkey процесс не запускается (assertTransportSecure), если явно не сказано, что
// внутренняя сеть уже зашифрована (RELAY_PLAIN_INTERNAL=1: одна машина или WireGuard между хостами).
import { readFileSync } from 'node:fs';

type Env = Record<string, string | undefined>;
const file = (p: string | undefined) => (p ? readFileSync(p, 'utf8') : undefined);

/**
 * Опция ssl для postgres.js. DB_SSL: disable | require (шифрование без проверки сервера) | verify-full (проверка
 * сертификата и имени по DB_CA; DB_CERT/DB_KEY — клиентский сертификат: mTLS, база пускает только наш сервер).
 */
export function dbSsl(env: Env = process.env): false | 'require' | { ca?: string; cert?: string; key?: string; rejectUnauthorized: true; servername?: string } {
  const mode = env.DB_SSL ?? /[?&]sslmode=([\w-]+)/.exec(env.DATABASE_URL ?? '')?.[1] ?? 'disable';
  if (mode === 'disable') return false;
  if (mode === 'require') return 'require';
  if (mode !== 'verify-full') throw new Error(`DB_SSL must be disable, require or verify-full, not ${mode}`);
  return { ca: file(env.DB_CA), cert: file(env.DB_CERT), key: file(env.DB_KEY), rejectUnauthorized: true, ...(env.DB_SERVERNAME ? { servername: env.DB_SERVERNAME } : {}) };
}

/** Опция tls для клиента Valkey: rediss:// — TLS; VALKEY_CA (и VALKEY_CERT/KEY для mTLS) — свой CA. */
export function valkeyTls(env: Env = process.env): undefined | boolean | { ca?: string; cert?: string; key?: string; rejectUnauthorized: true } {
  if (!(env.VALKEY_URL ?? '').startsWith('rediss://')) return undefined;
  if (!env.VALKEY_CA && !env.VALKEY_CERT) return true;
  return { ca: file(env.VALKEY_CA), cert: file(env.VALKEY_CERT), key: file(env.VALKEY_KEY), rejectUnauthorized: true };
}

/** production: связь с базой и Valkey — только по TLS с проверкой сервера; S3/Meilisearch/сервис ключей — https. */
export function assertTransportSecure(env: Env = process.env): void {
  if (env.NODE_ENV !== 'production' || env.RELAY_PLAIN_INTERNAL === '1') return;
  const problems: string[] = [];
  const db = dbSsl(env);
  if (db === false || db === 'require') problems.push('database: DB_SSL=verify-full with DB_CA');
  if (env.VALKEY_URL && !env.VALKEY_URL.startsWith('rediss://')) problems.push('valkey: VALKEY_URL=rediss://…');
  for (const k of ['S3_ENDPOINT', 'MEILI_URL', 'KEY_SERVICE_URL', 'VAULT_ADDR']) {
    if (env[k] && !env[k]!.startsWith('https://')) problems.push(`${k}: https://…`);
  }
  if (problems.length) {
    throw new Error(`production refuses plain internal connections (set RELAY_PLAIN_INTERNAL=1 only if the network itself is encrypted):\n  - ${problems.join('\n  - ')}`);
  }
}
