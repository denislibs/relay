import { expect, test } from 'bun:test';
import { EngineClient, fallbackPort } from '../src/client';
import type { FromHost, PortLike, ToHost } from '../src/host-core';
import type { EngineConfig } from '../src/types';

/** Порт-заглушка: копит отправленное, ответы хоста шлём вручную. */
function fakePort() {
  const sent: ToHost[] = [];
  let cb: ((m: FromHost) => void) | null = null;
  const port: PortLike<FromHost, ToHost> = { post: (m) => { sent.push(m); }, listen: (fn) => { cb = fn; } };
  return { port, sent, reply: (m: FromHost) => cb?.(m) };
}
const config = { userId: 1, dbName: 'x', httpBase: 'http://x', wsUrl: 'ws://x' } as EngineConfig;

test('SharedWorker fails to load: everything sent so far is replayed to the dedicated worker, which then answers', async () => {
  const shared = fakePort(), dedicated = fakePort();
  let fail = () => {};
  let made = 0;
  const client = new EngineClient(fallbackPort(shared.port, (f) => { fail = f; }, () => { made++; return dedicated.port; }), 'b1', config, { pingMs: 5 });
  const patches: unknown[] = [];
  client.watch({ kind: 'counters' }, (p) => patches.push(p));
  const call = client.call({ type: 'refreshChats' });
  await Bun.sleep(12);   // пара ping — их повторять не нужно

  fail();
  expect(made).toBe(1);
  expect(dedicated.sent.map((m) => m.t)).toEqual(['hello', 'watch', 'call']);
  expect(dedicated.sent[0]).toMatchObject({ t: 'hello', build: 'b1' });

  // запасной хост отвечает — клиент получает
  dedicated.reply({ t: 'ready' });
  const sub = (dedicated.sent[1] as { sub: number }).sub, id = (dedicated.sent[2] as { id: number }).id;
  dedicated.reply({ t: 'patches', items: [{ sub, patch: { op: 'snapshot', items: [], order: [] } }] });
  dedicated.reply({ t: 'result', id, ok: true, value: 42 });
  expect(await call).toBe(42);
  expect(patches).toHaveLength(1);
  await client.ready;

  // новое уходит только в запасной; запоздалый ответ брошенного порта не доходит
  const before = shared.sent.length;
  client.watch({ kind: 'status' }, () => {});
  expect(shared.sent.length).toBe(before);
  expect(dedicated.sent.at(-1)).toMatchObject({ t: 'watch' });
  shared.reply({ t: 'result', id: 999, ok: true, value: 'stale' });
  client.close();
});

test('error after the shared host is ready is not a load failure: no switch', () => {
  const shared = fakePort();
  let fail = () => {};
  let made = 0;
  const client = new EngineClient(fallbackPort(shared.port, (f) => { fail = f; }, () => { made++; return fakePort().port; }), 'b1', config, { pingMs: 1000 });
  shared.reply({ t: 'ready' });
  fail();
  expect(made).toBe(0);
  client.watch({ kind: 'counters' }, () => {});
  expect(shared.sent.at(-1)).toMatchObject({ t: 'watch' });
  client.close();
});
