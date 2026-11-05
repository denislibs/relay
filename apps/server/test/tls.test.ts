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
  expect(() => assertTransportSecure({ DB_SSL: 'disable' })).not.toThrow();   // dev
});
