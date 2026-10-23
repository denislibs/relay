import { afterAll, beforeEach, expect, test } from 'bun:test';
import { countChats, listChats } from '../src/domain/chats';
import { PIN_LIMIT, setChatFlags } from '../src/domain/chatFlags';
import { setChatNotify } from '../src/domain/chatNotify';
import { getUpdates } from '../src/domain/journal';
import { sendMessage } from '../src/domain/messages';
import { markRead } from '../src/domain/reads';
import { createServer } from '../src/http';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const send = (u: number, chat: number, body = 'm') => sendMessage(u, { chatId: chat, clientId: crypto.randomUUID(), body }).then((r) => r.message.id);
const flagsOf = async (userId: number, chatId: number) => (await listChats(userId, { ids: [chatId] }))[0];
const flagUpdates = async (userId: number) => (await getUpdates(userId, 0)).items.map((i) => i.update).filter((u) => u.type === 'chatFlags');

test('pin: newest pin first, limit per list, journal of own devices only, unpin', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chats: number[] = [];
  for (let i = 0; i < PIN_LIMIT + 1; i++) chats.push(await makeChat([a, await makeUser('u' + i)]));
  for (let i = 0; i < PIN_LIMIT; i++) { await setChatFlags(a, chats[i], { pinned: true }); await Bun.sleep(2); }
  await expect(setChatFlags(a, chats[PIN_LIMIT], { pinned: true })).rejects.toMatchObject({ code: 'pin_limit' });
  const pinned = (await listChats(a, { pinnedOnly: true })).sort((x, y) => y.pinnedAt! - x.pinnedAt!);
  expect(pinned.map((c) => c.id)).toEqual(chats.slice(0, PIN_LIMIT).reverse());   // позже закреплённый — выше
  // повторное «закрепить» ничего не меняет и не пишет в журнал
  const before = (await flagUpdates(a)).length;
  await setChatFlags(a, chats[0], { pinned: true });
  expect((await flagUpdates(a)).length).toBe(before);
  expect(await flagUpdates(b)).toEqual([]);
  expect(await setChatFlags(a, chats[0], { pinned: false })).toEqual({ pinnedAt: null, archived: false, unreadMark: false, archivedAtId: 0 });
  await setChatFlags(a, chats[PIN_LIMIT], { pinned: true });   // место освободилось
  await expect(setChatFlags(a, chats[0], { pinned: 'yes' })).rejects.toMatchObject({ code: 'bad_frame' });
});

test('archive: unpins, own pin limit, out of «All» total; a new message brings an unmuted chat back, a muted one stays', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const ab = await makeChat([a, b]), ac = await makeChat([a, c]);
  await setChatFlags(a, ab, { pinned: true });
  expect(await setChatFlags(a, ab, { archived: true })).toEqual({ pinnedAt: null, archived: true, unreadMark: false, archivedAtId: 0 });   // сообщений ещё нет
  await setChatFlags(a, ac, { archived: true });
  expect(await countChats(a)).toBe(0);
  expect((await listChats(a, { archivedOnly: true })).map((x) => x.id).sort()).toEqual([ab, ac].sort());
  await setChatFlags(a, ab, { pinned: true });   // закрепить в архиве — свой список
  expect((await flagsOf(a, ab)).pinnedAt).not.toBeNull();
  await setChatNotify(a, ac, { muteUntil: 0 });
  await send(b, ab); await send(c, ac); await send(a, ab);
  expect(await flagsOf(a, ab)).toMatchObject({ archived: false, pinnedAt: null });   // вернулся, закрепление архива снято
  expect((await flagsOf(a, ac)).archived).toBe(true);                               // заглушённый — остаётся
  expect(await countChats(a)).toBe(1);
  expect((await flagUpdates(a)).at(-1)).toMatchObject({ type: 'chatFlags', chatId: ab, archived: false });
  // своё сообщение в архивном чате его не достаёт
  await setChatFlags(b, ab, { archived: true });
  await send(b, ab);
  expect((await flagsOf(b, ab)).archived).toBe(true);
});

test('unread mark: set by hand, counts as unread, cleared by reading on any device', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const ab = await makeChat([a, b]);
  const id = await send(b, ab);
  await markRead(a, ab, id);
  expect((await listChats(a, { unreadOnly: true })).length).toBe(0);
  expect(await setChatFlags(a, ab, { unreadMark: true })).toMatchObject({ unreadMark: true });
  expect((await listChats(a, { unreadOnly: true })).map((x) => x.id)).toEqual([ab]);
  await markRead(a, ab, id);   // ничего нового не прочитано, но чат открыли — пометка снимается
  expect((await flagsOf(a, ab)).unreadMark).toBe(false);
  expect((await flagUpdates(a)).map((u) => (u as { unreadMark: boolean }).unreadMark)).toEqual([true, false]);
});

test('HTTP: PUT /chats/:id/flags and list filters ?pinned=1, ?archived=1; strangers get 403', async () => {
  const server = createServer({ port: 0 });
  const base = `http://localhost:${server.port}`;
  try {
    const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
    const a = await login('Анна'), b = await login('Борис'), x = await login('Чужой');
    const chat = await makeChat([a.userId, b.userId]);
    const put = (t: string, body: unknown) => fetch(`${base}/chats/${chat}/flags`, { method: 'PUT', headers: { cookie: `relay_session=${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await put(a.token, { pinned: true, unreadMark: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ archived: false, unreadMark: true });
    expect((await put(x.token, { pinned: true })).status).toBe(403);
    const get = async (q: string) => ((await (await fetch(`${base}/chats?${q}`, { headers: { cookie: `relay_session=${a.token}` } })).json()) as { id: number }[]).map((c) => c.id);
    expect(await get('pinned=1')).toEqual([chat]);
    expect(await get('archived=1')).toEqual([]);
  } finally { server.stop(true); }
});
