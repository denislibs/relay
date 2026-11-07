import { expect, test } from 'bun:test';
import { loadSecretFiles } from '../src/secretFiles';

const files: Record<string, string> = { '/run/secrets/pg': 'p@ss/w:rd\n', '/run/secrets/vk': ' vkpass ', '/run/secrets/tg': '123:abc\n' };
const read = (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]!; };

test('secrets from *_FILE: read and trimmed; passwords go into DATABASE_URL / VALKEY_URL', () => {
  const env: Record<string, string | undefined> = {
    TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/tg',
    DATABASE_URL: 'postgres://relay@postgres:5432/relay', DATABASE_PASSWORD_FILE: '/run/secrets/pg',
    VALKEY_URL: 'rediss://valkey:6379', VALKEY_PASSWORD_FILE: '/run/secrets/vk',
  };
  loadSecretFiles(env, read);
  expect(env.TELEGRAM_BOT_TOKEN).toBe('123:abc');
  expect(new URL(env.DATABASE_URL!).username).toBe('relay');
  expect(decodeURIComponent(new URL(env.DATABASE_URL!).password)).toBe('p@ss/w:rd');
  expect(decodeURIComponent(new URL(env.VALKEY_URL!).password)).toBe('vkpass');
});

test('dev: plain values stay; unknown *_FILE (a path, not a secret) is left alone', () => {
  const env: Record<string, string | undefined> = { TELEGRAM_BOT_TOKEN: 'dev', KEY_SERVICE_AUDIT_FILE: '/var/log/relay-keys/audit.log', DATABASE_URL: 'postgres://relay:relay@db/relay' };
  loadSecretFiles(env, read);
  expect(env).toEqual({ TELEGRAM_BOT_TOKEN: 'dev', KEY_SERVICE_AUDIT_FILE: '/var/log/relay-keys/audit.log', DATABASE_URL: 'postgres://relay:relay@db/relay' });
});

test('misconfiguration fails loudly: both value and file, unreadable file, password twice', () => {
  expect(() => loadSecretFiles({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/tg' }, read)).toThrow('both set');
  expect(() => loadSecretFiles({ VAULT_TOKEN_FILE: '/run/secrets/missing' }, read)).toThrow('cannot read /run/secrets/missing');
  expect(() => loadSecretFiles({ DATABASE_URL: 'postgres://u:p@db/r', DATABASE_PASSWORD_FILE: '/run/secrets/pg' }, read)).toThrow('already has a password');
});
