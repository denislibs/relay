import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECRET_VARS } from '../../apps/server/src/secretFiles';

// Боевой стек (docker-compose.yml + secure + deploy/…prod.yml): секреты — только файлами (docker secrets). Ни одной
// секретной переменной в environment (её видно в `docker inspect`), ни пароля в адресах базы и Valkey.
// Значения из .env подставляются в конфиг — здесь они несекретные, как на сервере (.env.example).
const SECRET_ENV = [...SECRET_VARS, 'POSTGRES_PASSWORD', 'LIVEKIT_KEYS', 'VALKEY_PASSWORD'];
const hasDocker = Bun.spawnSync(['docker', 'compose', 'version']).exitCode === 0;

test.skipIf(!hasDocker)('production compose: no secret in environment, no password in URLs, secrets mounted as files', () => {
  const env = join(mkdtempSync(join(tmpdir(), 'relay-compose-')), '.env');
  writeFileSync(env, [
    'RELAY_DOMAIN=example.test', 'S3_PUBLIC_ENDPOINT=https://example.test:8333', 'RELAY_TURN_HOST=turn.example.test',
    'RELAY_TURN_EXTERNAL_IP=192.0.2.1', 'LIVEKIT_NODE_IP=192.0.2.1', 'VAULT_ADDR=https://openbao:8200',
    'TELEGRAM_OWNER_CHAT_ID=1', 'RELAY_TAG=0123456789abcdef',
  ].join('\n'));
  const r = Bun.spawnSync(['docker', 'compose', '--project-directory', '.', '--env-file', env, '-f', 'docker-compose.yml',
    '-f', 'docker-compose.secure.yml', '-f', 'deploy/docker-compose.prod.yml', 'config', '--format', 'json', '--no-path-resolution']);
  expect(r.stderr.toString()).not.toContain('error');
  const services = JSON.parse(r.stdout.toString()).services as Record<string, { environment?: Record<string, string>; command?: string[]; secrets?: unknown[] }>;
  const leaks: string[] = [];
  for (const [name, s] of Object.entries(services)) {
    for (const k of SECRET_ENV) if (s.environment && k in s.environment) leaks.push(`${name}: environment ${k}`);
    for (const k of ['DATABASE_URL', 'VALKEY_URL']) {
      const v = s.environment?.[k];
      if (v && new URL(v).password) leaks.push(`${name}: password in ${k}`);
    }
    if ((s.command ?? []).some((a) => /secret|password|requirepass|auth-secret/i.test(a) && !a.includes('/run/secrets/'))) leaks.push(`${name}: secret-looking command argument`);
  }
  expect(leaks).toEqual([]);
  // кому что: секреты смонтированы тем, кто их читает
  const has = (svc: string, secret: string) => (services[svc]?.secrets ?? []).some((x) => (typeof x === 'string' ? x : (x as { source: string }).source) === secret);
  expect(has('server', 'pg_password') && has('worker', 'meili_master_key') && has('keys', 'vault_token')).toBe(true);
  expect(has('server', 'meili_master_key') || has('server', 'vault_token') || has('worker', 'vault_token')).toBe(false);
});
