import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { sendMessage } from '../src/domain/messages';
import { deleteMessage, reactMessage } from '../src/domain/messageOps';
import '../src/jobs/kinds';
import { handlers } from '../src/jobs/handlers';
import { claim, complete } from '../src/jobs/queue';
import { drainJobs } from '../src/jobs/worker';
import { chatEventsOf, resetDb, refs } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

type U = { userId: number; token: string };
const login = async (name: string): Promise<U> => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const hdr = (u: U) => ({ cookie: `relay_session=${u.token}`, 'content-type': 'application/json' });
const ok = async (u: U, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: hdr(u), body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
const create = async (owner: U, members: U[], kind?: 'channel') => (await ok(owner, 'POST', '/chats', { ...(kind ? { kind } : {}), title: 'Чат', members: refs(owner.userId, members.map((m) => m.userId)) })).id as number;
const post = async (u: U, chatId: number) => (await sendMessage(u.userId, { chatId, clientId: crypto.randomUUID(), body: 'пост' })).message;
const countsRows = async (chatId: number, id: number) => (await sql`select emoji, n from message_reaction_counts where chat_id = ${chatId} and message_id = ${id} order by emoji`).map((r) => [r.emoji, r.n]);
const mineRows = async (chatId: number, id: number) => (await sql`select user_id, emoji from reactions where chat_id = ${chatId} and message_id = ${id} order by user_id`).map((r) => [Number(r.user_id), r.emoji]);
/** Начало новой секунды по часам базы (окно reactions.flush): реакции сразу после — в одном окне. */
async function atSecondStart(): Promise<void> {
  const [r] = await sql`select extract(epoch from clock_timestamp()) as t`;
  const frac = Number(r.t) % 1;
  await Bun.sleep((1 - frac) * 1000 + 30);
}
/** Дождаться конца окна (runAt задачи — его граница) и прогнать задачи. */
const flushWindow = async () => { await Bun.sleep(1100); await drainJobs(); };

test('channel reactions are counters: add, change, remove; mine; the reactions table follows; the answer carries counts and mine', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await create(a, [b, c], 'channel');
  const p = await post(a, id);
  expect(await reactMessage(b.userId, id, p.id, '👍')).toEqual({ reactions: [], counts: [['👍', 1]], mine: '👍' });
  expect(await reactMessage(c.userId, id, p.id, '👍')).toEqual({ reactions: [], counts: [['👍', 2]], mine: '👍' });
  expect(await reactMessage(a.userId, id, p.id, '🔥')).toEqual({ reactions: [], counts: [['👍', 2], ['🔥', 1]], mine: '🔥' });
  // смена: счётчик переезжает
  expect(await reactMessage(b.userId, id, p.id, '🔥')).toEqual({ reactions: [], counts: [['🔥', 2], ['👍', 1]], mine: '🔥' });
  // повтор той же — ничего не меняет
  expect(await reactMessage(b.userId, id, p.id, '🔥')).toEqual({ reactions: [], counts: [['🔥', 2], ['👍', 1]], mine: '🔥' });
  // снятие: строка эмодзи с нулём исчезает
  await reactMessage(c.userId, id, p.id, null);
  expect(await countsRows(id, p.id)).toEqual([['🔥', 2]]);
  expect(await mineRows(id, p.id)).toEqual([[a.userId, '🔥'], [b.userId, '🔥']].sort((x, y) => (x[0] as number) - (y[0] as number)));
  expect(await reactMessage(c.userId, id, p.id, null)).toEqual({ reactions: [], counts: [['🔥', 2]], mine: null });
  // чтение: счётчики и моя, без списка реакторов
  const hb = (await ok(b, 'GET', `/chats/${id}/messages?ids=${p.id}`)).messages[0];
  expect(hb).toMatchObject({ reactionCounts: [['🔥', 2]], myReaction: '🔥' });
  expect(hb.reactions).toBeUndefined();
  const hc = (await ok(c, 'GET', `/chats/${id}/messages`)).messages.at(-1);
  expect(hc.reactionCounts).toEqual([['🔥', 2]]);
  expect(hc.myReaction).toBeUndefined();
  // ни одного события reactions в канале
  expect(await chatEventsOf(id, 'reactions')).toEqual([]);
  // удаление поста — и счётчики, и свои реакции
  await deleteMessage(a.userId, id, p.id);
  expect(await countsRows(id, p.id)).toEqual([]);
  expect(await mineRows(id, p.id)).toEqual([]);
  await expect(reactMessage(b.userId, id, p.id, '👍')).rejects.toMatchObject({ code: 'not_found' });
});

test('one reactionCounts event per post per second window; two windows give two events and the last carries the final counts', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await create(a, [b, c], 'channel');
  const p = await post(a, id), q = await post(a, id);
  await atSecondStart();
  await reactMessage(b.userId, id, p.id, '👍');
  await reactMessage(c.userId, id, p.id, '❤️');
  await reactMessage(b.userId, id, q.id, '👍');   // другой пост — своя задача
  await flushWindow();
  // по событию на пост за окно (не на каждую реакцию)
  expect((await chatEventsOf(id, 'reactionCounts')).sort((x: any, y: any) => x.id - y.id)).toEqual([
    { type: 'reactionCounts', chatId: id, id: p.id, counts: [['❤️', 1], ['👍', 1]] },
    { type: 'reactionCounts', chatId: id, id: q.id, counts: [['👍', 1]] },
  ].sort((x, y) => x.id - y.id));
  // следующее окно — следующее событие, итог верный
  await reactMessage(c.userId, id, p.id, '👍');
  await flushWindow();
  const evs = (await chatEventsOf(id, 'reactionCounts')).filter((u: any) => u.id === p.id);
  expect(evs.length).toBe(2);
  expect(evs.at(-1)).toEqual({ type: 'reactionCounts', chatId: id, id: p.id, counts: [['👍', 2]] });
});

test('a change that lands while the window job is claimed is not lost: it gets its own window and event', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await create(a, [b, c], 'channel');
  const p = await post(a, id);
  await reactMessage(b.userId, id, p.id, '👍');
  await Bun.sleep(1100);
  const [job] = await claim(10, 300, { only: ['reactions.flush'] });
  expect(job.payload).toEqual({ chatId: id, id: p.id });
  // задача взята, но ещё не прочитала счётчики — приходит новая реакция (окно уже другое — своя задача)
  await reactMessage(c.userId, id, p.id, '🔥');
  await handlers['reactions.flush'](job.payload, job);
  await complete(job);
  await flushWindow();
  const evs = await chatEventsOf(id, 'reactionCounts');
  expect(evs.length).toBe(2);
  expect(evs.at(-1)).toEqual({ type: 'reactionCounts', chatId: id, id: p.id, counts: [['👍', 1], ['🔥', 1]] });   // равные — по коду эмодзи
  expect(await countsRows(id, p.id)).toEqual([['👍', 1], ['🔥', 1]]);
});

test('the flush job of a deleted post writes nothing; groups keep the reactions list and its event', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await create(a, [b], 'channel');
  const p = await post(a, id);
  await reactMessage(b.userId, id, p.id, '👍');
  await deleteMessage(a.userId, id, p.id);
  await flushWindow();
  expect(await chatEventsOf(id, 'reactionCounts')).toEqual([]);

  const g = await create(a, [b]);
  const m = await post(a, g);
  expect(await reactMessage(b.userId, g, m.id, '👍')).toEqual({ reactions: [{ userId: b.userId, emoji: '👍' }] });
  expect((await chatEventsOf(g, 'reactions')).at(-1)).toEqual({ type: 'reactions', chatId: g, id: m.id, reactions: [{ userId: b.userId, emoji: '👍' }] });
  expect(await countsRows(g, m.id)).toEqual([]);
  expect(Number((await sql`select count(*)::int as n from jobs where kind = 'reactions.flush'`)[0].n)).toBe(0);
  const hm = (await ok(b, 'GET', `/chats/${g}/messages?ids=${m.id}`)).messages[0];
  expect(hm.reactions).toEqual([{ userId: b.userId, emoji: '👍' }]);
  expect(hm.reactionCounts).toBeUndefined();
});
