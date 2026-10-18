import type { ServerFrame } from '@relay/protocol';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { resetPresence } from '../src/domain/presence';
import { createServer } from '../src/http';
import { nextFrame, resetDb } from './helpers';

// у каждого сервера своя шина и своё подключение-подписчик — как у двух процессов
const s1 = createServer({ port: 0 }), s2 = createServer({ port: 0 });
afterAll(async () => { await s1.stop(true); await s2.stop(true); });
beforeEach(async () => { await resetDb(); resetPresence(); });

const base = (s: typeof s1) => `http://localhost:${s.port}`;
async function login(name: string) {
  return (await (await fetch(`${base(s1)}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
}
async function connect(s: typeof s1, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${s.port}/ws?token=${token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}
async function directChat(a: { userId: number; token: string }, b: { userId: number }): Promise<number> {
  const res = await fetch(`${base(s1)}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) });
  return ((await res.json()) as { id: number }).id;
}

test('typing from a socket on one server reaches the peer on another', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await directChat(a, b);
  const wa = await connect(s1, a.token), wb = await connect(s2, b.token);
  await Bun.sleep(50);   // подписка в Valkey идёт после open
  const got = nextFrame(wb, (f) => f.op === 'typing');
  wa.send(JSON.stringify({ op: 'typing', chatId }));
  expect(await got).toEqual({ op: 'typing', chatId, userId: a.userId } satisfies ServerFrame);
  wa.close(); wb.close();
});

test('a closed socket stops receiving: the topic is unsubscribed when the last socket leaves', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await directChat(a, b);
  const wa = await connect(s1, a.token);
  const wb1 = await connect(s2, b.token), wb2 = await connect(s2, b.token);
  wb1.close();
  await Bun.sleep(50);
  const got = nextFrame(wb2, (f) => f.op === 'typing');   // второй сокет того же пользователя всё ещё получает
  wa.send(JSON.stringify({ op: 'typing', chatId }));
  expect(await got).toMatchObject({ op: 'typing', userId: a.userId });
  wa.close(); wb2.close();
});
