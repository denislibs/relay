import type { ServerFrame } from '@relay/protocol';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { startRealtime } from '../src/realtime';
import { sendMessage } from '../src/domain/messages';
import { handleFrame } from '../src/ws';
import { nextFrame, resetDb } from './helpers';

// Превью публичного канала до подписки (как в Telegram): не участник читает историю, закрепы и медиа канала с
// @именем, получает его push'и через watchChat и догоняет журнал syncChat; писать (отправка, реакции, просмотры,
// прочтение) — по-прежнему только участнику. Приватный канал не участнику закрыт.

const server = createServer({ port: 0 });
const stop = await startRealtime(server);
afterAll(async () => { await stop(); server.stop(true); });
beforeEach(resetDb);

type U = { userId: number; token: string };
const base = `http://localhost:${server.port}`;
const login = async (name: string): Promise<U> => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const hdr = (u: U) => ({ cookie: `relay_session=${u.token}`, 'content-type': 'application/json' });
const call = (u: U, method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: hdr(u), body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async (u: U, method: string, path: string, body?: unknown) => {
  const r = await call(u, method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
const code = async (u: U, method: string, path: string, body?: unknown) => { const r = await call(u, method, path, body); return { status: r.status, code: ((await r.json().catch(() => null)) as { code?: string } | null)?.code }; };
const post = (u: U, chatId: number, body = 'пост', extra: Record<string, unknown> = {}) => sendMessage(u.userId, { chatId, clientId: crypto.randomUUID(), body, ...extra });
/** Публичный канал (с @именем) с одним постом. */
async function publicChannel(owner: U, username = 'news_ch', members: U[] = []): Promise<number> {
  const id = (await ok(owner, 'POST', '/chats', { kind: 'channel', title: 'Новости', memberIds: members.map((m) => m.userId) })).id as number;
  await ok(owner, 'PUT', `/groups/${id}/username`, { username });
  return id;
}
async function connect(u: U): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?token=${u.token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}
const send = (ws: WebSocket, f: unknown) => ws.send(JSON.stringify(f));
const hello = async (ws: WebSocket) => { send(ws, { op: 'hello', lastSeq: 0 }); await nextFrame(ws, (f) => f.op === 'hello'); };

test('a non-member reads a public channel: history, by ids, media, counts, date jump, preview row without private fields', async () => {
  const a = await login('Анна'), x = await login('Чужой');
  const id = await publicChannel(a);
  const { message: p1 } = await post(a, id, 'первый');
  const { message: p2 } = await post(a, id, 'второй https://example.com');
  await ok(a, 'POST', `/chats/${id}/pins`, { messageId: p1.id });

  const h = await ok(x, 'GET', `/chats/${id}/messages?limit=50`);
  expect(h.messages[0].service.type).toBe('channel_created');
  h.messages = h.messages.filter((m: any) => !m.service);
  expect(h.messages.map((m: any) => m.body)).toEqual(['первый', 'второй https://example.com']);
  expect(h.messages[0]).toMatchObject({ senderId: 0, post: true, views: 0, reactionCounts: [] });
  expect((await ok(x, 'GET', `/chats/${id}/messages?ids=${p2.id}`)).messages.map((m: any) => m.id)).toEqual([p2.id]);
  expect((await ok(x, 'GET', `/chats/${id}/media/counts`)).link).toBe(1);
  expect((await ok(x, 'GET', `/chats/${id}/media?kind=link`)).messages.map((m: any) => m.id)).toEqual([p2.id]);
  expect((await ok(x, 'GET', `/chats/${id}/messages?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).id).toBe(p2.id);

  const pv = await ok(x, 'GET', `/groups/${id}`);
  expect(pv).toMatchObject({ member: false, requested: false, chat: { id, kind: 'channel', title: 'Новости', unread: 0, pinned: [p1.id], last: { id: p2.id }, group: { username: 'news_ch', members: 1, ownerId: null, requests: 0 } } });
  expect(pv.chat.me).toBeUndefined();
  expect(pv.chat.seq).toBe(Number((await sql`select seq from chat_seq where chat_id = ${id}`)[0].seq));
  // участнику — его обычная строка списка
  expect(await ok(a, 'GET', `/groups/${id}`)).toMatchObject({ member: true, chat: { id, me: { role: 'owner' }, group: { ownerId: a.userId } } });
  // список чатов не участника канала не содержит
  expect((await ok(x, 'GET', `/chats?ids=${id}`)).map((c: any) => c.id)).toEqual([]);
});

test('a private channel, a banned viewer and a deleted public channel stay closed to non-members', async () => {
  const a = await login('Анна'), x = await login('Чужой'), b = await login('Борис');
  const priv = (await ok(a, 'POST', '/chats', { kind: 'channel', title: 'Закрытый' })).id as number;
  await post(a, priv);
  for (const path of [`/chats/${priv}/messages`, `/chats/${priv}/media/counts`, `/chats/${priv}/media?kind=media`, `/groups/${priv}`]) {
    expect(await code(x, 'GET', path)).toEqual({ status: 403, code: 'not_member' });
  }
  const pub = await publicChannel(a, 'open_ch', [b]);
  await ok(a, 'DELETE', `/groups/${pub}/members/${b.userId}`);   // исключён — в бане
  expect(await code(b, 'GET', `/chats/${pub}/messages`)).toEqual({ status: 403, code: 'not_member' });
  await ok(a, 'DELETE', `/groups/${pub}`);
  expect(await code(x, 'GET', `/chats/${pub}/messages`)).toEqual({ status: 404, code: 'not_found' });
  const gone = await handleFrame(x.userId, { op: 'syncChat', reqId: 'r', chatId: pub, since: 0 });
  expect(gone).toEqual([{ op: 'chatGone', reqId: 'r', chatId: pub }]);
});

test('writes stay members-only in a public channel: send, react, views, read, pin', async () => {
  const a = await login('Анна'), x = await login('Чужой');
  const id = await publicChannel(a);
  const { message } = await post(a, id);
  const frame = async (f: Parameters<typeof handleFrame>[1]) => (await handleFrame(x.userId, f))[0];
  expect(await frame({ op: 'send', reqId: 's', clientId: crypto.randomUUID(), chatId: id, body: 'я' })).toMatchObject({ op: 'err', code: 'not_member' });
  expect(await frame({ op: 'react', reqId: 'r', chatId: id, id: message.id, emoji: '👍' })).toMatchObject({ op: 'err', code: 'not_member' });
  expect(await frame({ op: 'read', reqId: 'd', chatId: id, upToId: message.id })).toMatchObject({ op: 'err', code: 'not_member' });
  expect(await code(x, 'POST', `/chats/${id}/views`, { ids: [message.id] })).toEqual({ status: 403, code: 'not_member' });
  expect(await code(x, 'POST', `/chats/${id}/pins`, { messageId: message.id })).toMatchObject({ status: 403 });
  expect(Number((await sql`select count(*)::int as n from message_views where chat_id = ${id}`)[0].n)).toBe(0);
});

test('syncChat works for a non-member of a public channel; private channel — chatGone', async () => {
  const a = await login('Анна'), x = await login('Чужой');
  const id = await publicChannel(a);
  await post(a, id, 'раз'); await post(a, id, 'два');
  const [f] = await handleFrame(x.userId, { op: 'syncChat', reqId: 'r', chatId: id, since: 0 });
  expect(f).toMatchObject({ op: 'chatUpdates', chatId: id, from: 0, more: false });
  const items = (f as Extract<ServerFrame, { op: 'chatUpdates' }>).items;
  expect(items.filter((i) => i.update.type === 'newMessage' && !i.update.message.service).map((i) => (i.update as { message: { body: string } }).message.body)).toEqual(['раз', 'два']);
  const priv = (await ok(a, 'POST', '/chats', { kind: 'channel', title: 'Закрытый' })).id as number;
  expect(await handleFrame(x.userId, { op: 'syncChat', reqId: 'p', chatId: priv, since: 0 })).toEqual([{ op: 'chatGone', reqId: 'p', chatId: priv }]);
});

test('watchChat: a non-member socket gets the channel push while watching, not after unwatch; private — not_member', async () => {
  const a = await login('Анна'), x = await login('Чужой');
  const id = await publicChannel(a);
  const ws = await connect(x);
  await hello(ws);
  send(ws, { op: 'watchChat', reqId: 'w1', chatId: id });
  const ack = (await nextFrame(ws, (f) => f.op === 'ack' && f.reqId === 'w1')) as Extract<ServerFrame, { op: 'ack' }>;
  const seq = Number((await sql`select seq from chat_seq where chat_id = ${id}`)[0].seq);
  expect(ack.result).toEqual({ seq });
  // сверка подписок (hello) превью не снимает
  await hello(ws);
  const got = nextFrame(ws, (f) => f.op === 'push' && f.chatId === id);
  const { message } = await post(a, id, 'свежий');
  expect(await got).toMatchObject({ op: 'push', chatId: id, from: seq, to: seq + 1, items: [{ update: { type: 'newMessage', message: { id: message.id, body: 'свежий' } } }] });

  send(ws, { op: 'unwatchChat', chatId: id });
  send(ws, { op: 'ping' });
  await nextFrame(ws, (f) => f.op === 'pong');
  const after: ServerFrame[] = [];
  ws.addEventListener('message', (e) => after.push(JSON.parse(String(e.data))));
  await post(a, id, 'мимо');
  await Bun.sleep(300);
  expect(after.filter((f) => f.op === 'push' && f.chatId === id)).toEqual([]);

  const priv = (await ok(a, 'POST', '/chats', { kind: 'channel', title: 'Закрытый' })).id as number;
  send(ws, { op: 'watchChat', reqId: 'w2', chatId: priv });
  expect(await nextFrame(ws, (f) => f.op === 'err' && f.reqId === 'w2')).toMatchObject({ code: 'not_member' });
  ws.close();
});

test('joining while watching keeps the socket on the channel (unwatch no longer drops it); deleting it pushes an empty frame', async () => {
  const a = await login('Анна'), x = await login('Чужой');
  const id = await publicChannel(a);
  await post(a, id, 'раз');
  const ws = await connect(x);
  await hello(ws);
  send(ws, { op: 'watchChat', reqId: 'w', chatId: id });
  await nextFrame(ws, (f) => f.op === 'ack' && f.reqId === 'w');
  const mem = nextFrame(ws, (f) => (f.op === 'push' && f.chatId == null) || f.op === 'poke');   // личный журнал: membership
  expect(await ok(x, 'POST', '/join/@news_ch')).toEqual({ chatId: id, requested: false });
  await mem;
  // вступивший начинает с прочитанного: старые посты не непрочитанные
  expect((await ok(x, 'GET', `/chats?ids=${id}`))[0]).toMatchObject({ unread: 0 });
  send(ws, { op: 'unwatchChat', chatId: id });
  const got = nextFrame(ws, (f) => f.op === 'push' && f.chatId === id);
  await post(a, id, 'после');
  expect(await got).toMatchObject({ chatId: id, items: [{ update: { type: 'newMessage' } }] });

  // другой зритель (не участник) — канал удалён: пустой push, его syncChat — chatGone
  const y = await login('Зритель');
  const wy = await connect(y);
  await hello(wy);
  send(wy, { op: 'watchChat', reqId: 'w', chatId: id });
  await nextFrame(wy, (f) => f.op === 'ack' && f.reqId === 'w');
  const empty = nextFrame(wy, (f) => f.op === 'push' && f.chatId === id);
  await ok(a, 'DELETE', `/groups/${id}`);
  expect(await empty).toMatchObject({ chatId: id, items: [] });
  ws.close(); wy.close();
});

test('resolve @name: /join/@name previews a public channel; channel search finds public channels I am not in', async () => {
  const a = await login('Анна'), x = await login('Чужой');
  const id = await publicChannel(a, 'tech_news');
  expect(await ok(x, 'GET', '/join/@tech_news')).toMatchObject({ chatId: id, kind: 'channel', title: 'Новости', member: false, requested: false });
  const hits = await ok(x, 'GET', '/search/channels?q=tech');
  expect(hits.channels).toEqual([{ id, title: 'Новости', username: 'tech_news', photo: null, members: 1 }]);
  expect((await ok(x, 'GET', '/search/channels?q=Ново')).channels.map((c: any) => c.id)).toEqual([id]);
  expect((await ok(a, 'GET', '/search/channels?q=tech')).channels).toEqual([]);   // уже участник — найдёт список на устройстве
  const priv = (await ok(a, 'POST', '/chats', { kind: 'channel', title: 'Новости закрытые' })).id as number;
  expect((await ok(x, 'GET', '/search/channels?q=Новости')).channels.map((c: any) => c.id)).not.toContain(priv);
});
