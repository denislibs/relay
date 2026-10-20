import { afterAll, beforeEach, expect, test } from 'bun:test';
import { defaultPrivacy, type PrivacyRule, type ServerFrame, type Update } from '@relay/protocol';
import { sql } from '../src/db';
import '../src/jobs/kinds';
import { drainJobs } from '../src/jobs/worker';
import { getUpdates } from '../src/domain/journal';
import { sendMessage } from '../src/domain/messages';
import { canFindByPhone, canSee, canSeeLastSeen, type PrivacyCtx } from '../src/domain/privacy';
import { resetPresence } from '../src/domain/presence';
import { createServer } from '../src/http';
import { startRealtime } from '../src/realtime';
import { handleFrame } from '../src/ws';
import { makeChat, makeUser, nextFrame, opened, pushBrowser, resetDb } from './helpers';

process.env.RELAY_PRESENCE_GRACE_MS = '60';
const server = createServer({ port: 0 });
const stopRealtime = await startRealtime(server);
const base = `http://localhost:${server.port}`;
afterAll(async () => { await stopRealtime(); server.stop(true); push.stop(true); });
beforeEach(async () => { await resetDb(); resetPresence(); got.length = 0; });

type U = { userId: number; token: string };
const login = async (name: string, phone?: string): Promise<U> => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name, phone }) })).json()) as U;
const call = (u: U, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { cookie: `relay_session=${u.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const rule = (u: U, key: string, r: Partial<PrivacyRule>) => call(u, 'PUT', `/privacy/${key}`, { allow: [], deny: [], ...r });
const journal = async (userId: number) => (await getUpdates(userId, 0)).items.map((i) => i.update);
const ofType = <T extends Update['type']>(us: Update[], t: T) => us.filter((u): u is Extract<Update, { type: T }> => u.type === t);
const presenceOf = async (u: U) => (await (await call(u, 'GET', '/presence')).json()) as { userId: number; online: boolean | null; lastSeen: string | null }[];
const userOf = async (u: U, id: number) => (await call(u, 'GET', `/users/${id}`)).json();
async function connect(u: U): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?token=${u.token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return ws;
}
const frames = (ws: WebSocket, op: string) => {
  const seen: ServerFrame[] = [];
  ws.addEventListener('message', (e) => { const f = JSON.parse(String(e.data)) as ServerFrame; if (f.op === op) seen.push(f); });
  return seen;
};

// ---------- таблица истинности ----------

test('canSee truth table: self, deny > allow > mode, contacts = owner added viewer, block hides everything', () => {
  const O = 1, V = 2;
  const ctx = (mode: PrivacyRule['mode'], list: 'allow' | 'deny' | null, contact: boolean, blocked: boolean): PrivacyCtx => {
    const rules = defaultPrivacy();
    rules.bio = { mode, allow: list === 'allow' ? [V] : [], deny: list === 'deny' ? [V] : [] };
    return { rules: new Map([[O, rules]]), contacts: new Set(contact ? ['1:2'] : []), blocks: new Set(blocked ? ['1:2'] : []) };
  };
  const rows: [PrivacyRule['mode'], 'allow' | 'deny' | null, boolean, boolean, boolean][] = [
    // mode,      list,    contact, blocked → видно
    ['everyone', null, false, false, true],
    ['everyone', 'deny', false, false, false],
    ['everyone', 'allow', false, false, true],
    ['everyone', null, false, true, false],
    ['contacts', null, false, false, false],
    ['contacts', null, true, false, true],
    ['contacts', 'deny', true, false, false],
    ['contacts', 'allow', false, false, true],
    ['contacts', null, true, true, false],
    ['nobody', null, true, false, false],
    ['nobody', 'allow', false, false, true],
    ['nobody', 'deny', false, false, false],
    ['nobody', 'allow', true, true, false],
  ];
  for (const [mode, list, contact, blocked, want] of rows) {
    const c = ctx(mode, list, contact, blocked);
    expect([mode, list, contact, blocked, canSee(V, O, 'bio', c)]).toEqual([mode, list, contact, blocked, want]);
    expect(canSee(O, O, 'bio', c)).toBe(true);   // своё — всегда
  }
  // умолчания: номер — контактам, остальное — всем
  const empty: PrivacyCtx = { rules: new Map(), contacts: new Set(), blocks: new Set() };
  expect(canSee(V, O, 'phone', empty)).toBe(false);
  expect(canSee(V, O, 'phone', { ...empty, contacts: new Set(['1:2']) })).toBe(true);
  expect(canSee(V, O, 'phone', { ...empty, contacts: new Set(['2:1']) })).toBe(false);   // в контактах у зрителя — не считается
  for (const k of ['lastSeen', 'bio', 'birthday'] as const) expect(canSee(V, O, k, empty)).toBe(true);
  expect(canFindByPhone(V, O, empty)).toBe(true);
  // взаимность: скрывший своё время не видит чужое; блокировка на взаимность не влияет
  const hider = defaultPrivacy(); hider.lastSeen = { mode: 'nobody', allow: [], deny: [] };
  expect(canSeeLastSeen(V, O, { ...empty, rules: new Map([[V, hider]]) })).toBe(false);
  expect(canSeeLastSeen(O, V, { ...empty, rules: new Map([[V, hider]]) })).toBe(false);
  hider.lastSeen = { mode: 'nobody', allow: [O], deny: [] };
  expect(canSeeLastSeen(V, O, { ...empty, rules: new Map([[V, hider]]) })).toBe(true);   // V показывает время O — и видит его
  expect(canSeeLastSeen(V, O, { ...empty, blocks: new Set(['2:1']) })).toBe(true);        // V заблокировал O, но видит его
});

// ---------- API правил ----------

test('GET /settings has privacy defaults; PUT /privacy/:key validates and normalizes lists; privacyChanged to self', async () => {
  const a = await login('Анна'), b = await login('Борис'), v = await login('Вера'), stranger = await login('Чужой');
  await makeChat([a.userId, b.userId]); await makeChat([a.userId, v.userId]);
  expect((await (await call(a, 'GET', '/settings')).json()).privacy).toEqual(defaultPrivacy());
  for (const [key, body] of [['photo', { mode: 'everyone' }], ['bio', { mode: 'all' }], ['phoneDiscovery', { mode: 'nobody' }], ['bio', { mode: 'nobody', allow: ['x'] }], ['bio', null], ['bio', { mode: 'nobody', allow: Array.from({ length: 1001 }, (_, i) => i + 10_000) }]] as const) {
    expect([key, (await call(a, 'PUT', `/privacy/${key}`, body)).status]).toEqual([key, 400]);
  }
  // себя, несуществующих, незнакомых и повторы — вон (не отличая «нет такого» от «не знакомы»); в обоих списках — только deny
  const r = await rule(a, 'bio', { mode: 'contacts', allow: [b.userId, b.userId, a.userId, 99999, stranger.userId, v.userId], deny: [v.userId] });
  expect(r.status).toBe(200);
  const s = await r.json();
  expect(s.privacy.bio).toEqual({ mode: 'contacts', allow: [b.userId], deny: [v.userId] });
  expect(s.notify).toBeDefined();
  expect(s.seq).toBe(1);
  // повтор того же — журнал не трогает
  expect((await (await rule(a, 'bio', { mode: 'contacts', allow: [b.userId], deny: [v.userId] })).json()).seq).toBe(1);
  // у «Кто найдёт по номеру» исключений нет
  expect((await (await rule(a, 'phoneDiscovery', { mode: 'contacts', allow: [b.userId] })).json()).privacy.phoneDiscovery).toEqual({ mode: 'contacts', allow: [], deny: [] });
  const own = ofType(await journal(a.userId), 'privacyChanged');
  expect(own.length).toBe(2);
  expect(own[1].rules.bio).toEqual({ mode: 'contacts', allow: [b.userId], deny: [v.userId] });
  expect(own[1].rules.phoneDiscovery.mode).toBe('contacts');
  expect(ofType(await journal(b.userId), 'privacyChanged')).toEqual([]);
  expect((await fetch(`${base}/privacy/bio`, { method: 'PUT', body: '{}' })).status).toBe(401);
});

// ---------- профиль ----------

test('publicUser hides phone/bio/birthday by rule (HTTP); allow list and contacts open them', async () => {
  const a = await login('Анна', '+79001112233'), b = await login('Борис'), v = await login('Вера');
  await makeChat([a.userId, b.userId]); await makeChat([a.userId, v.userId]);
  await call(a, 'PATCH', '/me', { bio: 'о себе', birthday: { day: 3, month: 4 } });
  expect(await userOf(b, a.userId)).toMatchObject({ bio: 'о себе', birthday: { day: 3, month: 4 }, phone: null });   // номер по умолчанию — контактам
  await call(a, 'POST', '/contacts', { userId: b.userId, firstName: 'Борис' });
  expect((await userOf(b, a.userId)).phone).toBe('+79001112233');
  expect((await userOf(v, a.userId)).phone).toBeNull();

  await rule(a, 'bio', { mode: 'nobody', allow: [v.userId] });
  await rule(a, 'birthday', { mode: 'contacts' });
  expect(await userOf(b, a.userId)).toMatchObject({ bio: null, birthday: { day: 3, month: 4 } });
  expect(await userOf(v, a.userId)).toMatchObject({ bio: 'о себе', birthday: null });
  expect((await (await call(a, 'GET', '/me')).json())).toMatchObject({ bio: 'о себе', phone: '+79001112233' });   // себе — всё
});

test('a rule change sends a corrective userUpdated only to viewers whose view changed', async () => {
  const a = await login('Анна'), b = await login('Борис'), v = await login('Вера');
  await makeChat([a.userId, b.userId]); await makeChat([a.userId, v.userId]);
  await call(a, 'PATCH', '/me', { bio: 'секрет' });
  expect(ofType(await journal(b.userId), 'userUpdated').at(-1)!.user.bio).toBe('секрет');
  const vBefore = (await journal(v.userId)).length;

  const ws = await connect(b);
  const poke = nextFrame(ws, (f) => f.op === 'poke');
  await rule(a, 'bio', { mode: 'nobody', allow: [v.userId] });
  await poke;   // приходит без перезагрузки
  const last = ofType(await journal(b.userId), 'userUpdated').at(-1)!;
  expect(last.user).toMatchObject({ id: a.userId, bio: null });
  expect((await journal(v.userId)).length).toBe(vBefore);   // у Веры ничего не поменялось — и записи нет

  await rule(a, 'bio', { mode: 'everyone' });
  expect(ofType(await journal(b.userId), 'userUpdated').at(-1)!.user.bio).toBe('секрет');   // поле вернулось
  // правило «Последнего визита» профиль не трогает
  const bLen = (await journal(b.userId)).length;
  await rule(a, 'lastSeen', { mode: 'nobody' });
  expect((await journal(b.userId)).length).toBe(bLen);
  ws.close();
});

test('resolve by phone respects «Кто найдёт меня по номеру»', async () => {
  const a = await login('Анна', '+79005550000'), b = await login('Борис');
  const find = () => call(b, 'POST', '/users/resolve', { query: '+79005550000' });
  expect((await find()).status).toBe(200);
  await rule(a, 'phoneDiscovery', { mode: 'contacts' });
  expect((await find()).status).toBe(404);
  await makeChat([a.userId, b.userId]);
  await call(a, 'POST', '/contacts', { userId: b.userId, firstName: 'Борис' });
  const r = await find();
  expect(r.status).toBe(200);
  expect((await r.json()).phone).toBe('+79005550000');   // Борис — контакт Анны: и номер ему виден
});

// ---------- присутствие ----------

test('presence respects «Последний визит» and is mutual; hidden peers get no online/offline frames', async () => {
  const a = await login('Анна'), b = await login('Борис');
  await makeChat([a.userId, b.userId]);
  await sql`update users set last_seen_at = now() - interval '1 hour'`;
  const exact = (await presenceOf(b)).find((p) => p.userId === a.userId)!;
  expect(exact.online).toBe(false);
  expect(exact.lastSeen).not.toBeNull();

  const wb = await connect(b);
  const recently = nextFrame(wb, (f) => f.op === 'presence');
  await rule(a, 'lastSeen', { mode: 'nobody' });
  // сразу, без перезагрузки: собеседнику — «недавно»
  expect(((await recently) as Extract<ServerFrame, { op: 'presence' }>).items).toEqual([{ userId: a.userId, online: null, lastSeen: 'recently' }]);
  expect((await presenceOf(b)).find((p) => p.userId === a.userId)).toEqual({ userId: a.userId, online: null, lastSeen: 'recently' });
  // взаимность: Анна тоже видит у Бориса только «недавно»
  expect((await presenceOf(a)).find((p) => p.userId === b.userId)).toEqual({ userId: b.userId, online: null, lastSeen: 'recently' });

  // вход и выход Анны Борису не приходят вовсе (время кадра выдало бы, что она в сети)
  const seen = frames(wb, 'presence');
  const wa = await connect(a);
  await Bun.sleep(80);
  wa.close();
  await Bun.sleep(200);
  expect(seen).toEqual([]);

  // исключение: Борису — можно; взаимно Анна видит его время
  const back = nextFrame(wb, (f) => f.op === 'presence');
  await rule(a, 'lastSeen', { mode: 'nobody', allow: [b.userId] });
  expect(((await back) as Extract<ServerFrame, { op: 'presence' }>).items[0]).toMatchObject({ userId: a.userId, online: false });
  expect((await presenceOf(a)).find((p) => p.userId === b.userId)!.lastSeen).not.toBe('recently');
  wb.close();
});

// ---------- чёрный список ----------

test('blocks API: PUT/GET/DELETE, blocksChanged to the owner, only visible people can be blocked', async () => {
  const a = await login('Анна'), b = await login('Борис'), stranger = await login('Чужой');
  await makeChat([a.userId, b.userId]);
  expect((await call(a, 'PUT', `/blocks/${stranger.userId}`)).status).toBe(404);
  expect((await call(a, 'PUT', `/blocks/${a.userId}`)).status).toBe(404);
  const r = await call(a, 'PUT', `/blocks/${b.userId}`);
  expect(r.status).toBe(200);
  const item = await r.json();
  expect(item).toMatchObject({ userId: b.userId, user: { id: b.userId, name: 'Борис' } });
  expect(typeof item.at).toBe('string');
  expect((await call(a, 'PUT', `/blocks/${b.userId}`)).status).toBe(200);   // повтор — не ошибка
  const list = await (await call(a, 'GET', '/blocks')).json();
  expect(list.blocked.map((x: { userId: number }) => x.userId)).toEqual([b.userId]);
  expect(list.seq).toBe(item.seq);
  expect(ofType(await journal(a.userId), 'blocksChanged').length).toBe(1);   // повтор журнал не трогает

  expect(await (await call(a, 'DELETE', `/blocks/${b.userId}`)).json()).toMatchObject({ unblocked: b.userId });
  expect((await (await call(a, 'GET', '/blocks')).json()).blocked).toEqual([]);
  expect(ofType(await journal(a.userId), 'blocksChanged').map((u) => u.unblocked ?? u.blocked?.userId)).toEqual([b.userId, b.userId]);
});

test('blocked user: no bio/birthday/phone/last seen (corrective userUpdated); the blocker still sees them; unblock restores', async () => {
  const a = await login('Анна', '+79001110000'), b = await login('Борис');
  await makeChat([a.userId, b.userId]);
  await call(a, 'PATCH', '/me', { bio: 'о себе', birthday: { day: 1, month: 2 } });
  await call(b, 'PATCH', '/me', { bio: 'про Бориса' });
  await call(a, 'POST', '/contacts', { userId: b.userId, firstName: 'Борис' });
  expect((await userOf(b, a.userId)).phone).toBe('+79001110000');

  const wb = await connect(b);
  const hidden = nextFrame(wb, (f) => f.op === 'presence');
  await call(a, 'PUT', `/blocks/${b.userId}`);
  expect(((await hidden) as Extract<ServerFrame, { op: 'presence' }>).items[0]).toEqual({ userId: a.userId, online: null, lastSeen: 'recently' });
  expect(await userOf(b, a.userId)).toMatchObject({ bio: null, birthday: null, phone: null });
  expect(ofType(await journal(b.userId), 'userUpdated').at(-1)!.user).toMatchObject({ id: a.userId, bio: null, birthday: null, phone: null });
  expect((await presenceOf(b)).find((p) => p.userId === a.userId)!.lastSeen).toBe('recently');
  // блокирующий видит всё как раньше
  expect((await userOf(a, b.userId)).bio).toBe('про Бориса');
  expect((await presenceOf(a)).find((p) => p.userId === b.userId)!.lastSeen).not.toBe('recently');

  const before = (await journal(b.userId)).length;
  await call(a, 'DELETE', `/blocks/${b.userId}`);
  const after = await journal(b.userId);
  expect(after.length).toBe(before + 1);
  expect(after.at(-1)).toMatchObject({ type: 'userUpdated', user: { id: a.userId, bio: 'о себе', phone: '+79001110000' } });
  wb.close();
});

test('blocked sender in a direct chat → err blocked (with seq), nothing in the journal; group still works; 403 code', async () => {
  const a = await login('Анна'), b = await login('Борис'), v = await makeUser('Вера');
  const direct = await makeChat([a.userId, b.userId]), group = await makeChat([a.userId, b.userId, v]);
  const ok = await sendMessage(b.userId, { chatId: direct, clientId: crypto.randomUUID(), body: 'до' });
  await call(a, 'PUT', `/blocks/${b.userId}`);
  const aLen = (await journal(a.userId)).length, bLen = (await journal(b.userId)).length;
  const msgs = (await sql`select count(*)::int as n from messages`)[0].n;

  const out = await handleFrame(b.userId, { op: 'send', reqId: 'r1', clientId: crypto.randomUUID(), chatId: direct, body: 'после' });
  expect(out).toEqual([{ op: 'err', reqId: 'r1', code: 'blocked', retry: false }]);
  expect((await journal(a.userId)).length).toBe(aLen);
  expect((await journal(b.userId)).length).toBe(bLen);
  expect((await sql`select count(*)::int as n from messages`)[0].n).toBe(msgs);
  // повтор уже принятого до блокировки — по-прежнему ack, а не отказ
  expect((await handleFrame(b.userId, { op: 'send', reqId: 'r2', clientId: ok.message.clientId, chatId: direct, body: 'до' }))[0]).toMatchObject({ op: 'ack', result: { duplicate: true } });
  // блокирующий пишет как обычно; в группе блокировка не мешает
  expect((await handleFrame(b.userId, { op: 'send', reqId: 'r3', clientId: crypto.randomUUID(), chatId: group, body: 'в группу' }))[0].op).toBe('ack');
  expect((await handleFrame(a.userId, { op: 'send', reqId: 'r4', clientId: crypto.randomUUID(), chatId: direct, body: 'от Анны' }))[0].op).toBe('ack');
  // разблокировали — снова можно
  await call(a, 'DELETE', `/blocks/${b.userId}`);
  expect((await handleFrame(b.userId, { op: 'send', reqId: 'r5', clientId: crypto.randomUUID(), chatId: direct, body: 'снова' }))[0].op).toBe('ack');
});

test('typing from a blocked user does not reach the blocker', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const direct = await makeChat([a.userId, b.userId]);
  await call(a, 'PUT', `/blocks/${b.userId}`);
  const wa = await connect(a);
  const seen = frames(wa, 'typing');
  const sent: string[] = [];
  await handleFrame(b.userId, { op: 'typing', chatId: direct }, (topic) => { sent.push(topic); });
  expect(sent).toEqual([]);
  await call(a, 'DELETE', `/blocks/${b.userId}`);
  await handleFrame(b.userId, { op: 'typing', chatId: direct }, (topic) => { sent.push(topic); });
  expect(sent).toEqual([`user:${a.userId}`]);
  expect(seen).toEqual([]);
  wa.close();
});

test('an exception survives a re-save after the owner and that person no longer share a chat; new unseen ids are still dropped', async () => {
  const a = await login('Анна'), x = await login('Икс'), v = await login('Вера'), stranger = await login('Чужой');
  const chat = await makeChat([a.userId, x.userId]); await makeChat([a.userId, v.userId]);
  await call(a, 'PATCH', '/me', { bio: 'секрет' });
  expect((await call(a, 'PUT', '/me/username', { username: 'anna_owner' })).status).toBe(200);
  await rule(a, 'bio', { mode: 'everyone', deny: [x.userId], allow: [] });
  // Икс уходит из единственного общего чата
  await sql`delete from chat_members where chat_id = ${chat} and user_id = ${x.userId}`;
  // владелец меняет режим, присылая тот же список; заодно пробует добавить незнакомого
  const saved = await (await rule(a, 'bio', { mode: 'contacts', deny: [x.userId, stranger.userId], allow: [v.userId] })).json();
  expect(saved.privacy.bio).toEqual({ mode: 'contacts', allow: [v.userId], deny: [x.userId] });
  await rule(a, 'bio', { mode: 'everyone', deny: [x.userId] });
  const r = await call(x, 'POST', '/users/resolve', { query: '@anna_owner' });
  expect(r.status).toBe(200);
  expect((await r.json()).bio).toBeNull();
  // снять исключение по-прежнему можно
  expect((await (await rule(a, 'bio', { mode: 'everyone' })).json()).privacy.bio).toEqual({ mode: 'everyone', allow: [], deny: [] });
});

test('PUT /privacy is not an existence oracle: a 1001-long list is 400 before anything else; unknown and unseen ids look the same', async () => {
  const a = await login('Анна'), stranger = await login('Чужой');
  expect((await rule(a, 'bio', { mode: 'nobody', allow: [...Array.from({ length: 1001 }, () => 'x')] as never })).status).toBe(400);
  const r1 = await (await rule(a, 'bio', { mode: 'nobody', allow: [stranger.userId] })).json();
  const r2 = await (await rule(a, 'bio', { mode: 'nobody', allow: [stranger.userId + 1000] })).json();
  expect(r1.privacy.bio).toEqual({ mode: 'nobody', allow: [], deny: [] });
  expect(r2.privacy.bio).toEqual(r1.privacy.bio);
});

test('adding/removing a contact republishes what the other person sees (phone via userUpdated, last seen live)', async () => {
  const a = await login('Анна', '+79002223344'), b = await login('Борис');
  await makeChat([a.userId, b.userId]);
  await rule(a, 'lastSeen', { mode: 'contacts' });
  await sql`update users set last_seen_at = now() - interval '1 hour'`;
  const lastUser = async () => ofType(await journal(b.userId), 'userUpdated').filter((u) => u.user.id === a.userId).at(-1)?.user;
  const wb = await connect(b);
  const exact = nextFrame(wb, (f) => f.op === 'presence' && f.items[0]?.userId === a.userId);
  await call(a, 'POST', '/contacts', { userId: b.userId, firstName: 'Борис' });
  expect((await lastUser())?.phone).toBe('+79002223344');                               // номер появился без перезагрузки
  const on = ((await exact) as Extract<ServerFrame, { op: 'presence' }>).items[0];
  expect(on.lastSeen).not.toBe('recently');                                              // «недавно» → точное время
  // переименование контакта видимость не меняет — новых записей Борису нет
  const len = (await journal(b.userId)).length;
  await call(a, 'POST', '/contacts', { userId: b.userId, firstName: 'Боря' });
  expect((await journal(b.userId)).length).toBe(len);

  const hidden = nextFrame(wb, (f) => f.op === 'presence' && f.items[0]?.userId === a.userId);
  await call(a, 'DELETE', `/contacts/${b.userId}`);
  expect((await lastUser())?.phone).toBeNull();                                          // номер пропал
  expect(((await hidden) as Extract<ServerFrame, { op: 'presence' }>).items[0]).toEqual({ userId: a.userId, online: null, lastSeen: 'recently' });
  wb.close();
});

test('blocksMe: set on block for the blocked viewer only, survives a profile edit by the blocker, cleared on unblock', async () => {
  const a = await login('Анна'), b = await login('Борис');
  await makeChat([a.userId, b.userId]);
  expect((await userOf(b, a.userId)).blocksMe).toBe(false);
  await call(a, 'PUT', `/blocks/${b.userId}`);
  const last = async () => ofType(await journal(b.userId), 'userUpdated').filter((u) => u.user.id === a.userId).at(-1)!.user;
  expect((await last()).blocksMe).toBe(true);
  expect((await userOf(b, a.userId)).blocksMe).toBe(true);
  expect((await userOf(a, b.userId)).blocksMe).toBe(false);   // блокирующему — нет
  await call(a, 'PATCH', '/me', { bio: 'новое' });
  expect(await last()).toMatchObject({ blocksMe: true, bio: null });   // правка профиля флаг не снимает
  await call(a, 'DELETE', `/blocks/${b.userId}`);
  expect(await last()).toMatchObject({ blocksMe: false, bio: 'новое' });
});

test('a blocked user cannot edit or react in the direct chat with the blocker (403 blocked, no journal); delete still works', async () => {
  const a = await login('Анна'), b = await login('Борис'), v = await makeUser('Вера');
  const direct = await makeChat([a.userId, b.userId]), group = await makeChat([a.userId, b.userId, v]);
  const mine = await sendMessage(b.userId, { chatId: direct, clientId: crypto.randomUUID(), body: 'моё' });
  const hers = await sendMessage(a.userId, { chatId: direct, clientId: crypto.randomUUID(), body: 'её' });
  const inGroup = await sendMessage(b.userId, { chatId: group, clientId: crypto.randomUUID(), body: 'в группе' });
  await call(a, 'PUT', `/blocks/${b.userId}`);
  const aLen = (await journal(a.userId)).length;
  expect(await handleFrame(b.userId, { op: 'edit', reqId: 'e', chatId: direct, id: mine.message.id, body: 'правка' })).toEqual([{ op: 'err', reqId: 'e', code: 'blocked', retry: false }]);
  expect(await handleFrame(b.userId, { op: 'react', reqId: 'r', chatId: direct, id: hers.message.id, emoji: '👍' })).toEqual([{ op: 'err', reqId: 'r', code: 'blocked', retry: false }]);
  expect((await journal(a.userId)).length).toBe(aLen);
  expect((await opened(await sql`select * from messages where id = ${mine.message.id}`))[0].body).toBe('моё');
  expect((await handleFrame(b.userId, { op: 'edit', reqId: 'g', chatId: group, id: inGroup.message.id, body: 'правка' }))[0].op).toBe('ack');
  expect((await handleFrame(b.userId, { op: 'delete', reqId: 'd', chatId: direct, id: mine.message.id }))[0].op).toBe('ack');
});

test('no presence frames for no-op changes: repeated block/unblock, unchanged lastSeen rule', async () => {
  const a = await login('Анна'), b = await login('Борис');
  await makeChat([a.userId, b.userId]);
  await rule(a, 'lastSeen', { mode: 'nobody' });
  await call(a, 'PUT', `/blocks/${b.userId}`);
  const wb = await connect(b);
  const seen = frames(wb, 'presence');
  await rule(a, 'lastSeen', { mode: 'nobody' });       // то же правило
  await call(a, 'PUT', `/blocks/${b.userId}`);         // повтор
  await call(a, 'DELETE', `/blocks/${b.userId}`);      // разблокировали, но время всё равно скрыто правилом — вид не изменился
  await Bun.sleep(150);
  expect(seen).toEqual([]);
  wb.close();
});

// ---------- push ----------
const got: Uint8Array[] = [];
const push = Bun.serve({ port: 0, async fetch(req) { got.push(new Uint8Array(await req.arrayBuffer())); return new Response(null, { status: 201 }); } });

test('no push from a blocked sender (group message)', async () => {
  const a = await login('Анна'), b = await makeUser('Борис'), v = await makeUser('Вера');
  const group = await makeChat([a.userId, b, v]);
  await makeChat([a.userId, b]);
  const br = await pushBrowser();
  expect((await call(a, 'POST', '/push/subscription', { endpoint: `http://localhost:${push.port}/ep/1`, keys: br.keys })).status).toBe(200);
  await call(a, 'PUT', `/blocks/${b}`);
  await sendMessage(b, { chatId: group, clientId: crypto.randomUUID(), body: 'от заблокированного' });
  await sendMessage(v, { chatId: group, clientId: crypto.randomUUID(), body: 'от Веры' });
  await drainJobs();
  // по содержимому, а не по счёту: запоздалый push прошлого файла тестов (id чатов начались заново) не мешает
  const bodies = await Promise.all(got.map(async (g) => (await br.decrypt(g)).body as string));
  expect(bodies).toContain('Вера: от Веры');
  expect(bodies.some((x) => x.includes('от заблокированного'))).toBe(false);
});
