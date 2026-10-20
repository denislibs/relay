import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createKeyService, parseTokens } from '../src/keyService';
import { FakeKms, RemoteKms, rewrapStep, setKms } from '../src/crypto/kms';
import { randomKey } from '../src/crypto/aead';
import { resetChatKeyCache } from '../src/crypto/chatKeys';
import { sendMessage } from '../src/domain/messages';
import { getHistory } from '../src/domain/chats';
import { makeChat, makeUser, resetDb } from './helpers';

const audit: Record<string, unknown>[] = [];
const master = new FakeKms(Buffer.from(randomKey()).toString('base64'));
const SERVER = 'server-token-0123456789abcdef', WORKER = 'worker-token-0123456789abcdef';
const svc = createKeyService({ port: 0, kms: () => master, kmsFor: () => master, tokens: parseTokens(`server:${SERVER},worker:${WORKER},short:abc`), audit: (e) => audit.push(e) });
const url = `http://localhost:${svc.port}`;
afterAll(() => { svc.stop(true); setKms(null); });
beforeEach(async () => { await resetDb(); audit.length = 0; resetChatKeyCache(); setKms(null); });

test('server and worker reach the KMS only through the key service; every call is audited', async () => {
  setKms(new RemoteKms(url, SERVER));
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'через сервис ключей' });
  resetChatKeyCache();
  expect((await getHistory(b, chat, null, 10)).messages[0].body).toBe('через сервис ключей');
  expect((await sql`select kek_id from keys.chat_keys`)[0].kek_id).toBe(master.id);   // завёрнуто главным ключом сервиса
  const ops = audit.filter((e) => e.op).map((e) => `${e.client}:${e.op}`);
  expect(ops[0]).toBe('server:wrap');                     // ключ чата создан — один раз
  expect(ops.slice(1).every((o) => o === 'server:unwrap')).toBe(true);   // дальше только развёртывания, все записаны
});

test('without a valid token nothing is given; a short token is not accepted at all', async () => {
  expect(parseTokens('short:abc').size).toBe(0);
  setKms(new RemoteKms(url, 'wrong-token-0123456789abcdef'));
  const chat = await makeChat([await makeUser('a'), await makeUser('b')]);
  await expect(sendMessage((await sql`select id from users where name = 'a'`)[0].id, { chatId: chat, clientId: crypto.randomUUID(), body: 'x' })).rejects.toThrow();
  expect(audit.some((e) => e.denied && e.reason === 'token')).toBe(true);
});

test('a burst of unwraps beyond the limit is refused and raises one alarm (key dump attempt)', async () => {
  const strict = createKeyService({ port: 0, kms: () => master, kmsFor: () => master, tokens: parseTokens(`worker:${WORKER}`), unwrapPerMinute: 5, audit: (e) => audit.push(e) });
  try {
    const k = new RemoteKms(`http://localhost:${strict.port}`, WORKER);
    const w = await k.wrap(randomKey());
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => k.unwrap(w)));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(5);
    expect(audit.filter((e) => e.alarm === 'unwrap-rate')).toEqual([{ alarm: 'unwrap-rate', client: 'worker', count: 6, limit: 5 }]);
  } finally { strict.stop(true); }
});

test('master key change: the worker rewraps through the service, which alone knows the previous master key', async () => {
  const old = new FakeKms(Buffer.from(randomKey()).toString('base64'));
  const before = createKeyService({ port: 0, kms: () => old, kmsFor: () => old, tokens: parseTokens(`server:${SERVER}`), audit: () => {} });
  setKms(new RemoteKms(`http://localhost:${before.port}`, SERVER));
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'до смены' });
  before.stop(true);
  expect((await sql`select kek_id from keys.chat_keys`)[0].kek_id).toBe(old.id);
  // новый сервис: текущий — master, прежний old ему известен (у server/worker ключей нет вовсе)
  const after = createKeyService({ port: 0, kms: () => master, kmsFor: (id) => (id === old.id ? old : master), tokens: parseTokens(`worker:${WORKER}`), audit: (e) => audit.push(e) });
  try {
    setKms(new RemoteKms(`http://localhost:${after.port}`, WORKER)); resetChatKeyCache();
    expect(await rewrapStep(sql)).toMatchObject({ rewrapped: 1, done: true });
    expect((await sql`select kek_id from keys.chat_keys`)[0].kek_id).toBe(master.id);
    resetChatKeyCache();
    expect((await getHistory(b, chat, null, 10)).messages[0].body).toBe('до смены');
  } finally { after.stop(true); }
});
