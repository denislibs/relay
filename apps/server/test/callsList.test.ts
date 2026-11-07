import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { serviceMessage } from '../src/domain/groups';
import { resetDb } from './helpers';

// список «Звонки»: звонки 1:1 из служебных сообщений call, глазами пользователя; пропущенные и отметка «видел»
const s = createServer({ port: 0 });
const base = `http://localhost:${s.port}`;
afterAll(() => s.stop(true));
beforeEach(resetDb);
type Login = { userId: number; token: string };
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as Login;
const get = async (l: Login, path: string) => (await fetch(base + path, { headers: { cookie: `relay_session=${l.token}` } })).json();
const post = async (l: Login, path: string) => (await fetch(base + path, { method: 'POST', headers: { cookie: `relay_session=${l.token}` } })).json();
const direct = async (a: Login, b: Login) =>
  ((await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number }).id;
const callLine = (chatId: number, caller: number, call: Record<string, unknown>) =>
  sql.begin((tx) => serviceMessage(tx, chatId, caller, 'call', { call: call as never }, '', 'direct'));

test('calls of all direct chats, newest first, from my side: direction, contact name, paging, missed filter and badge', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const ab = await direct(a, b), ac = await direct(a, c);
  await fetch(`${base}/contacts`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ userId: b.userId, firstName: 'Боря' }) });
  await callLine(ab, a.userId, { video: false, reason: 'ended', duration: 65 });
  await callLine(ab, b.userId, { video: true, reason: 'missed' });
  await callLine(ac, c.userId, { video: false, reason: 'declined' });
  await callLine(ac, c.userId, { video: false, reason: 'cancelled' });
  await sql`insert into messages (chat_id, sender_id, client_id, kind, body) values (${ab}, ${a.userId}, ${crypto.randomUUID()}, 'text', '')`;   // не звонок

  const all = await get(a, '/calls');
  expect(all.more).toBe(false);
  expect(all.calls.map((x: { name: string; outgoing: boolean; reason: string }) => [x.name, x.outgoing, x.reason])).toEqual([
    ['Вера', false, 'cancelled'], ['Вера', false, 'declined'], ['Боря', false, 'missed'], ['Боря', true, 'ended'],
  ]);
  expect(all.calls[2]).toMatchObject({ chatId: ab, peerId: b.userId, video: true });
  expect(all.calls[3].duration).toBe(65);

  const missed = await get(a, '/calls?missed=1');
  expect(missed.calls.map((x: { reason: string }) => x.reason)).toEqual(['cancelled', 'missed']);
  expect((await get(b, '/calls')).calls.map((x: { outgoing: boolean; reason: string }) => [x.outgoing, x.reason])).toEqual([[true, 'missed'], [false, 'ended']]);
  expect(await get(c, '/calls?missed=1')).toEqual({ calls: [], more: false });   // свои исходящие — не пропущенные

  expect(await get(a, '/calls/unseen')).toEqual({ count: 2 });
  await post(a, '/calls/seen');
  expect(await get(a, '/calls/unseen')).toEqual({ count: 0 });
  await Bun.sleep(5);
  await callLine(ab, b.userId, { video: false, reason: 'missed' });
  expect(await get(a, '/calls/unseen')).toEqual({ count: 1 });

  // курсор: страница после второй строки
  const first = all.calls[1];
  const page = await get(a, `/calls?before=${encodeURIComponent(first.at)}_${first.id}`);
  expect(page.calls.map((x: { reason: string }) => x.reason)).toEqual(['missed', 'ended']);
  expect((await fetch(`${base}/calls?before=junk`, { headers: { cookie: `relay_session=${a.token}` } })).status).toBe(400);
});

test('cleared history and deleted lines are not in the list; strangers see nothing of others', async () => {
  const a = await login('Анна'), b = await login('Борис'), x = await login('Чужой');
  const ab = await direct(a, b);
  const m1 = await callLine(ab, a.userId, { video: false, reason: 'ended', duration: 3 });
  await callLine(ab, a.userId, { video: false, reason: 'missed' });
  await sql`update messages set deleted = true where chat_id = ${ab} and id = ${m1.id}`;
  expect((await get(a, '/calls')).calls.length).toBe(1);
  await sql`update chat_members set history_from = (select max(id) + 1 from messages where chat_id = ${ab}) where chat_id = ${ab} and user_id = ${b.userId}`;
  expect((await get(b, '/calls')).calls).toEqual([]);
  expect((await get(x, '/calls')).calls).toEqual([]);
});

test('conferences I was in show up in «Все» with who was there; not in «Пропущенные»', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = crypto.randomUUID();
  await sql`insert into group_calls (id, chat_id, started_by, started_at, ended_at, duration, kind) values (${id}, null, ${a.userId}, now() - interval '1 minute', now(), 42, 'conference')`;
  await sql`insert into group_call_members (call_id, user_id) values (${id}, ${a.userId}), (${id}, ${b.userId}), (${id}, ${c.userId})`;
  const list = await get(b, '/calls');
  expect(list.calls[0]).toMatchObject({ chatId: 0, outgoing: false, duration: 42, conference: { callId: id, count: 3 } });
  expect(list.calls[0].conference.names.sort()).toEqual(['Анна', 'Вера']);
  expect((await get(b, '/calls?missed=1')).calls).toEqual([]);
});
