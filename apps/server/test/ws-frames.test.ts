import { parseClientFrame } from '@relay/protocol';
import { beforeEach, expect, test } from 'bun:test';
import { handleFrame } from '../src/ws';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

test('parseClientFrame accepts valid frames and rejects junk', () => {
  expect(parseClientFrame('{"op":"sync","since":3}')).toEqual({ op: 'sync', since: 3 });
  expect(parseClientFrame('{"op":"sync","since":"3"}')).toBeNull();
  expect(parseClientFrame('{"op":"send","reqId":"r","clientId":"x","chatId":1,"body":"hi"}')).toBeNull(); // clientId не uuid
  expect(parseClientFrame('not json')).toBeNull();
  expect(parseClientFrame('{"op":"drop_tables"}')).toBeNull();
});

test('send → ack, then sync returns the newMessage and hello reports seq', async () => {
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const clientId = crypto.randomUUID();
  const [ack] = await handleFrame(a, { op: 'send', reqId: 'r1', clientId, chatId: chat, body: 'привет' });
  expect(ack).toMatchObject({ op: 'ack', reqId: 'r1', result: { clientId, duplicate: false } });

  const [upd] = await handleFrame(b, { op: 'sync', since: 0 });
  expect(upd).toMatchObject({ op: 'updates', from: 0, to: 1, more: false });
  expect((upd as { items: { update: { type: string } }[] }).items[0].update.type).toBe('newMessage');

  expect(await handleFrame(b, { op: 'hello', lastSeq: 0 })).toEqual([{ op: 'hello', seq: 1, epoch: expect.any(String) }]); // epoch — поколение базы
});

test('domain errors are not retryable, ping answers pong', async () => {
  const a = await makeUser(), b = await makeUser(), c = await makeUser();
  const chat = await makeChat([a, b]);
  const res = await handleFrame(c, { op: 'send', reqId: 'r', clientId: crypto.randomUUID(), chatId: chat, body: 'x' });
  expect(res).toEqual([{ op: 'err', reqId: 'r', code: 'not_member', retry: false }]);
  expect(await handleFrame(a, { op: 'ping' })).toEqual([{ op: 'pong' }]);
});
