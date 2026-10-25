import type { ServerFrame } from '@relay/protocol';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { nextFrame, resetDb } from './helpers';

// клики по большому эмодзи: сервер пересылает собеседнику в личном чате, в группе молчит, не чаще раза в секунду
const s = createServer({ port: 0 });
afterAll(() => s.stop(true));
beforeEach(resetDb);
const base = `http://localhost:${s.port}`;
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
async function connect(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${s.port}/ws?token=${token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}
const chat = async (a: { userId: number; token: string }, kind: 'direct' | 'group', members: number[]) =>
  ((await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind, title: kind === 'group' ? 'Чат' : null, memberIds: members }) })).json()) as { id: number }).id;
const silence = (ws: WebSocket, ms = 300) => new Promise<boolean>((ok) => { const on = (e: MessageEvent) => { if ((JSON.parse(String(e.data)) as ServerFrame).op === 'emojiFx') { ws.removeEventListener('message', on); ok(false); } }; ws.addEventListener('message', on); setTimeout(() => { ws.removeEventListener('message', on); ok(true); }, ms); });

test('direct chat: the peer gets the batch with userId; a second batch on the same message within 800 ms is dropped, another message passes', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await chat(a, 'direct', [a.userId, b.userId]);
  const wa = await connect(a.token), wb = await connect(b.token);
  const got = nextFrame(wb, (f) => f.op === 'emojiFx');
  wa.send(JSON.stringify({ op: 'emojiFx', chatId, id: 1, key: '❤', t: [0, 0.4] }));
  expect(await got).toEqual({ op: 'emojiFx', chatId, id: 1, key: '❤', t: [0, 0.4], userId: a.userId } satisfies ServerFrame);
  wa.send(JSON.stringify({ op: 'emojiFx', chatId, id: 1, key: '❤', t: [0] }));
  expect(await silence(wb)).toBe(true);
  const other = nextFrame(wb, (f) => f.op === 'emojiFx' && f.id === 2);
  wa.send(JSON.stringify({ op: 'emojiFx', chatId, id: 2, key: '🔥', t: [0] }));   // другое сообщение — не под лимитом
  expect((await other).op).toBe('emojiFx');
  wa.close(); wb.close();
});

test('group chat and bad frames are ignored', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const g = await chat(a, 'group', [a.userId, b.userId]);
  const wa = await connect(a.token), wb = await connect(b.token);
  wa.send(JSON.stringify({ op: 'emojiFx', chatId: g, id: 1, key: '❤', t: [0] }));
  expect(await silence(wb)).toBe(true);
  const d = await chat(a, 'direct', [a.userId, b.userId]);
  wa.send(JSON.stringify({ op: 'emojiFx', chatId: d, id: 1, key: '❤', t: [0, 99] }));   // t за окном — кадр отброшен парсером
  expect(await silence(wb)).toBe(true);
  wa.close(); wb.close();
});
