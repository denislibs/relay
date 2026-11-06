import { expect, test } from 'bun:test';
import { CallCryptoError, commitOf, deriveSession, EMOJI, ephemeral, fromB64u, toB64u, type Ephemeral } from './callCrypto';

const callId = '7b0e4a4e-3f1f-4b55-9a51-6d4a0d8f2c11';

async function pair(opts: { pubAForCallee?: string; pubBForCaller?: string; commit?: string } = {}) {
  const a = await ephemeral(), b = await ephemeral();
  const commit = opts.commit ?? await commitOf(callId, a.pub);
  const caller = await deriveSession({ role: 'caller', callId, caller: 1, callee: 2, commit, pubA: a.pub, pubB: opts.pubBForCaller ?? b.pub, mine: a });
  const callee = await deriveSession({ role: 'callee', callId, caller: 1, callee: 2, commit, pubA: opts.pubAForCallee ?? a.pub, pubB: b.pub, mine: b });
  return { a, b, caller, callee };
}

test('both sides get the same 4 emoji and talk both ways', async () => {
  const { caller, callee } = await pair();
  expect(caller.emoji).toHaveLength(4);
  expect(callee.emoji).toEqual(caller.emoji);
  const offer = { description: { type: 'offer', sdp: 'v=0\r\n…' } };
  expect(await callee.open(await caller.seal(offer))).toEqual(offer);
  expect(await caller.open(await callee.seal({ candidate: 'x' }))).toEqual({ candidate: 'x' });
});

test('own direction cannot be reflected back, replays and tampering are rejected', async () => {
  const { caller, callee } = await pair();
  const m = await caller.seal({ n: 1 });
  expect(await caller.open(m)).toBeNull();   // своё же отражённое — другой ключ и направление
  expect(await callee.open(m)).toEqual({ n: 1 });
  expect(await callee.open(m)).toBeNull();   // повтор
  const bytes = fromB64u(await caller.seal({ n: 2 }))!;
  bytes[bytes.length - 1] ^= 1;
  expect(await callee.open(toB64u(bytes))).toBeNull();   // подмена шифротекста
  expect(await callee.open('###')).toBeNull();
  // перестановка в пределах окна — принимается
  const m3 = await caller.seal({ n: 3 }), m4 = await caller.seal({ n: 4 });
  expect(await callee.open(m4)).toEqual({ n: 4 });
  expect(await callee.open(m3)).toEqual({ n: 3 });
});

test('a server swapping keys in the middle is caught: commit check or different emoji', async () => {
  // сервер подменил ключ звонящего в callConfirm — обязательство не сходится
  const evil = await ephemeral();
  await expect(pair({ pubAForCallee: evil.pub })).rejects.toBeInstanceOf(CallCryptoError);

  // сервер подменил ключ адресата для звонящего (две «половины»: звонящий ↔ сервер ↔ адресат) — эмодзи разные
  const a = await ephemeral(), b = await ephemeral(), m: Ephemeral = await ephemeral();
  const commit = await commitOf(callId, a.pub);
  const callerSide = await deriveSession({ role: 'caller', callId, caller: 1, callee: 2, commit, pubA: a.pub, pubB: m.pub, mine: a });
  // чтобы говорить с адресатом, серверу нужен pubA под тем же commit — свой ключ он подставить не может, а с настоящим
  // pubA общего ключа с адресатом у него нет; лучшее, что он может, — свой commit адресату, тогда эмодзи расходятся
  const evilCommit = await commitOf(callId, m.pub);
  const calleeSide = await deriveSession({ role: 'callee', callId, caller: 1, callee: 2, commit: evilCommit, pubA: m.pub, pubB: b.pub, mine: b });
  expect(calleeSide.emoji).not.toEqual(callerSide.emoji);
  expect(await calleeSide.open(await callerSide.seal({ x: 1 }))).toBeNull();
});

test('bad peer keys are refused', async () => {
  const a = await ephemeral();
  const commit = await commitOf(callId, a.pub);
  await expect(deriveSession({ role: 'caller', callId, caller: 1, callee: 2, commit, pubA: a.pub, pubB: 'AAAA', mine: a })).rejects.toBeInstanceOf(CallCryptoError);
  const notOnCurve = toB64u(new Uint8Array(65).fill(4));
  await expect(deriveSession({ role: 'caller', callId, caller: 1, callee: 2, commit, pubA: a.pub, pubB: notOnCurve, mine: a })).rejects.toBeInstanceOf(CallCryptoError);
});

test('emoji table: 256 distinct single emoji', () => {
  expect(EMOJI).toHaveLength(256);
  expect(new Set(EMOJI).size).toBe(256);
});
