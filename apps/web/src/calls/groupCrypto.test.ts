import { expect, test } from 'bun:test';
import { ephemeral } from './callCrypto';
import { membersEmoji, openSenderKey, sealSenderKey, senderKey } from './groupCrypto';

const callId = '0d7c6b0e-1a2b-4c3d-8e9f-001122334455';

test('a sender key reaches exactly its addressee for this call and epoch', async () => {
  const a = await ephemeral(), b = await ephemeral(), c = await ephemeral();
  const key = senderKey();
  const data = await sealSenderKey({ mine: a, theirPub: b.pub, callId, epoch: 3, from: 1, to: 2, key });
  expect(await openSenderKey({ mine: b, theirPub: a.pub, callId, epoch: 3, from: 1, to: 2, data })).toEqual(key);
  // третьему — не прочитать; другая эпоха, другой адресат, другой звонок — тоже
  expect(await openSenderKey({ mine: c, theirPub: a.pub, callId, epoch: 3, from: 1, to: 2, data })).toBeNull();
  expect(await openSenderKey({ mine: b, theirPub: a.pub, callId, epoch: 4, from: 1, to: 2, data })).toBeNull();
  expect(await openSenderKey({ mine: b, theirPub: a.pub, callId, epoch: 3, from: 1, to: 3, data })).toBeNull();
  expect(await openSenderKey({ mine: b, theirPub: a.pub, callId: callId.replace('0d', '0e'), epoch: 3, from: 1, to: 2, data })).toBeNull();
});

test('a server swapping a public key cannot read the key, and the emoji differ', async () => {
  const a = await ephemeral(), b = await ephemeral(), evil = await ephemeral();
  const key = senderKey();
  // сервер подсунул Анне свой ключ вместо ключа Бориса: Анна шифрует для сервера, Борис не расшифрует
  const data = await sealSenderKey({ mine: a, theirPub: evil.pub, callId, epoch: 1, from: 1, to: 2, key });
  expect(await openSenderKey({ mine: b, theirPub: a.pub, callId, epoch: 1, from: 1, to: 2, data })).toBeNull();
  const seenByA = await membersEmoji(callId, [{ session: 1, pub: a.pub }, { session: 2, pub: evil.pub }]);
  const seenByB = await membersEmoji(callId, [{ session: 1, pub: a.pub }, { session: 2, pub: b.pub }]);
  expect(seenByA).not.toEqual(seenByB);
  // а без подмены порядок состава не важен
  expect(await membersEmoji(callId, [{ session: 2, pub: b.pub }, { session: 1, pub: a.pub }])).toEqual(seenByB);
});
