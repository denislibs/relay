import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const as = (t: string) => ({ cookie: `relay_session=${t}`, 'content-type': 'application/json' });

test('jump to date: first message on or after the moment, otherwise the last; members only', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Чужой');
  const { id: chat } = (await (await fetch(`${base}/chats/direct`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ userId: b.userId }) })).json()) as { id: number };
  const put = async (at: string, body: string) => Number((await sql`insert into messages (chat_id, sender_id, client_id, body, created_at) values (${chat}, ${a.userId}, ${crypto.randomUUID()}, ${body}, ${at}) returning id`)[0].id);
  const d1 = await put('2026-10-10T08:00:00Z', 'десятое');
  const d2 = await put('2026-10-12T21:30:00Z', 'двенадцатое вечер');
  const d3 = await put('2026-10-15T09:00:00Z', 'пятнадцатое');
  const at = async (from: string, t = a.token) => fetch(`${base}/chats/${chat}/messages?from=${encodeURIComponent(from)}`, { headers: as(t) });
  expect(await (await at('2026-10-01T00:00:00Z')).json()).toEqual({ id: d1 });
  expect(await (await at('2026-10-11T00:00:00Z')).json()).toEqual({ id: d2 });
  // полночь 13-го по Москве = 21:00 UTC 12-го: «вечер двенадцатого» (21:30 UTC) у москвича — уже 13-е
  expect(await (await at('2026-10-13T00:00:00+03:00')).json()).toEqual({ id: d2 });
  expect(await (await at('2026-10-13T00:00:00Z')).json()).toEqual({ id: d3 });
  expect(await (await at('2026-10-20T00:00:00Z')).json()).toEqual({ id: d3 });         // позже ничего — последнее
  expect((await at('not-a-date')).status).toBe(400);
  expect((await at('2026-10-01T00:00:00Z', c.token)).status).toBe(403);
});
