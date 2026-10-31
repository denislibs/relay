import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { CryptoError, importAesKey, keyVersionOf, open, randomKey, seal } from '../src/crypto/aead';
import { chatKey, currentChatKey, forgetChat, resetChatKeyCache, rotateChatKey } from '../src/crypto/chatKeys';
import { FakeKms, getKms, setKms, type Kms } from '../src/crypto/kms';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(async () => { await resetDb(); resetChatKeyCache(); setKms(null); });

test('seal/open round-trip; the header carries format and key version; every seal has its own nonce', async () => {
  const key = await importAesKey(randomKey());
  const a = await seal(key, 7, 'привет', 'messages|1|2|body');
  const b = await seal(key, 7, 'привет', 'messages|1|2|body');
  expect(a[0]).toBe(1);
  expect(keyVersionOf(a)).toBe(7);
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  expect(await open(key, a, 'messages|1|2|body')).toBe('привет');
});

test('a cipher moved to another row or field, a wrong key or a flipped bit does not open', async () => {
  const key = await importAesKey(randomKey()), other = await importAesKey(randomKey());
  const s = await seal(key, 1, 'секрет', 'messages|1|2|body');
  await expect(open(key, s, 'messages|1|3|body')).rejects.toMatchObject({ code: 'tampered' });
  await expect(open(key, s, 'messages|1|2|caption')).rejects.toMatchObject({ code: 'tampered' });
  await expect(open(other, s, 'messages|1|2|body')).rejects.toMatchObject({ code: 'tampered' });
  const bad = new Uint8Array(s); bad[bad.length - 1] ^= 1;
  await expect(open(key, bad, 'messages|1|2|body')).rejects.toBeInstanceOf(CryptoError);
  await expect(open(key, new Uint8Array([9, 9, 9]), 'x')).rejects.toMatchObject({ code: 'bad_format' });
});

test('fake KMS wraps and unwraps; another master key cannot unwrap', async () => {
  const k1 = new FakeKms(Buffer.from(randomKey()).toString('base64')), k2 = new FakeKms(Buffer.from(randomKey()).toString('base64'));
  const dek = randomKey();
  const w = await k1.wrap(dek);
  expect(Buffer.from(await k1.unwrap(w)).equals(Buffer.from(dek))).toBe(true);
  expect(Buffer.from(w).includes(Buffer.from(dek))).toBe(false);
  await expect(k2.unwrap(w)).rejects.toBeInstanceOf(CryptoError);
});

/** KMS, который считает вызовы и может «упасть». */
function countingKms(): Kms & { wraps: number; unwraps: number; down: boolean } {
  const real = new FakeKms();
  const k = { id: real.id, wraps: 0, unwraps: 0, down: false,
    async wrap(d: Uint8Array) { if (k.down) throw new CryptoError('no_key', 'KMS down'); k.wraps++; return real.wrap(d); },
    async unwrap(w: Uint8Array) { if (k.down) throw new CryptoError('no_key', 'KMS down'); k.unwraps++; return real.unwrap(w); } };
  return k;
}

test('a chat key is created once, stored only wrapped, and served from memory afterwards', async () => {
  const kms = countingKms(); setKms(kms);
  const chat = await makeChat([await makeUser('a'), await makeUser('b')]);
  const [x, y] = await Promise.all([currentChatKey(chat), currentChatKey(chat)]);   // одновременно — один ключ
  expect(x.version).toBe(1);
  expect(x.key).toBe(y.key);
  const rows = await sql`select version, wrapped_dek, kek_id from keys.chat_keys where chat_id = ${chat}`;
  expect(rows.length).toBe(1);
  expect(rows[0].kek_id).toBe(getKms().id);
  expect(kms.wraps).toBe(1);
  const s = await seal(x.key, x.version, 'текст', 'm');
  resetChatKeyCache();
  expect(await open(await chatKey(chat, keyVersionOf(s)), s, 'm')).toBe('текст');   // из базы, через KMS
  const before = kms.unwraps;
  await chatKey(chat, 1); await chatKey(chat, 1);
  expect(kms.unwraps).toBe(before);   // дальше — из памяти
});

test('rotation: new writes use the new version, old ciphers still open with theirs', async () => {
  const chat = await makeChat([await makeUser('a'), await makeUser('b')]);
  const v1 = await currentChatKey(chat);
  const old = await seal(v1.key, v1.version, 'старое', 'm');
  expect(await rotateChatKey(chat)).toBe(2);
  const v2 = await currentChatKey(chat);
  expect(v2.version).toBe(2);
  expect(await open(await chatKey(chat, keyVersionOf(old)), old, 'm')).toBe('старое');
});

test('a deleted chat takes its keys with it: old ciphers can no longer be opened (crypto-shredding)', async () => {
  const chat = await makeChat([await makeUser('a'), await makeUser('b')]);
  const k = await currentChatKey(chat);
  const s = await seal(k.key, k.version, 'исчезнет', 'm');
  await sql`delete from chats where id = ${chat}`;
  forgetChat(chat);
  expect((await sql`select 1 from keys.chat_keys where chat_id = ${chat}`).length).toBe(0);
  await expect(chatKey(chat, keyVersionOf(s))).rejects.toMatchObject({ code: 'no_key' });
});

test('KMS down: a key already in memory still works, a cold one fails with a clear error', async () => {
  const kms = countingKms(); setKms(kms);
  const a = await makeChat([await makeUser('a'), await makeUser('b')]);
  const b = await makeChat([await makeUser('c'), await makeUser('d')]);
  await currentChatKey(a);
  kms.down = true;
  expect((await currentChatKey(a)).version).toBe(1);
  await expect(currentChatKey(b)).rejects.toMatchObject({ code: 'no_key' });
});

import { VaultKms } from '../src/crypto/kms';

/** Настоящий Vault/OpenBao (сервис kms в docker-compose): включить Transit и создать ключ — идемпотентно. */
async function vault(): Promise<{ addr: string; token: string } | null> {
  const addr = process.env.VAULT_TEST_ADDR, token = process.env.VAULT_TEST_TOKEN;
  if (!addr || !token) return null;
  const call = (path: string, body: unknown) => fetch(`${addr}/v1/${path}`, { method: 'POST', headers: { 'x-vault-token': token }, body: JSON.stringify(body) }).catch(() => null);
  const mounted = await call('sys/mounts/transit', { type: 'transit' });
  if (!mounted) return null;   // сервис не запущен
  await call('transit/keys/relay-test-chat-keys', { type: 'aes256-gcm96' });
  return { addr, token };
}

test('Vault/OpenBao Transit: the master key never leaves the KMS; wrapped keys round-trip and carry the key version', async () => {
  const v = await vault();
  if (!v) { console.warn('kms service is not running — Vault test skipped'); return; }
  const kms = new VaultKms(v.addr, v.token, 'relay-test-chat-keys');
  const dek = randomKey();
  const w = await kms.wrap(dek);
  expect(new TextDecoder().decode(w)).toMatch(/^vault:v\d+:/);
  expect(Buffer.from(await kms.unwrap(w)).equals(Buffer.from(dek))).toBe(true);
  // через тот же путь, что и сервер: ключ чата создаётся и разворачивается Vault-ом
  setKms(kms);
  const chat = await makeChat([await makeUser('a'), await makeUser('b')]);
  const k = await currentChatKey(chat);
  resetChatKeyCache();
  const s = await seal(k.key, k.version, 'через Vault', 'm');
  expect(await open(await chatKey(chat, 1), s, 'm')).toBe('через Vault');
  expect((await sql`select kek_id from keys.chat_keys where chat_id = ${chat}`)[0].kek_id).toBe('vault:transit/relay-test-chat-keys');
  await expect(new VaultKms(v.addr, 'wrong-token', 'relay-test-chat-keys').unwrap(w)).rejects.toMatchObject({ code: 'no_key' });
});

test('CRYPTO-5: a wrapped key is bound to its purpose — a file key the client knows cannot pass for a chat key; legacy keys get bound', async () => {
  const { bindKey, bindLegacyKeys, chatCtx, fileCtx, unbindKey, unwrapFor, wrapFor } = await import('../src/crypto/keyBinding');
  const { getKms } = await import('../src/crypto/kms');
  const kms = getKms();
  const known = crypto.getRandomValues(new Uint8Array(32));
  const asFile = await wrapFor(kms, fileCtx('11111111-1111-1111-1111-111111111111'), known);
  await expect(unwrapFor(chatCtx(5), asFile, kms.id)).rejects.toMatchObject({ code: 'no_key' });
  expect(await unwrapFor(fileCtx('11111111-1111-1111-1111-111111111111'), asFile, kms.id)).toEqual(known);
  await expect(unwrapFor(chatCtx(6), await wrapFor(kms, chatCtx(5), known), kms.id)).rejects.toMatchObject({ code: 'no_key' });   // и другой чат
  expect(unbindKey(chatCtx(5), bindKey(chatCtx(5), known))).toEqual({ dek: known, legacy: false });
  // старый блоб (голые 32 байта) читается и после задачи — уже с меткой
  const chat = await makeChat([await makeUser('a'), await makeUser('b')]);
  await sql`insert into keys.chat_keys (chat_id, version, wrapped_dek, kek_id, bound) values (${chat}, 1, ${Buffer.from(await kms.wrap(known))}, ${kms.id}, false)`;
  expect(await bindLegacyKeys(sql)).toBe(true);
  const [row] = await sql`select wrapped_dek, bound from keys.chat_keys where chat_id = ${chat}`;
  expect(row.bound).toBe(true);
  expect(unbindKey(chatCtx(chat), await kms.unwrap(new Uint8Array(row.wrapped_dek))).legacy).toBe(false);
  expect(await unwrapFor(chatCtx(chat), row.wrapped_dek, kms.id)).toEqual(known);
});
