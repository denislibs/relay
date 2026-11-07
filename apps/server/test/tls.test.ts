import { expect, test } from 'bun:test';
import { assertTransportSecure, dbSsl, valkeyTls } from '../src/tls';

test('database TLS from env: disable by default, require, verify-full with CA; sslmode in the URL counts', () => {
  expect(dbSsl({})).toBe(false);
  expect(dbSsl({ DB_SSL: 'require' })).toBe('require');
  expect(dbSsl({ DATABASE_URL: 'postgres://x@h/db?sslmode=require' })).toBe('require');
  expect(dbSsl({ DB_SSL: 'verify-full' })).toMatchObject({ rejectUnauthorized: true });
  expect(() => dbSsl({ DB_SSL: 'prefer' })).toThrow();
});

test('valkey TLS: only for rediss://', () => {
  expect(valkeyTls({ VALKEY_URL: 'redis://v:6379' })).toBeUndefined();
  expect(valkeyTls({ VALKEY_URL: 'rediss://v:6380' })).toBe(true);
});

test('production refuses plain internal connections and dev logins — no bypass', () => {
  const ok = { NODE_ENV: 'production', DB_SSL: 'verify-full', VALKEY_URL: 'rediss://v', S3_ENDPOINT: 'https://s3', MEILI_URL: 'https://m', KEY_SERVICE_URL: 'https://k' };
  expect(() => assertTransportSecure(ok)).not.toThrow();
  expect(() => assertTransportSecure({ ...ok, DB_SSL: 'require' })).toThrow(/database/);
  expect(() => assertTransportSecure({ ...ok, VALKEY_URL: 'redis://v' })).toThrow(/valkey/);
  expect(() => assertTransportSecure({ ...ok, MEILI_URL: 'http://m' })).toThrow(/MEILI_URL/);
  // обхода больше нет: RELAY_PLAIN_INTERNAL и dev-входы в production — отказ (INFRA-1, INFRA-6)
  expect(() => assertTransportSecure({ ...ok, RELAY_PLAIN_INTERNAL: '1' })).toThrow('RELAY_PLAIN_INTERNAL');
  expect(() => assertTransportSecure({ ...ok, DEV_LOGIN: '1' })).toThrow('DEV_LOGIN');
  expect(() => assertTransportSecure({ ...ok, LOG_LOGIN_CODES: '1' })).toThrow('LOG_LOGIN_CODES');
  expect(() => assertTransportSecure({ DB_SSL: 'disable' })).not.toThrow();   // dev
});

test('production without a database (key service): no database check; a plain DATABASE_URL is still refused', () => {
  const keys = { NODE_ENV: 'production', KMS_PROVIDER: 'vault', VAULT_ADDR: 'https://openbao:8200' };
  expect(() => assertTransportSecure(keys)).not.toThrow();
  expect(() => assertTransportSecure({ ...keys, VAULT_ADDR: 'http://openbao:8200' })).toThrow('VAULT_ADDR');
  expect(() => assertTransportSecure({ ...keys, DATABASE_URL: 'postgres://u:p@db/relay' })).toThrow(/database/);
});

test('production code delivery: telegram only with a token and an owner chat id; dev and log channels refused', () => {
  const ok = { NODE_ENV: 'production', DB_SSL: 'verify-full', VALKEY_URL: 'rediss://v', S3_ENDPOINT: 'https://s3', MEILI_URL: 'https://m', KEY_SERVICE_URL: 'https://k' };
  const tg = { ...ok, CODE_DELIVERY: 'telegram', TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_OWNER_CHAT_ID: '12345' };
  expect(() => assertTransportSecure(tg)).not.toThrow();
  expect(() => assertTransportSecure({ ...tg, TELEGRAM_BOT_TOKEN: '' })).toThrow('TELEGRAM_BOT_TOKEN');
  expect(() => assertTransportSecure({ ...tg, TELEGRAM_OWNER_CHAT_ID: undefined })).toThrow('TELEGRAM_OWNER_CHAT_ID');
  expect(() => assertTransportSecure({ ...tg, TELEGRAM_OWNER_CHAT_ID: '@owner' })).toThrow('TELEGRAM_OWNER_CHAT_ID');
  expect(() => assertTransportSecure({ ...tg, TELEGRAM_API_URL: 'http://mock' })).toThrow('TELEGRAM_API_URL');
  expect(() => assertTransportSecure({ ...ok, CODE_DELIVERY: 'log' })).toThrow('CODE_DELIVERY=log');
  expect(() => assertTransportSecure({ ...ok, CODE_DELIVERY: 'dev' })).toThrow('CODE_DELIVERY=dev');
  expect(() => assertTransportSecure({ ...ok, CODE_DELIVERY: 'sms' })).toThrow('CODE_DELIVERY must be');
  // а dev-флаги по-прежнему отказ, даже рядом с telegram
  expect(() => assertTransportSecure({ ...tg, LOG_LOGIN_CODES: '1' })).toThrow('LOG_LOGIN_CODES');
});

test('production «Войти через Telegram»: bot name and token; webhook only https with a secret header', () => {
  const ok = { NODE_ENV: 'production', DB_SSL: 'verify-full', VALKEY_URL: 'rediss://v', S3_ENDPOINT: 'https://s3', MEILI_URL: 'https://m', KEY_SERVICE_URL: 'https://k' };
  const tg = { ...ok, TELEGRAM_LOGIN: '1', TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_BOT_USERNAME: 'denigram_bot' };
  expect(() => assertTransportSecure(tg)).not.toThrow();   // без webhook — опрос getUpdates
  expect(() => assertTransportSecure({ ...tg, TELEGRAM_BOT_USERNAME: '@denigram_bot' })).toThrow('TELEGRAM_BOT_USERNAME');
  expect(() => assertTransportSecure({ ...tg, TELEGRAM_BOT_TOKEN: undefined })).toThrow('TELEGRAM_BOT_TOKEN');
  const hook = { ...tg, TELEGRAM_WEBHOOK_URL: 'https://denigram.site/auth/telegram/webhook', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(32) };
  expect(() => assertTransportSecure(hook)).not.toThrow();
  expect(() => assertTransportSecure({ ...hook, TELEGRAM_WEBHOOK_SECRET: 'short' })).toThrow('TELEGRAM_WEBHOOK_SECRET');
  expect(() => assertTransportSecure({ ...hook, TELEGRAM_WEBHOOK_URL: 'http://denigram.site/x' })).toThrow('TELEGRAM_WEBHOOK_URL');
  expect(() => assertTransportSecure({ ...ok, TELEGRAM_LOGIN: '0' })).not.toThrow();
});
