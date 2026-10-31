import { afterAll, beforeEach, expect, test } from 'bun:test';
import type { Update } from '@relay/protocol';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { getUpdates } from '../src/domain/journal';
import { makeChat, resetDb, refs } from './helpers';

// Личный канал в профиле (как в Telegram): владелец публичного канала показывает его в профиле. Поле едет userUpdated;
// канал стал приватным, сменил владельца или удалён — поле сбрасывается само, зрителям — исправленный профиль.

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

type U = { userId: number; token: string };
const login = async (name: string): Promise<U> => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const call = (u: U, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { cookie: `relay_session=${u.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async (u: U, method: string, path: string, body?: unknown) => {
  const r = await call(u, method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
const code = async (u: U, method: string, path: string, body?: unknown) => { const r = await call(u, method, path, body); return [r.status, ((await r.json()) as { code?: string }).code]; };
const userUpdates = async (u: U) => (await getUpdates(u.userId, 0)).items.map((i) => i.update).filter((x): x is Extract<Update, { type: 'userUpdated' }> => x.type === 'userUpdated');
const lastSeen = async (viewer: U, of: U) => (await userUpdates(viewer)).filter((x) => x.user.id === of.userId).at(-1)?.user;

async function channel(owner: U, username: string | null, title = 'Новости', members: U[] = []): Promise<number> {
  const id = (await ok(owner, 'POST', '/chats', { kind: 'channel', title, members: refs(owner.userId, members.map((m) => m.userId)) })).id as number;
  if (username) await ok(owner, 'PUT', `/groups/${id}/username`, { username });
  return id;
}

test('the owner of a public channel puts it into the profile: /me, the peer and the journal see it', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  await makeChat([a.userId, b.userId]);
  const id = await channel(a, 'anna_news', 'Новости Анны', [c]);
  const me = await ok(a, 'PATCH', '/me', { personalChannelId: id });
  const pc = { id, title: 'Новости Анны', username: 'anna_news', photo: null, members: 2 };
  expect(me.personalChannel).toEqual(pc);
  expect((await ok(a, 'GET', '/me')).personalChannel).toEqual(pc);
  expect((await ok(b, 'GET', `/users/${a.userId}`)).personalChannel).toEqual(pc);
  expect((await ok(b, 'GET', `/users?ids=${a.userId}`)).users[0].personalChannel).toEqual(pc);
  expect((await lastSeen(b, a))?.personalChannel).toEqual(pc);

  await ok(a, 'PATCH', '/me', { personalChannelId: null });
  expect((await ok(a, 'GET', '/me')).personalChannel).toBeNull();
  expect((await lastSeen(b, a))?.personalChannel).toBeNull();
});

test('only an own public live channel: a foreign, private, deleted channel or a group is refused', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const foreign = await channel(b, 'boris_news', 'Борис', [a]);
  await ok(b, 'PUT', `/groups/${foreign}/admins/${a.userId}`, { rights: { info: true, post: true } });   // админ — ещё не владелец
  const priv = await channel(a, null);
  const gone = await channel(a, 'gone_news');
  await ok(a, 'DELETE', `/groups/${gone}`);
  const group = (await ok(a, 'POST', '/chats', { kind: 'group', title: 'Дача', members: refs(a.userId, [b.userId]) })).id as number;

  expect(await code(a, 'PATCH', '/me', { personalChannelId: foreign })).toEqual([403, 'forbidden']);
  expect(await code(a, 'PATCH', '/me', { personalChannelId: priv })).toEqual([403, 'forbidden']);
  expect(await code(a, 'PATCH', '/me', { personalChannelId: gone })).toEqual([403, 'forbidden']);
  expect(await code(a, 'PATCH', '/me', { personalChannelId: group })).toEqual([400, 'bad_frame']);
  expect(await code(a, 'PATCH', '/me', { personalChannelId: 999_999 })).toEqual([400, 'bad_frame']);
  expect(await code(a, 'PATCH', '/me', { personalChannelId: 'x' })).toEqual([400, 'bad_frame']);
  expect((await ok(a, 'GET', '/me')).personalChannel).toBeNull();
});

test('GET /me/personal-channels lists only own public live channels, by title', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const z = await channel(a, 'zeta_news', 'Яблоки');
  const x = await channel(a, 'alpha_news', 'Арбузы');
  await channel(a, null, 'Приватный');
  const gone = await channel(a, 'gone_news', 'Ушедший');
  await ok(a, 'DELETE', `/groups/${gone}`);
  const foreign = await channel(b, 'boris_news', 'Борис', [a]);
  await ok(b, 'PUT', `/groups/${foreign}/admins/${a.userId}`, { rights: { info: true } });
  await ok(a, 'POST', '/chats', { kind: 'group', title: 'Дача', members: refs(a.userId, [b.userId]) });
  const { channels } = await ok(a, 'GET', '/me/personal-channels');
  expect(channels).toEqual([
    { id: x, title: 'Арбузы', username: 'alpha_news', photo: null, members: 1 },
    { id: z, title: 'Яблоки', username: 'zeta_news', photo: null, members: 1 },
  ]);
});

test('the channel goes private → the field is cleared and viewers get the fixed profile', async () => {
  const a = await login('Анна'), b = await login('Борис');
  await makeChat([a.userId, b.userId]);
  const id = await channel(a, 'anna_news');
  await ok(a, 'PATCH', '/me', { personalChannelId: id });
  await ok(a, 'PUT', `/groups/${id}/username`, { username: null });
  const [u] = await sql`select personal_channel_id from users where id = ${a.userId}`;
  expect(u.personal_channel_id).toBeNull();
  expect((await lastSeen(b, a))?.personalChannel).toBeNull();
  expect((await lastSeen(a, a))?.personalChannel).toBeNull();
});

test('the channel is deleted → the field is cleared, viewers are told', async () => {
  const a = await login('Анна'), b = await login('Борис');
  await makeChat([a.userId, b.userId]);
  const id = await channel(a, 'anna_news');
  await ok(a, 'PATCH', '/me', { personalChannelId: id });
  await ok(a, 'DELETE', `/groups/${id}`);
  expect((await ok(b, 'GET', `/users/${a.userId}`)).personalChannel).toBeNull();
  expect((await lastSeen(b, a))?.personalChannel).toBeNull();
});

test('ownership passes to another → the former owner loses the channel in the profile', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  await makeChat([a.userId, b.userId]);
  const id = await channel(a, 'anna_news', 'Новости', [c]);
  await ok(a, 'PUT', `/groups/${id}/admins/${c.userId}`, { rights: { info: true, post: true } });
  await ok(a, 'PATCH', '/me', { personalChannelId: id });
  await ok(a, 'DELETE', `/groups/${id}/members/${a.userId}`);   // владелец вышел — канал у самого давнего админа
  expect((await ok(a, 'GET', '/me')).personalChannel).toBeNull();
  expect((await lastSeen(b, a))?.personalChannel).toBeNull();
});

test('a stale reference never leaks: the profile shows the channel only while it still qualifies', async () => {
  const a = await login('Анна'), b = await login('Борис');
  await makeChat([a.userId, b.userId]);
  const id = await channel(a, 'anna_news');
  await sql`update users set personal_channel_id = ${id} where id = ${a.userId}`;
  await sql`update chats set username = null where id = ${id}`;   // мимо groups.ts: сброса не было
  expect((await ok(b, 'GET', `/users/${a.userId}`)).personalChannel).toBeNull();
});
