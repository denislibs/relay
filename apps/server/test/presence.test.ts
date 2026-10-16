import type { ServerFrame } from '@relay/protocol';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { resetPresence } from '../src/domain/presence';
import { createServer } from '../src/http';
import { nextFrame, resetDb } from './helpers';

process.env.RELAY_PRESENCE_GRACE_MS = '60';
const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(async () => { await resetDb(); resetPresence(); });

async function login(name: string) {
  const res = await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) });
  return (await res.json()) as { userId: number; token: string };
}
async function connect(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?token=${token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}
const presenceOf = async (token: string) => (await fetch(`${base}/presence`, { headers: { cookie: `relay_session=${token}` } })).json() as Promise<{ userId: number; online: boolean; lastSeen: string | null }[]>;

test('a peer coming online and leaving is pushed to the other side; last seen is stored', async () => {
  const a = await login('Анна'), b = await login('Борис');
  await fetch(`${base}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) });
  const wb = await connect(b.token);

  const cameOnline = nextFrame(wb, (f) => f.op === 'presence');
  const wa = await connect(a.token);
  const on = (await cameOnline) as Extract<ServerFrame, { op: 'presence' }>;
  expect(on.items).toEqual([{ userId: a.userId, online: true, lastSeen: null }]);
  expect((await presenceOf(b.token)).find((p) => p.userId === a.userId)?.online).toBe(true);

  const wentOffline = nextFrame(wb, (f) => f.op === 'presence');
  wa.close();
  const off = (await wentOffline) as Extract<ServerFrame, { op: 'presence' }>;
  expect(off.items[0]).toMatchObject({ userId: a.userId, online: false });
  expect(Date.now() - Date.parse(off.items[0].lastSeen!)).toBeLessThan(5000);
  const [row] = await sql`select last_seen_at from users where id = ${a.userId}`;
  expect(row.last_seen_at).not.toBeNull();
  wb.close();
});

test('a reload inside the grace period does not flicker offline', async () => {
  const a = await login('Анна'), b = await login('Борис');
  await fetch(`${base}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) });
  const wa = await connect(a.token);
  const wb = await connect(b.token);
  const seen: ServerFrame[] = [];
  wb.addEventListener('message', (e) => { const f = JSON.parse(String(e.data)) as ServerFrame; if (f.op === 'presence') seen.push(f); });
  wa.close();
  const again = await connect(a.token);    // «перезагрузка» быстрее паузы
  await Bun.sleep(150);
  expect(seen).toEqual([]);
  expect((await presenceOf(b.token)).find((p) => p.userId === a.userId)?.online).toBe(true);
  again.close(); wb.close();
});
