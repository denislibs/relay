import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { sendMessage } from '../src/domain/messages';
import { markRead, READ_BY_MAX } from '../src/domain/reads';
import { setLinkedChat } from '../src/domain/groups';
import { makeChat, resetDb, refs } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

type U = { userId: number; token: string };
const login = async (name: string): Promise<U> => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const hdr = (u: U) => ({ cookie: `relay_session=${u.token}`, 'content-type': 'application/json' });
const call = (u: U, method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: hdr(u), body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async (u: U, method: string, path: string, body?: unknown) => {
  const r = await call(u, method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
const code = async (u: U, path: string) => { const r = await call(u, 'GET', path); return r.status === 200 ? 'ok' : ((await r.json()) as { code: string }).code; };
const send = (u: U, chatId: number, body: string, extra: Record<string, unknown> = {}) => sendMessage(u.userId, { chatId, clientId: crypto.randomUUID(), body, ...extra }).then((r) => r.message);
const readBy = (u: U, chatId: number, id: number) => ok(u, 'GET', `/chats/${chatId}/messages/${id}/read-by`);

test('group: the author sees who read (names as the author sees them), not themself; others are forbidden', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера'), d = await login('Глеб');
  const g = (await ok(a, 'POST', '/chats', { title: 'Группа', members: refs(a.userId, [b.userId, c.userId, d.userId]) })).id as number;
  const m = await send(a, g, 'всем');
  const later = await send(a, g, 'потом');
  await markRead(b.userId, g, later.id);
  await markRead(c.userId, g, m.id);
  await sql`insert into contacts (owner_id, user_id, first_name, last_name) values (${a.userId}, ${c.userId}, 'Верочка', '')`;
  expect(await readBy(a, g, m.id)).toEqual([{ id: b.userId, name: 'Борис' }, { id: c.userId, name: 'Верочка' }]);
  expect(await readBy(a, g, later.id)).toEqual([{ id: b.userId, name: 'Борис' }]);
  expect(await code(b, `/chats/${g}/messages/${m.id}/read-by`)).toBe('forbidden');   // не автор
  expect(await code(a, `/chats/${g}/messages/999999/read-by`)).toBe('not_found');
});

test('only groups up to READ_BY_MAX members; direct chats are bad_frame; comments and post copies are rejected', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const dm = await makeChat([a.userId, b.userId], 'direct');
  const dmMsg = await send(a, dm, 'лично');
  expect(await code(a, `/chats/${dm}/messages/${dmMsg.id}/read-by`)).toBe('bad_frame');
  const g = (await ok(a, 'POST', '/chats', { title: 'Группа', members: refs(a.userId, [b.userId]) })).id as number;
  const m = await send(a, g, 'x');
  await sql`update chats set members_count = ${READ_BY_MAX + 1} where id = ${g}`;
  expect(await code(a, `/chats/${g}/messages/${m.id}/read-by`)).toBe('forbidden');
  await sql`update chats set members_count = ${READ_BY_MAX} where id = ${g}`;
  expect(await readBy(a, g, m.id)).toEqual([]);
  // канал с группой обсуждения: копия поста и комментарий в группе — без «кто прочитал»
  const ch = (await ok(a, 'POST', '/chats', { kind: 'channel', title: 'Новости', members: refs(a.userId, [b.userId]) })).id as number;
  expect(await code(a, `/chats/${ch}/messages/${(await send(a, ch, 'пост')).id}/read-by`)).toBe('bad_frame');
  await sql`update chats set members_count = 2 where id = ${g}`;
  await setLinkedChat(a.userId, ch, g);
  const post = await send(a, ch, 'пост 2');
  const copyId = Number((await sql`select copy_id from message_threads where chat_id = ${ch} and post_id = ${post.id}`)[0].copy_id);
  expect(await code(a, `/chats/${g}/messages/${copyId}/read-by`)).toBe('bad_frame');
  const k = await send(a, g, 'коммент', { threadId: copyId });
  expect(await code(a, `/chats/${g}/messages/${k.id}/read-by`)).toBe('bad_frame');
});
