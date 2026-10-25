import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { sendMessage } from '../src/domain/messages';
import { deleteMessage, reactMessage } from '../src/domain/messageOps';
import { journalOf, resetDb } from './helpers';

// непрочитанные реакции на мои сообщения: строка на сообщение, пока не прочитал; журнал reaction / reactionsRead

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
const group = async (owner: U, members: U[]) => (await ok(owner, 'POST', '/chats', { title: 'Чат', memberIds: members.map((m) => m.userId) })).id as number;
const unreadOf = async (u: U, chatId: number) => (await ok(u, 'GET', '/chats/page?limit=20')).chats.find((c: any) => c.id === chatId)?.unreadReactions;

test('a reaction from another member marks my message unread; my own does not; removing the last foreign one clears it', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const chatId = await group(a, [b, c]);
  const { message } = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'привет' });
  await reactMessage(a.userId, chatId, message.id, '👍');   // своя — не считается
  expect(await unreadOf(a, chatId)).toBe(0);
  await reactMessage(b.userId, chatId, message.id, '❤');
  expect(await unreadOf(a, chatId)).toBe(1);
  expect(await ok(a, 'GET', `/chats/${chatId}/reactions/unread`)).toEqual({ ids: [message.id], count: 1 });
  expect(await journalOf(a.userId, 'reaction')).toEqual([{ type: 'reaction', chatId, id: message.id }]);
  expect(await journalOf(b.userId, 'reaction')).toEqual([]);   // реактору — ничего
  await reactMessage(c.userId, chatId, message.id, '🔥');       // вторая чужая — та же строка, события нет
  expect(await journalOf(a.userId, 'reaction')).toHaveLength(1);
  await reactMessage(b.userId, chatId, message.id, null);
  expect(await unreadOf(a, chatId)).toBe(1);                   // осталась реакция Веры
  await reactMessage(c.userId, chatId, message.id, null);
  expect(await unreadOf(a, chatId)).toBe(0);                   // чужих нет — снято
  expect(await journalOf(a.userId, 'reactionsRead')).toEqual([{ type: 'reactionsRead', chatId, ids: [message.id] }]);
});

test('read by ids, read all, and a deleted message: rows go, the journal says so', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await group(a, [b]);
  const m1 = (await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: '1' })).message;
  const m2 = (await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: '2' })).message;
  const m3 = (await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: '3' })).message;
  for (const m of [m1, m2, m3]) await reactMessage(b.userId, chatId, m.id, '❤');
  expect(await ok(a, 'GET', `/chats/${chatId}/reactions/unread`)).toEqual({ ids: [m1.id, m2.id, m3.id], count: 3 });
  expect(await ok(a, 'POST', `/chats/${chatId}/reactions/read`, { ids: [m1.id] })).toEqual({ count: 2 });
  await deleteMessage(a.userId, chatId, m2.id);
  expect(await unreadOf(a, chatId)).toBe(1);
  expect(await ok(a, 'POST', `/chats/${chatId}/reactions/read`, {})).toEqual({ count: 0 });
  expect(await journalOf(a.userId, 'reactionsRead')).toEqual([
    { type: 'reactionsRead', chatId, ids: [m1.id] },
    { type: 'reactionsRead', chatId, ids: [m2.id] },
    { type: 'reactionsRead', chatId },
  ]);
  // чужой чат — не участник
  const x = await login('Чужой');
  const r = await fetch(`${base}/chats/${chatId}/reactions/unread`, { headers: hdr(x) });
  expect(r.status).not.toBe(200);
  expect(await sql`select count(*)::int as n from unread_reactions`).toEqual([{ n: 0 }]);
});
