import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { nextFrame, resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

async function login(name: string) {
  const res = await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) });
  return (await res.json()) as { userId: number; token: string };
}
const authed = (token: string) => ({ headers: { cookie: `relay_session=${token}` } });

test('/dev/stats is 404 without DEV_LOGIN', async () => {
  const a = await login('Анна');
  const prev = process.env.DEV_LOGIN;
  process.env.DEV_LOGIN = '0';
  try {
    const res = await fetch(`${base}/dev/stats`, authed(a.token));
    expect(res.status).toBe(404);
  } finally { process.env.DEV_LOGIN = prev; }
});

test('/dev/stats requires a session', async () => {
  expect((await fetch(`${base}/dev/stats`)).status).toBe(401);
});

test('/dev/stats: seq, sockets, journal size and min(seq), NOTIFY latency', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const empty = await (await fetch(`${base}/dev/stats`, authed(a.token))).json();
  expect(empty).toMatchObject({ userId: a.userId, seq: 0, sockets: 0, journal: { size: 0, minSeq: null } });

  const { id: chatId } = await (await fetch(`${base}/dev/chats`, { method: 'POST', ...authed(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json() as { id: number };
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { cookie: `relay_session=${a.token}` } } as never);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  try {
    // сообщение пишет запись в журнал обоим
    ws.send(JSON.stringify({ op: 'send', reqId: 'r1', clientId: crypto.randomUUID(), chatId, body: 'привет' }));
    await nextFrame(ws, (f) => f.op === 'ack');
    const s = await (await fetch(`${base}/dev/stats`, authed(a.token))).json();
    expect(s.seq).toBeGreaterThanOrEqual(1);
    expect(s.journal.size).toBe(s.seq);
    expect(s.journal.minSeq).toBe(1);
    expect(s.sockets).toBe(1);
    expect(typeof s.notifyMs).toBe('number');
    expect(s.notifyMs).toBeGreaterThanOrEqual(0);
  } finally { ws.close(); }
  // сокет закрыт — счётчик вернулся
  await Bun.sleep(100);
  expect((await (await fetch(`${base}/dev/stats`, authed(a.token))).json()).sockets).toBe(0);
});
