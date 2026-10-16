import type { ServerFrame } from '@relay/protocol';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { startRealtime } from '../src/realtime';
import { nextFrame, resetDb } from './helpers';

const server = createServer({ port: 0 });
const stopRealtime = await startRealtime(server);
const base = `http://localhost:${server.port}`;
afterAll(async () => { await stopRealtime(); server.stop(true); });
beforeEach(resetDb);

async function login(name: string) {
  const res = await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) });
  return (await res.json()) as { userId: number; token: string };
}
async function connect(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?token=${token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}
const send = (ws: WebSocket, f: unknown) => ws.send(JSON.stringify(f));

test('A sends → B is poked → B syncs → B reads → A sees readBy', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const { id: chatId } = await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json() as { id: number };
  const wa = await connect(a.token), wb = await connect(b.token);

  const poked = nextFrame(wb, (f) => f.op === 'poke');
  const acked = nextFrame(wa, (f) => f.op === 'ack');
  send(wa, { op: 'send', reqId: 'r1', clientId: crypto.randomUUID(), chatId, body: 'привет' });
  const ack = (await acked) as Extract<ServerFrame, { op: 'ack' }>;
  await poked;

  const gotUpdates = nextFrame(wb, (f) => f.op === 'updates');
  send(wb, { op: 'sync', since: 0 });
  const upd = (await gotUpdates) as Extract<ServerFrame, { op: 'updates' }>;
  expect(upd.items.map((i) => i.update.type)).toEqual(['newMessage']);

  const aPoked = nextFrame(wa, (f) => f.op === 'poke');
  send(wb, { op: 'read', reqId: 'r2', chatId, upToId: ack.result.id });
  await aPoked;
  const aUpdates = nextFrame(wa, (f) => f.op === 'updates');
  send(wa, { op: 'sync', since: 1 });
  const readBy = ((await aUpdates) as Extract<ServerFrame, { op: 'updates' }>).items.map((i) => i.update);
  expect(readBy).toEqual([{ type: 'readBy', chatId, userId: b.userId, upToId: ack.result.id }]);

  wa.close(); wb.close();
});

test('junk frames get bad_frame and the socket stays open', async () => {
  const a = await login('a');
  const ws = await connect(a.token);
  const err = nextFrame(ws, (f) => f.op === 'err');
  ws.send('{"op":"drop_tables"}');
  expect(await err).toEqual({ op: 'err', code: 'bad_frame', retry: false });
  const pong = nextFrame(ws, (f) => f.op === 'pong');
  send(ws, { op: 'ping' });
  await pong;
  ws.close();
});

test('websocket without a session is refused', async () => {
  const res = await fetch(`${base}/ws`, { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
  expect(res.status).toBe(401);
});
