import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// deploy/make-secrets.sh выводит MEILI_SEARCH_KEY из мастер-ключа и uid ключа, а создаёт ключ с этим uid
// apps/server/src/dev/meiliKeys.ts (deploy.sh сверяет): uid в двух местах должен совпадать
test('MEILI_SEARCH_UID in deploy/make-secrets.sh matches UID in meiliKeys.ts', async () => {
  const env = /MEILI_SEARCH_UID=([0-9a-f-]+)/.exec(await Bun.file('deploy/make-secrets.sh').text())?.[1];
  const ts = /const UID = '([0-9a-f-]+)'/.exec(await Bun.file('apps/server/src/dev/meiliKeys.ts').text())?.[1];
  expect(env).toBeTruthy();
  expect(env).toBe(ts);
});

// --- проверка утечки секретов в deploy.sh (deploy/lib.sh: secrets_leak_check) ------------------------------------
// Вывод deploy.sh попадает в ПУБЛИЧНЫЙ лог GitHub Actions: печатать можно только имена из SECRET_NAMES — ни значения,
// ни имена посторонних файлов (по ошибке именем файла оказывался сам токен бота).

const FAKE_TOKEN = '987654321:AAFakeTokenLooking_Value-0123456789abcdef';   // не настоящий: только вид токена
const PG = 'pg-secret-value-0123456789abcdef';

function relayDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-leak-'));
  mkdirSync(join(dir, 'secrets', 'run'), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'secrets', 'run', name), body);
  return dir;
}
function check(dir: string, dump: string) {
  const dumpFile = join(dir, 'inspect.json');
  writeFileSync(dumpFile, dump); chmodSync(dumpFile, 0o600);
  const r = Bun.spawnSync(['sh', '-c', `. "${process.cwd()}/deploy/lib.sh" && secrets_leak_check "$1"`, 'sh', dumpFile],
    { env: { ...process.env, RELAY_DIR: dir, PATH: process.env.PATH! } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
const INSPECT = JSON.stringify([{ Config: { Env: ['NODE_ENV=production', 'DATABASE_PASSWORD_FILE=/run/secrets/pg_password'] } }]);

test('leak check: empty lines in a secret file are not patterns (no false leak), nothing secret printed', () => {
  const dir = relayDir({ pg_password: `\n${PG}\n\n`, telegram_bot_token: '\n', turn_secret: '   \n' });
  const r = check(dir, INSPECT);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain(PG);
});

test('leak check: a stray file named like a token fails the check and its name is never printed', () => {
  const dir = relayDir({ pg_password: `${PG}\n`, [FAKE_TOKEN]: '\n' });
  const r = check(dir, INSPECT);
  expect(r.code).toBe(2);
  expect(r.out).toContain('unexpected file');
  expect(r.out).not.toContain(FAKE_TOKEN);
  expect(r.out).not.toContain('987654321');
  expect(r.out).not.toContain(PG);
});

test('leak check: a real leak is reported by the known secret name only, never by value', () => {
  const dir = relayDir({ pg_password: `${PG}\n`, telegram_bot_token: `${FAKE_TOKEN}\n` });
  const leaked = JSON.stringify([{ Config: { Env: [`TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}`] } }]);
  const r = check(dir, leaked);
  expect(r.code).toBe(1);
  expect(r.out).toContain('telegram_bot_token');
  expect(r.out).not.toContain(FAKE_TOKEN);
  expect(r.out).not.toContain(PG);
});

test('set-secret.sh: an unknown name (maybe a pasted value) is refused and not echoed', () => {
  const dir = relayDir({ telegram_bot_token: '\n' });
  const r = Bun.spawnSync(['sh', 'deploy/set-secret.sh', FAKE_TOKEN], { env: { ...process.env, RELAY_DIR: dir }, stdin: new TextEncoder().encode('x\n') });
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout.toString() + r.stderr.toString()).not.toContain(FAKE_TOKEN);
  const ok = Bun.spawnSync(['sh', 'deploy/set-secret.sh', 'telegram_bot_token'], { env: { ...process.env, RELAY_DIR: dir }, stdin: new TextEncoder().encode(`  ${FAKE_TOKEN}  \n`) });
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString() + ok.stderr.toString()).not.toContain(FAKE_TOKEN);
  expect(readFileSync(join(dir, 'secrets', 'run', 'telegram_bot_token'), 'utf8')).toBe(`${FAKE_TOKEN}\n`);
});

test('one list of secret names: lib.sh SECRET_NAMES = make-secrets.sh = files in compose secrets: (+ host-only bao_backup_token)', async () => {
  const lib = /SECRET_NAMES="([^"]+)"/.exec(await Bun.file('deploy/lib.sh').text())![1]!.split(/\s+/).filter(Boolean).sort();
  const made = [...(await Bun.file('deploy/make-secrets.sh').text()).matchAll(/^secret ([a-z0-9_]+) /gm)].map((m) => m[1]!).sort();
  const compose = (await Bun.file('docker-compose.secure.yml').text()) + (await Bun.file('deploy/docker-compose.observability.yml').text());
  const mounted = [...new Set([...compose.matchAll(/file: \.\/secrets\/run\/([a-z0-9_]+)/g)].map((m) => m[1]!))].sort();
  expect(made).toEqual(lib);
  expect([...mounted, 'bao_backup_token'].sort()).toEqual(lib);
});
