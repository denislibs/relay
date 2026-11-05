import type { ServerFrame } from '@relay/protocol';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { startRealtime } from '../src/realtime';
import { sendMessage } from '../src/domain/messages';
import { nextFrame, resetDb, refs } from './helpers';

// два «процесса» на одной базе и шине: запись через один, сокет на другом
const servers = [createServer({ port: 0 }), createServer({ port: 0 })];
const stops = await Promise.all(servers.map(startRealtime));
afterAll(async () => { for (const s of stops) await s(); for (const s of servers) s.stop(true); });
beforeEach(resetDb);

type U = { userId: number; token: string };
const base = (i = 0) => `http://localhost:${servers[i].port}`;
const login = async (name: string): Promise<U> => (await (await fetch(`${base()}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const hdr = (u: U) => ({ cookie: `relay_session=${u.token}`, 'content-type': 'application/json' });
const api = async (u: U, method: string, path: string, body?: unknown) => {
  const res = await fetch(base() + path, { method, headers: hdr(u), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
const group = async (owner: U, members: U[]) => (await api(owner, 'POST', '/chats', { title: 'Дача', members: refs(owner.userId, members.map((m) => m.userId)) })).json.id as number;
async function connect(u: U, i = 0): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${servers[i].port}/ws?token=${u.token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}
const send = (ws: WebSocket, f: unknown) => ws.send(JSON.stringify(f));
const hello = async (ws: WebSocket, since = 0) => { send(ws, { op: 'hello', lastSeq: 0, since }); return (await nextFrame(ws, (f) => f.op === 'hello')) as Extract<ServerFrame, { op: 'hello' }>; };
const say = (u: U, chatId: number, body = 'привет') => sendMessage(u.userId, { chatId, clientId: crypto.randomUUID(), body });
const collect = (ws: WebSocket) => { const got: ServerFrame[] = []; ws.addEventListener('message', (e) => got.push(JSON.parse(String(e.data)))); return got; };

test('a group message is one push with the same from/to for every member, on every process; hello {since} lists the chat', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await group(a, [b, c]);
  const wb = await connect(b, 0), wc = await connect(c, 1);
  const hb = await hello(wb), hc = await hello(wc);
  expect(hb.chats).toEqual([[id, 1]]);   // служебное «создал группу» — seq 1
  expect(hc.chats).toEqual([[id, 1]]);
  expect(hb.now).toBeGreaterThan(0);
  const pb = nextFrame(wb, (f) => f.op === 'push'), pc = nextFrame(wc, (f) => f.op === 'push');
  const { message } = await say(a, id);
  const [fb, fc] = (await Promise.all([pb, pc])) as Extract<ServerFrame, { op: 'push' }>[];
  expect(fb).toMatchObject({ chatId: id, from: 1, to: 2, items: [{ seq: 2, update: { type: 'newMessage', message: { id: message.id, body: 'привет' } } }] });
  expect(fc).toEqual(fb);
  // since после ответа hello — чат менялся → снова в списке; since в будущем — пусто
  expect((await hello(wb, hb.now)).chats).toEqual([[id, 2]]);
  send(wb, { op: 'chatsSince', since: Date.now() + 60_000 });
  expect(((await nextFrame(wb, (f) => f.op === 'chats')) as Extract<ServerFrame, { op: 'chats' }>).items).toEqual([]);
  wb.close(); wc.close();
});

test('syncChat pages the chat journal; a non-member gets chatGone; the personal journal has none of it', async () => {
  const a = await login('Анна'), b = await login('Борис'), x = await login('Чужой');
  const id = await group(a, [b, await login('Вера')]);
  for (let i = 0; i < 3; i++) await say(a, id, 'm' + i);
  const wb = await connect(b);
  send(wb, { op: 'syncChat', reqId: 'r1', chatId: id, since: 0 });
  const f = (await nextFrame(wb, (f) => f.op === 'chatUpdates')) as Extract<ServerFrame, { op: 'chatUpdates' }>;
  expect(f).toMatchObject({ reqId: 'r1', chatId: id, from: 0, to: 4, more: false });
  expect(f.items.map((i) => i.update.type)).toEqual(['newMessage', 'newMessage', 'newMessage', 'newMessage']);
  send(wb, { op: 'sync', since: 0 });
  const personal = (await nextFrame(wb, (f) => f.op === 'updates')) as Extract<ServerFrame, { op: 'updates' }>;
  expect(personal.items.map((i) => i.update.type)).toEqual(['membership']);   // группа пришла через membership с seq
  expect((personal.items[0].update as { seq?: number }).seq).toBe(1);
  const wx = await connect(x);
  send(wx, { op: 'syncChat', reqId: 'r2', chatId: id, since: 0 });
  expect(await nextFrame(wx, (f) => f.op === 'chatGone')).toMatchObject({ reqId: 'r2', chatId: id });
  wb.close(); wx.close();
});

test('joining subscribes the live socket (membership.seq = chat seq, next push arrives); removal unsubscribes it and syncChat is gone', async () => {
  const a = await login('Анна'), b = await login('Борис'), d = await login('Дина');
  const id = await group(a, [b]);
  const wd = await connect(d, 1);
  await hello(wd);
  const got = collect(wd);
  const poked = nextFrame(wd, (f) => f.op === 'poke');
  await api(a, 'POST', `/groups/${id}/members`, { users: refs(a.userId, [d.userId]) });
  await poked;   // о группе Дина узнаёт личным журналом: membership с seq чата на момент коммита (служебное + members + groupUpdated)
  send(wd, { op: 'sync', since: 0 });
  const upd = (await nextFrame(wd, (f) => f.op === 'updates')) as Extract<ServerFrame, { op: 'updates' }>;
  const membership = upd.items.map((i) => i.update).find((u) => u.type === 'membership') as { seq: number } | undefined;
  expect(membership).toBeDefined();
  const seq = membership!.seq;
  expect(seq).toBeGreaterThanOrEqual(2);
  await Bun.sleep(100);
  // следующее сообщение приходит ей как push чата без syncChat
  const before = got.length;
  const { message } = await say(a, id, 'после вступления');
  await Bun.sleep(300);
  const push = got.slice(before).find((f) => f.op === 'push' && f.chatId === id) as Extract<ServerFrame, { op: 'push' }>;
  expect(push).toMatchObject({ from: seq, to: seq + 1, items: [{ update: { type: 'newMessage', message: { id: message.id } } }] });
  // исключили: chatRemoved лично, подписка снята — следующий push чата не приходит, syncChat → chatGone
  await api(a, 'DELETE', `/groups/${id}/members/${d.userId}`);
  await Bun.sleep(300);
  const n = got.length;
  await say(a, id, 'без Дины');
  await Bun.sleep(300);
  expect(got.slice(n).filter((f) => f.op === 'push' && f.chatId === id)).toEqual([]);
  send(wd, { op: 'syncChat', reqId: 'r3', chatId: id, since: seq });
  expect(await nextFrame(wd, (f) => f.op === 'chatGone')).toMatchObject({ chatId: id });
  wd.close();
});

test('typing in a group travels over the chat topic across processes (sender included — the client drops its own)', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await group(a, [b, await login('Вера')]);
  const wa = await connect(a, 0), wb = await connect(b, 1);
  await hello(wa); await hello(wb);
  const typing = nextFrame(wb, (f) => f.op === 'typing');
  send(wa, { op: 'typing', chatId: id });
  expect(await typing).toMatchObject({ op: 'typing', chatId: id, userId: a.userId });
  wa.close(); wb.close();
});

test('a long event (does not fit the notify) is read once per process and arrives as a full push; a short one after it keeps the order', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await group(a, [b, c]);
  const wb = await connect(b, 0), wc = await connect(c, 1);
  await hello(wb); await hello(wc);
  const gb = collect(wb), gc = collect(wc);
  // одно событие на 8 КБ — в 8000 байт NOTIFY не влезает; следующее короткое уходит сразу за ним
  const long = await say(a, id, 'я'.repeat(4000));
  const short = await say(a, id, 'коротко');
  const t0 = Date.now();
  while ((gb.filter((f) => f.op === 'push').length < 2 || gc.filter((f) => f.op === 'push').length < 2) && Date.now() - t0 < 3000) await Bun.sleep(20);
  for (const got of [gb, gc]) {
    const pushes = got.filter((f) => f.op === 'push' && f.chatId === id) as Extract<ServerFrame, { op: 'push' }>[];
    expect(pushes.map((p) => [p.from, p.to])).toEqual([[1, 2], [2, 3]]);   // по порядку seq
    expect(pushes[0].items).toMatchObject([{ seq: 2, update: { type: 'newMessage', message: { id: long.message.id, body: 'я'.repeat(4000) } } }]);
    expect(pushes[1].items).toMatchObject([{ seq: 3, update: { type: 'newMessage', message: { id: short.message.id, body: 'коротко' } } }]);
  }
  // кадр у всех одинаковый — догонять чат (syncChat) никому не нужно
  expect(gc.filter((f) => f.op === 'push')).toEqual(gb.filter((f) => f.op === 'push'));
  wb.close(); wc.close();
});
