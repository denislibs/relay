// Аудит безопасности 2026-10-25: скрытая история и уничтожение истории (AUTHZ-1…4, CRYPTO-1, 2, 7).
// Участник, вступивший при скрытой истории, не получает старое сообщение ни одним путём; «удалить для обоих»
// уничтожает и то, что на прошлое ссылается.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { startRealtime } from '../src/realtime';
import { sendMessage } from '../src/domain/messages';
import { editMessage } from '../src/domain/messageOps';
import { deleteDirectChat } from '../src/domain/chats';
import { makeChat, resetDb, uploadFile, refs } from './helpers';

const server = createServer({ port: 0 });
const stopRealtime = await startRealtime(server);
const base = `http://localhost:${server.port}`;
afterAll(async () => { await stopRealtime(); server.stop(true); });
beforeEach(resetDb);

type U = { userId: number; token: string };
const login = async (name: string): Promise<U> => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const call = (u: U, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, redirect: 'manual', headers: { cookie: `relay_session=${u.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async (u: U, method: string, path: string, body?: unknown) => {
  const r = await call(u, method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
const send = (u: U, chatId: number, body: string, attachment?: { id: string }) => sendMessage(u.userId, { chatId, clientId: crypto.randomUUID(), body, attachment });

/** Группа a+b, в ней старый текст и старый файл; история скрыта; c вступает позже. */
async function hiddenGroup() {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = (await ok(a, 'POST', '/chats', { title: 'Дача', members: refs(a.userId, [b.userId]) })).id as number;
  const old = (await send(a, id, 'тайное слово до вступления')).message;
  const file = await uploadFile(base, a.token, { name: 'план.pdf', mime: 'application/pdf' }, 'pdf-bytes');
  const oldFile = (await send(a, id, '', { id: file.id as string })).message;
  await ok(a, 'PUT', `/groups/${id}/settings`, { historyHidden: true });
  await ok(a, 'POST', `/groups/${id}/members`, { users: refs(a.userId, [c.userId]) });
  return { a, b, c, id, old, oldFile, fileId: file.id as string };
}

test('AUTHZ-1/2/3: a newcomer finds nothing from before joining — not by text search, not in media search, not by file id', async () => {
  const { b, c, fileId } = await hiddenGroup();
  expect((await ok(c, 'GET', '/search?q=' + encodeURIComponent('тайное'))).hits).toEqual([]);
  expect((await ok(b, 'GET', '/search?q=' + encodeURIComponent('тайное'))).hits).toHaveLength(1);   // старому участнику — как раньше
  expect((await ok(c, 'GET', '/search/media?kind=file')).hits).toEqual([]);
  expect((await ok(b, 'GET', '/search/media?kind=file')).hits).toHaveLength(1);
  expect((await call(c, 'GET', `/files/${fileId}`)).status).toBe(404);
  expect((await call(b, 'GET', `/files/${fileId}`)).status).toBe(302);
});

test('AUTHZ-4: an edit of a message from hidden history is not pushed to the group topic — sockets catch up via syncChat', async () => {
  const { a, c, id, old } = await hiddenGroup();
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { cookie: `relay_session=${c.token}` } } as never);
  const frames: string[] = [];
  ws.onmessage = (e) => frames.push(String(e.data));
  await new Promise((r) => { ws.onopen = r; });
  ws.send(JSON.stringify({ op: 'hello', lastSeq: 0 }));
  await Bun.sleep(300);
  await editMessage(a.userId, id, old.id, 'исправленное тайное слово');
  await Bun.sleep(500);
  ws.close();
  expect(frames.join('\n')).not.toContain('исправленное');
  // сам push о правке был — пустой (клиенты догонят чат через syncChat, где сервер фильтрует по history_from)
  const pushes = frames.map((f) => JSON.parse(f)).filter((f) => f.op === 'push' && f.chatId === id);
  expect(pushes.some((p) => Array.isArray(p.items) && p.items.length === 0)).toBe(true);
});

test('CRYPTO-1/2: «delete for both» also kills the files and the search documents of the past', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await makeChat([a.userId, b.userId]);
  const file = await uploadFile(base, a.token, { name: 'фото.pdf', mime: 'application/pdf' }, 'bytes');
  await send(a, chatId, '', { id: file.id as string });
  await sql`insert into keys.attachment_keys (attachment_id, wrapped, kek_id) values (${file.id as string}, ${Buffer.from([1, 2, 3])}, 'test')`;
  await send(a, chatId, 'старый текст');
  expect((await call(b, 'GET', `/files/${file.id}`)).status).toBe(302);
  await deleteDirectChat(a.userId, chatId, true);
  expect((await call(b, 'GET', `/files/${file.id}`)).status).toBe(404);   // файл прошлого больше не выдаётся
  expect(await sql`select 1 from keys.attachment_keys where attachment_id = ${file.id as string}`).toHaveLength(0);   // ключ файла уничтожен
  const left = await sql`select count(*)::int as n from messages where chat_id = ${chatId} and (not deleted or attachment is not null or content is not null)`;
  expect(left[0].n).toBe(0);
  const [job] = await sql`select payload from jobs where kind = 'search.purgeChat'`;
  expect(job.payload).toMatchObject({ chatId });
});

test('CRYPTO-2: a file forwarded elsewhere keeps its key when the original chat is shredded', async () => {
  const a = await login('Анна'), b = await login('Борис'), d = await login('Дима');
  const ab = await makeChat([a.userId, b.userId]), ad = await makeChat([a.userId, d.userId]);
  const file = await uploadFile(base, a.token, { name: 'общий.pdf', mime: 'application/pdf' }, 'bytes');
  await send(a, ab, '', { id: file.id as string });
  await send(a, ad, '', { id: file.id as string });
  await sql`insert into keys.attachment_keys (attachment_id, wrapped, kek_id) values (${file.id as string}, ${Buffer.from([1])}, 'test')`;
  await deleteDirectChat(a.userId, ab, true);
  expect(await sql`select 1 from keys.attachment_keys where attachment_id = ${file.id as string}`).toHaveLength(1);
  expect((await call(d, 'GET', `/files/${file.id}`)).status).toBe(302);
});

test('CRYPTO-7: deleting a group destroys its keys at once, before the paged purge', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = (await ok(a, 'POST', '/chats', { title: 'Дача', members: refs(a.userId, [b.userId]) })).id as number;
  await send(a, id, 'что-то');
  expect((await sql`select 1 from keys.chat_keys where chat_id = ${id}`).length).toBeGreaterThan(0);
  await ok(a, 'DELETE', `/groups/${id}`);
  expect(await sql`select 1 from keys.chat_keys where chat_id = ${id}`).toHaveLength(0);
  expect((await sql`select 1 from jobs where kind = 'search.purgeChat'`).length).toBe(1);
});
