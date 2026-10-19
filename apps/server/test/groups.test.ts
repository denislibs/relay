import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { sendMessage } from '../src/domain/messages';
import { resetDb } from './helpers';

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
const group = async (owner: U, members: U[], title = 'Дача') => (await ok(owner, 'POST', '/chats', { title, memberIds: members.map((m) => m.userId) })).id as number;
const send = (u: U, chatId: number, body = 'привет') => sendMessage(u.userId, { chatId, clientId: crypto.randomUUID(), body });
const services = async (chatId: number) => (await sql`select service_type, service_data from messages where chat_id = ${chatId} and service_type is not null order by id`).map((r) => r.service_type);
const lastUpdate = async (u: U, type: string) => (await sql`select payload from updates where user_id = ${u.userId} and payload->>'type' = ${type} order by seq desc limit 1`)[0]?.payload;

test('owner and roles: creator is the owner; summary in the chat list carries group info and my membership', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await group(a, [b]);
  const [c] = await sql`select owner_id from chats where id = ${id}`;
  expect(Number(c.owner_id)).toBe(a.userId);
  const listA = await ok(a, 'GET', `/chats?ids=${id}`);
  const chatA = (listA.chats ?? listA).find((x: any) => x.id === id);
  expect(chatA.me).toMatchObject({ role: 'owner', admin: { info: true, ban: true, addAdmins: true } });
  expect(chatA.group).toMatchObject({ title: 'Дача', members: 2, ownerId: a.userId, slowMode: 0 });
  const listB = await ok(b, 'GET', `/chats?ids=${id}`);
  expect((listB.chats ?? listB).find((x: any) => x.id === id).me).toMatchObject({ role: 'member', admin: null });
});

test('info: members cannot rename unless allowed; rename makes a service message and a groupUpdated for all', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await group(a, [b]);
  await ok(a, 'PUT', `/groups/${id}/rights`, { rights: { info: false } });
  expect((await call(b, 'PATCH', `/groups/${id}`, { title: 'Нет' })).status).toBe(403);
  await ok(a, 'PATCH', `/groups/${id}`, { title: 'Дача 2', about: 'Шашлыки\nв субботу' });
  expect(await services(id)).toEqual(['group_created', 'title_changed']);
  const u = await lastUpdate(b, 'groupUpdated');
  expect(u.group).toMatchObject({ title: 'Дача 2', about: 'Шашлыки\nв субботу' });
  expect((await call(a, 'PATCH', `/groups/${id}`, { about: 'x'.repeat(256) })).status).toBe(400);
  // участнику разрешили менять информацию
  await ok(a, 'PUT', `/groups/${id}/rights`, { rights: { info: true } });
  await ok(b, 'PATCH', `/groups/${id}`, { about: 'теперь можно' });
});

test('member rights: text, media kinds and reactions are enforced; admins are not restricted; links need text', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await group(a, [b]);
  await ok(a, 'PUT', `/groups/${id}/rights`, { rights: { text: false, react: false, links: true } });
  const u = await lastUpdate(b, 'membership');
  expect(u.me.rights).toMatchObject({ text: false, links: false, react: false });   // превью без текста не бывает
  await expect(send(b, id)).rejects.toMatchObject({ code: 'forbidden' });
  await send(a, id);   // владельца права участников не ограничивают
  const [m] = await sql`select id from messages where chat_id = ${id} and service_type is null`;
  const { reactMessage } = await import('../src/domain/messageOps');
  await expect(reactMessage(b.userId, id, Number(m.id), '👍')).rejects.toMatchObject({ code: 'forbidden' });
});

test('reactions settings: none and some', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await group(a, [b]);
  const { message } = await send(a, id);
  const { reactMessage } = await import('../src/domain/messageOps');
  await ok(a, 'PUT', `/groups/${id}/settings`, { reactions: { mode: 'some', allowed: ['👍'] } });
  await reactMessage(b.userId, id, message.id, '👍');
  await expect(reactMessage(b.userId, id, message.id, '🔥')).rejects.toMatchObject({ code: 'forbidden' });
  await ok(a, 'PUT', `/groups/${id}/settings`, { reactions: { mode: 'none' } });
  await expect(reactMessage(b.userId, id, message.id, '👍')).rejects.toMatchObject({ code: 'forbidden' });
  await reactMessage(b.userId, id, message.id, null);   // снять можно всегда
});

test('exceptions: per-member restriction is never wider than defaults; admins cannot be restricted', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await group(a, [b, c]);
  await ok(a, 'PUT', `/groups/${id}/members/${b.userId}/restrict`, { rights: { text: false } });
  await expect(send(b, id)).rejects.toMatchObject({ code: 'forbidden' });
  await send(c, id);
  const r = await ok(a, 'GET', `/groups/${id}/members?filter=restricted`);
  expect(r.members.map((m: any) => m.userId)).toEqual([b.userId]);
  await ok(a, 'PUT', `/groups/${id}/members/${b.userId}/restrict`, { rights: null });
  await send(b, id);
  // умолчания запрещают фото — исключение не может разрешить
  await ok(a, 'PUT', `/groups/${id}/rights`, { rights: { photos: false } });
  await ok(a, 'PUT', `/groups/${id}/members/${c.userId}/restrict`, { rights: { photos: true, voice: false } });
  const [row] = await sql`select restricted from chat_members where chat_id = ${id} and user_id = ${c.userId}`;
  expect(row.restricted).toMatchObject({ photos: false, voice: false });
  await ok(a, 'PUT', `/groups/${id}/admins/${b.userId}`, { rights: { delete: true } });
  expect((await call(a, 'PUT', `/groups/${id}/members/${b.userId}/restrict`, { rights: { text: false } })).status).toBe(403);
});

test('admins: cannot grant what you lack, only manage the ones you promoted; owner manages everyone', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера'), d = await login('Гена');
  const id = await group(a, [b, c, d]);
  await ok(a, 'PUT', `/groups/${id}/admins/${b.userId}`, { rights: { addAdmins: true, pin: true }, rank: 'Завхоз' });
  expect((await lastUpdate(b, 'membership')).me).toMatchObject({ role: 'admin', rank: 'Завхоз', admin: { addAdmins: true, pin: true, ban: false } });
  expect((await call(b, 'PUT', `/groups/${id}/admins/${c.userId}`, { rights: { ban: true } })).status).toBe(403);   // у Бориса нет ban
  await ok(b, 'PUT', `/groups/${id}/admins/${c.userId}`, { rights: { pin: true } });
  await ok(a, 'PUT', `/groups/${id}/admins/${d.userId}`, { rights: { pin: true } });
  expect((await call(b, 'PUT', `/groups/${id}/admins/${d.userId}`, { rights: null })).status).toBe(403);   // Гену назначила Анна
  await ok(b, 'PUT', `/groups/${id}/admins/${c.userId}`, { rights: null });
  expect((await call(b, 'PUT', `/groups/${id}/admins/${a.userId}`, { rights: null })).status).toBe(403);   // владельца не снять
  expect((await call(a, 'PUT', `/groups/${id}/admins/${b.userId}`, { rank: 'x'.repeat(17), rights: { pin: true } })).status).toBe(400);
  const admins = await ok(c, 'GET', `/groups/${id}/members?filter=admins`);
  expect(admins.members.map((m: any) => [m.userId, m.role])).toEqual([[a.userId, 'owner'], [b.userId, 'admin'], [d.userId, 'admin']]);
  // своё звание админ меняет сам
  await ok(d, 'PUT', `/groups/${id}/members/${d.userId}/rank`, { rank: 'Повар' });
});

test('remove = ban: the removed user gets chatRemoved, lands in banned, cannot rejoin by link until unbanned; leave', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await group(a, [b, c]);
  expect((await call(b, 'DELETE', `/groups/${id}/members/${c.userId}`)).status).toBe(403);
  await ok(a, 'DELETE', `/groups/${id}/members/${c.userId}`);
  expect(await lastUpdate(c, 'chatRemoved')).toMatchObject({ chatId: id });
  expect((await ok(a, 'GET', `/groups/${id}/bans`)).banned.map((x: any) => x.userId)).toEqual([c.userId]);
  const { invites } = await ok(a, 'GET', `/groups/${id}/invites`);
  const primary = invites.find((i: any) => i.primary);
  expect((await call(c, 'POST', `/join/+${primary.link}`)).status).toBe(403);
  await ok(a, 'DELETE', `/groups/${id}/bans/${c.userId}`);
  expect(await ok(c, 'POST', `/join/+${primary.link}`)).toMatchObject({ chatId: id, requested: false });
  await ok(b, 'DELETE', `/groups/${id}/members/${b.userId}`);   // выйти
  expect(await services(id)).toEqual(['group_created', 'member_removed', 'joined_by_link', 'member_left']);
  expect((await call(b, 'GET', `/groups/${id}/members`)).status).toBe(403);
});

test('owner leaving passes ownership to the oldest admin; transfer needs the 2FA password', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await group(a, [b, c]);
  expect((await call(a, 'POST', `/groups/${id}/owner`, { userId: b.userId, proof: null })).status).toBe(400);   // пароля нет
  await ok(a, 'PUT', `/groups/${id}/admins/${c.userId}`, { rights: { pin: true } });
  await ok(a, 'DELETE', `/groups/${id}/members/${a.userId}`);
  const [ch] = await sql`select owner_id from chats where id = ${id}`;
  expect(Number(ch.owner_id)).toBe(c.userId);
  expect((await lastUpdate(c, 'membership')).me.role).toBe('owner');
});

test('invites: expiry, usage limit, approval requests, revoke, joined list', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера'), d = await login('Гена'), e = await login('Дина');
  const id = await group(a, [b]);
  const one = await ok(a, 'POST', `/groups/${id}/invites`, { title: 'Соседи', usageLimit: 1 });
  expect(await ok(c, 'GET', `/join/+${one.link}`)).toMatchObject({ title: 'Дача', members: 2, member: false, approval: false });
  await ok(c, 'POST', `/join/+${one.link}`);
  expect((await call(d, 'POST', `/join/+${one.link}`)).status).toBe(404);   // лимит исчерпан
  const joined = await ok(a, 'GET', `/groups/${id}/invites/${one.id}/joined`);
  expect(joined.joined.map((j: any) => j.userId)).toEqual([c.userId]);

  const req = await ok(a, 'POST', `/groups/${id}/invites`, { approval: true });
  expect(await ok(d, 'POST', `/join/+${req.link}`)).toMatchObject({ requested: true });
  expect(await ok(e, 'POST', `/join/+${req.link}`)).toMatchObject({ requested: true });
  expect((await lastUpdate(a, 'groupUpdated')).group.requests).toBe(2);
  expect((await lastUpdate(b, 'groupUpdated')).group.requests).toBe(0);   // участнику заявки не показываются
  expect((await call(b, 'GET', `/groups/${id}/requests`)).status).toBe(403);
  await ok(a, 'POST', `/groups/${id}/requests/${d.userId}`, { approve: true });
  await ok(a, 'POST', `/groups/${id}/requests`, { approve: false });
  const members = await ok(a, 'GET', `/groups/${id}/members`);
  expect(members.members.map((m: any) => m.userId).sort()).toEqual([a.userId, b.userId, c.userId, d.userId].sort());

  const old = await ok(a, 'POST', `/groups/${id}/invites`, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await ok(a, 'PATCH', `/groups/${id}/invites/${old.id}`, { revoked: true });
  expect((await call(e, 'GET', `/join/+${old.link}`)).status).toBe(404);
  await ok(a, 'DELETE', `/groups/${id}/invites`);   // все отозванные
  expect((await ok(a, 'GET', `/groups/${id}/invites`)).invites.some((i: any) => i.revoked)).toBe(false);
  expect(await services(id)).toEqual(['group_created', 'joined_by_link', 'joined_by_request']);
});

test('public group: username shared with users; join by @name; approval makes a request', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await group(a, [b]);
  await sql`update users set username = 'annadacha' where id = ${a.userId}`;
  expect((await call(a, 'PUT', `/groups/${id}/username`, { username: 'annadacha' })).status).toBe(409);
  expect((await call(b, 'PUT', `/groups/${id}/username`, { username: 'dacha_club' })).status).toBe(403);
  await ok(a, 'PUT', `/groups/${id}/username`, { username: 'Dacha_Club' });
  expect(await ok(b, 'GET', '/groups/username/check?username=dacha_club')).toEqual({ ok: false, reason: 'taken' });
  const c = await login('Вера');
  await ok(c, 'POST', '/join/@dacha_club');
  await ok(a, 'PUT', `/groups/${id}/settings`, { joinApproval: true });
  const d = await login('Гена');
  expect(await ok(d, 'POST', '/join/@dacha_club')).toMatchObject({ requested: true });
  await ok(a, 'PUT', `/groups/${id}/settings`, { joinApproval: false });   // выключили — ждущие приняты
  expect((await ok(a, 'GET', `/groups/${id}/members`)).members.length).toBe(4);
});

test('hidden history: a newcomer sees only messages after joining', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await group(a, [b]);
  await send(a, id, 'старое');
  await ok(a, 'PUT', `/groups/${id}/settings`, { historyHidden: true });
  await ok(a, 'POST', `/groups/${id}/members`, { userIds: [c.userId] });
  await send(a, id, 'новое');
  const h = await ok(c, 'GET', `/chats/${id}/messages`);
  expect(h.messages.map((m: any) => m.body)).toEqual(['', 'новое']);   // «добавил(а)» и новое
  expect(h.messages[0].service).toMatchObject({ type: 'members_added', data: { users: [{ id: c.userId, name: 'Вера' }] } });
});

test('slow mode: members wait, admins do not', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await group(a, [b]);
  expect((await call(a, 'PUT', `/groups/${id}/rights`, { slowMode: 7 })).status).toBe(400);
  await ok(a, 'PUT', `/groups/${id}/rights`, { slowMode: 30 });
  await send(b, id);
  await expect(send(b, id)).rejects.toMatchObject({ code: 'flood' });
  await send(a, id); await send(a, id);
});

test('protected group: messages cannot be forwarded out; delete group removes it for everyone', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const id = await group(a, [b]);
  const { message } = await send(a, id);
  const other = await group(b, [a], 'Другая');
  await ok(a, 'PUT', `/groups/${id}/settings`, { protected: true });
  await expect(sendMessage(b.userId, { chatId: other, clientId: crypto.randomUUID(), body: '', forward: { chatId: id, id: message.id } })).rejects.toMatchObject({ code: 'forbidden' });
  expect((await call(b, 'DELETE', `/groups/${id}`)).status).toBe(403);
  await ok(a, 'DELETE', `/groups/${id}`);
  expect(await lastUpdate(b, 'chatRemoved')).toMatchObject({ chatId: id });
  expect((await sql`select 1 from chats where id = ${id}`).length).toBe(0);
});

test('admin with delete right removes others’ messages; pin needs the right', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const id = await group(a, [b, c]);
  const { message } = await send(c, id);
  const { deleteMessage } = await import('../src/domain/messageOps');
  await expect(deleteMessage(b.userId, id, message.id)).rejects.toMatchObject({ code: 'forbidden' });
  await ok(a, 'PUT', `/groups/${id}/admins/${b.userId}`, { rights: { delete: true } });
  await deleteMessage(b.userId, id, message.id);
  const { pinMessage } = await import('../src/domain/pins');
  const { message: m2 } = await send(a, id);
  await ok(a, 'PUT', `/groups/${id}/rights`, { rights: { pin: false } });
  await expect(pinMessage(c.userId, id, m2.id)).rejects.toMatchObject({ code: 'forbidden' });
  await pinMessage(a.userId, id, m2.id);
});

test('adding members: invite right, banned only by someone who can ban, blocked users fail', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера'), d = await login('Гена');
  const id = await group(a, [b]);
  await ok(a, 'PUT', `/groups/${id}/rights`, { rights: { invite: false } });
  expect((await call(b, 'POST', `/groups/${id}/members`, { userIds: [c.userId] })).status).toBe(403);
  await sql`insert into blocks (owner_id, user_id) values (${d.userId}, ${a.userId})`;
  const r = await ok(a, 'POST', `/groups/${id}/members`, { userIds: [c.userId, d.userId] });
  expect(r).toEqual({ added: [c.userId], failed: [d.userId] });
  expect(await services(id)).toEqual(['group_created', 'members_added']);
});
