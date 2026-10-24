import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { sendMessage } from '../src/domain/messages';
import { deleteMessage } from '../src/domain/messageOps';
import { countViews, VIEWS } from '../src/domain/views';
import { searchPostgres } from '../src/domain/search';
import { chatEventsOf, resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
const perSec = VIEWS.perSec;
beforeEach(async () => { await resetDb(); VIEWS.perSec = 1000; });   // лимит проверяет свой тест
afterEach(() => { VIEWS.perSec = perSec; });

type U = { userId: number; token: string };
const login = async (name: string): Promise<U> => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const hdr = (u: U) => ({ cookie: `relay_session=${u.token}`, 'content-type': 'application/json' });
const call = (u: U, method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: hdr(u), body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async (u: U, method: string, path: string, body?: unknown) => {
  const r = await call(u, method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
const channel = async (owner: U, members: U[] = []) => (await ok(owner, 'POST', '/chats', { kind: 'channel', title: 'Новости', memberIds: members.map((m) => m.userId) })).id as number;
const post = async (u: U, chatId: number, body = 'пост') => (await sendMessage(u.userId, { chatId, clientId: crypto.randomUUID(), body })).message;
const stored = async (chatId: number, id: number) => Number((await sql`select views from message_views where chat_id = ${chatId} and message_id = ${id}`)[0]?.views ?? 0);

test('views: one per subscriber per post (Valkey dedupe), only posts of this channel count, the answer carries the numbers', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await channel(a, [b, c]);
  const p1 = await post(a, id, 'один'), p2 = await post(a, id, 'два');
  expect(await ok(b, 'POST', `/chats/${id}/views`, { ids: [p1.id, p2.id] })).toEqual({ views: [[p1.id, 1], [p2.id, 1]] });
  // повтор того же подписчика — не прибавляет
  expect(await ok(b, 'POST', `/chats/${id}/views`, { ids: [p1.id, p2.id, p1.id] })).toEqual({ views: [[p1.id, 1], [p2.id, 1]] });
  expect(await ok(c, 'POST', `/chats/${id}/views`, { ids: [p2.id] })).toEqual({ views: [[p2.id, 2]] });
  expect([await stored(id, p1.id), await stored(id, p2.id)]).toEqual([1, 2]);
  // служебное «создал(а) канал», чужие id и мусор — не считаются
  const [svc] = await sql`select id from messages where chat_id = ${id} and service_type is not null`;
  expect(await ok(b, 'POST', `/chats/${id}/views`, { ids: [Number(svc.id), 999999, -1, 'x'] })).toEqual({ views: [] });
  // удалённый пост — тоже
  await deleteMessage(a.userId, id, p1.id);
  expect(await ok(c, 'POST', `/chats/${id}/views`, { ids: [p1.id] })).toEqual({ views: [] });
  // событий в журнал канала просмотры не пишут
  expect((await chatEventsOf(id)).some((u) => JSON.stringify(u).includes('views'))).toBe(false);
});

test('views: at most 100 ids; non-members get not_member; not a channel — bad_frame', async () => {
  const a = await login('Анна'), b = await login('Борис'), x = await login('Чужой');
  const id = await channel(a, [b]);
  const p = await post(a, id);
  expect((await call(b, 'POST', `/chats/${id}/views`, { ids: Array.from({ length: 101 }, (_, i) => i + 1) })).status).toBe(400);
  expect((await call(b, 'POST', `/chats/${id}/views`, { ids: Array.from({ length: 100 }, (_, i) => p.id + i) })).status).toBe(200);
  expect((await call(b, 'POST', `/chats/${id}/views`, { ids: 'nope' })).status).toBe(400);
  const r = await call(x, 'POST', `/chats/${id}/views`, { ids: [p.id] });
  expect(r.status).toBe(403);
  expect(await r.json()).toMatchObject({ code: 'not_member' });
  const g = (await ok(a, 'POST', '/chats', { title: 'Группа', memberIds: [b.userId] })).id;
  const gm = await post(a, g);
  const bad = await call(b, 'POST', `/chats/${g}/views`, { ids: [gm.id] });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ code: 'bad_frame' });
});

test('views: one request per second per user — the next one is flood (429), a second later it passes', async () => {
  VIEWS.perSec = 1;
  const a = await login('Анна'), b = await login('Борис');
  const id = await channel(a, [b]);
  const p1 = await post(a, id), p2 = await post(a, id);
  // ровно в начале секунды: два запроса подряд попадают в одно окно ключа (TTL 1 с)
  await Bun.sleep(1000 - (Date.now() % 1000) + 20);
  expect((await countViews(b.userId, id, [p1.id])).views).toEqual([[p1.id, 1]]);
  await expect(countViews(b.userId, id, [p2.id])).rejects.toMatchObject({ code: 'flood', retryAfter: 1 });
  const r = await call(b, 'POST', `/chats/${id}/views`, { ids: [p2.id] });
  expect(r.status).toBe(429);
  expect(await stored(id, p2.id)).toBe(0);   // отклонённый запрос ничего не посчитал
  await Bun.sleep(1100);
  expect((await countViews(b.userId, id, [p2.id])).views).toEqual([[p2.id, 1]]);
  // лимит — на пользователя: другой подписчик тем временем не ограничен
  expect((await countViews(a.userId, id, [p1.id])).views).toEqual([[p1.id, 2]]);
});

test('views come with history, messages by ids, search and the chat list row; groups have no views', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await channel(a, [b]);
  const p1 = await post(a, id, 'первый пост'), p2 = await post(a, id, 'второй пост');
  await countViews(b.userId, id, [p1.id, p2.id]);
  await countViews(a.userId, id, [p2.id]);
  const hist = (await ok(b, 'GET', `/chats/${id}/messages`)).messages;
  expect(hist.filter((m: any) => !m.service).map((m: any) => [m.id, m.views])).toEqual([[p1.id, 1], [p2.id, 2]]);
  expect(hist[0].service.type).toBe('channel_created');
  expect(hist[0].views).toBeUndefined();
  expect((await ok(b, 'GET', `/chats/${id}/messages?ids=${p2.id}`)).messages[0].views).toBe(2);
  expect((await ok(b, 'GET', `/chats/${id}/messages?after=${p1.id}`)).messages.map((m: any) => m.views)).toEqual([2]);
  const l = await ok(b, 'GET', `/chats?ids=${id}`);
  const row = (l.chats ?? l).find((c: any) => c.id === id);
  expect(row.last).toMatchObject({ id: p2.id, views: 2 });
  const found = await searchPostgres(b.userId, 'первый', { chatId: id });
  expect(found.hits[0].message).toMatchObject({ id: p1.id, views: 1 });
  // новый пост без просмотров — 0 (не «нет поля»), журнал newMessage — без views (гидрация их не берёт)
  const p3 = await post(a, id, 'третий');
  expect((await ok(b, 'GET', `/chats/${id}/messages?ids=${p3.id}`)).messages[0].views).toBe(0);
  expect((await chatEventsOf(id, 'newMessage')).map((u: any) => u.message.views)).toEqual([undefined, undefined, undefined, undefined]);
  const g = (await ok(a, 'POST', '/chats', { title: 'Группа', memberIds: [b.userId] })).id;
  await post(a, g, 'в группе');
  expect((await ok(b, 'GET', `/chats/${g}/messages`)).messages.every((m: any) => m.views === undefined)).toBe(true);
});
