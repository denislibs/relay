import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { sendMessage } from '../src/domain/messages';
import { deleteDirectChat, getHistory, openDirect } from '../src/domain/chats';
import { chatKey, currentChatKey, resetChatKeyCache } from '../src/crypto/chatKeys';
import { startKeyEvents } from '../src/crypto/keyEvents';
import { FakeKms, getKms, rewrapStep, setKms, VaultKms } from '../src/crypto/kms';
import { randomKey } from '../src/crypto/aead';
import { makeChat, makeUser, opened, resetDb } from './helpers';

beforeEach(async () => { await resetDb(); setKms(null); delete process.env.RELAY_MASTER_KEY_PREVIOUS; delete process.env.RELAY_MASTER_KEY; });

const send = (u: number, chatId: number, body: string) => sendMessage(u, { chatId, clientId: crypto.randomUUID(), body });

test('«delete for both» destroys the past for real: old key versions are gone, old ciphers cannot be opened; new messages work', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await openDirect(a, b);
  const old = (await send(a, chat, 'было')).message;
  await deleteDirectChat(a, chat, true);
  const versions = (await sql`select version from keys.chat_keys where chat_id = ${chat}`).map((r) => r.version);
  expect(versions).toEqual([2]);
  resetChatKeyCache();
  const [row] = await sql`select * from messages where id = ${old.id}`;
  // строка остаётся только для нумерации: удалена и пуста, а ключа к прежнему шифру нет (shred.ts)
  expect(row).toMatchObject({ deleted: true, content: null, attachment: null, body: '' });
  await expect(chatKey(chat, 1)).rejects.toMatchObject({ code: 'no_key' });
  const fresh = (await send(b, chat, 'заново')).message;
  expect((await getHistory(a, chat, null, 10)).messages.map((m) => m.body)).toEqual(['заново']);
  expect(fresh.body).toBe('заново');
});

test('a deleted chat key is forgotten in every process at once (NOTIFY chat_keys), not after the cache TTL', async () => {
  const stop = await startKeyEvents();
  try {
    const chat = await makeChat([await makeUser('a'), await makeUser('b')]);
    await currentChatKey(chat);
    await chatKey(chat, 1);   // в памяти этого процесса
    await sql`delete from keys.chat_keys where chat_id = ${chat}`;   // «другой процесс» уничтожил ключ
    for (let i = 0; i < 50; i++) {
      if (await chatKey(chat, 1).then(() => false, () => true)) break;
      await Bun.sleep(20);
    }
    await expect(chatKey(chat, 1)).rejects.toMatchObject({ code: 'no_key' });
  } finally { await stop(); }
});

test('master key rotation (fake KMS): old keys open with the previous key until crypto.rewrap rewraps them; data is untouched', async () => {
  const A = Buffer.from(randomKey()).toString('base64'), B = Buffer.from(randomKey()).toString('base64');
  process.env.RELAY_MASTER_KEY = A; setKms(null);
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const m = (await send(a, chat, 'до смены ключа')).message;
  const kekA = getKms().id;
  const content = (await sql`select content from messages where id = ${m.id}`)[0].content;
  // новый главный ключ, прежний — ещё доступен
  process.env.RELAY_MASTER_KEY = B; process.env.RELAY_MASTER_KEY_PREVIOUS = A; setKms(null); resetChatKeyCache();
  expect(getKms().id).not.toBe(kekA);
  expect((await getHistory(b, chat, null, 10)).messages[0].body).toBe('до смены ключа');
  const r = await rewrapStep(sql);
  expect(r).toMatchObject({ rewrapped: 1, done: true });
  expect((await sql`select kek_id from keys.chat_keys`).map((x) => x.kek_id)).toEqual([getKms().id]);
  // прежний ключ больше не нужен
  delete process.env.RELAY_MASTER_KEY_PREVIOUS; setKms(null); resetChatKeyCache();
  expect((await getHistory(b, chat, null, 10)).messages[0].body).toBe('до смены ключа');
  expect(Buffer.from((await sql`select content from messages where id = ${m.id}`)[0].content).equals(Buffer.from(content))).toBe(true);
  expect((await rewrapStep(sql)).rewrapped).toBe(0);
});

test('master key rotation in Vault/OpenBao: stale wrappings are rewrapped by Vault itself (the chat key never leaves it)', async () => {
  const addr = process.env.VAULT_TEST_ADDR, token = process.env.VAULT_TEST_TOKEN;
  if (!addr || !token) { console.warn('kms service is not running — skipped'); return; }
  const call = (path: string, body: unknown = {}) => fetch(`${addr}/v1/${path}`, { method: 'POST', headers: { 'x-vault-token': token }, body: JSON.stringify(body) }).catch(() => null);
  if (!(await call('sys/mounts/transit', { type: 'transit' }))) { console.warn('kms service is not running — skipped'); return; }
  const name = 'relay-test-rotate-' + Date.now();
  await call(`transit/keys/${name}`, { type: 'aes256-gcm96' });
  setKms(new VaultKms(addr, token, name));
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  await send(a, chat, 'через Vault');
  const before = new TextDecoder().decode((await sql`select wrapped_dek from keys.chat_keys`)[0].wrapped_dek);
  expect(before.startsWith('vault:v1:')).toBe(true);
  await call(`transit/keys/${name}/rotate`);
  const kms = new VaultKms(addr, token, name); setKms(kms);
  expect((await rewrapStep(sql)).rewrapped).toBe(1);
  const after = new TextDecoder().decode((await sql`select wrapped_dek from keys.chat_keys`)[0].wrapped_dek);
  expect(after.startsWith('vault:v2:')).toBe(true);
  resetChatKeyCache();
  expect((await getHistory(b, chat, null, 10)).messages[0].body).toBe('через Vault');
});
