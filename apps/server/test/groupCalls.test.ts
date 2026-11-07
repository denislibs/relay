import type { ServerFrame } from '@relay/protocol';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { sql } from '../src/db';
import { checkGroupCall, liveKitToken } from '../src/domain/groupCalls';
import { createServer } from '../src/http';
import { key, valkey } from '../src/valkey';
import { chatEventsOf, nextFrame, resetDb } from './helpers';

// групповые звонки: кто может начать и войти, пропуск LiveKit, эпоха ключей, адресные ключи, выход и конец
process.env.LIVEKIT_API_KEY = 'testkey';
process.env.LIVEKIT_API_SECRET = 'test-secret-0123456789abcdef0123456789';
delete process.env.LIVEKIT_URL;   // серверного API LiveKit в тестах нет
const s = createServer({ port: 0 });
afterAll(() => s.stop(true));
beforeEach(resetDb);
const base = `http://localhost:${s.port}`;
type Login = { userId: number; token: string };
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as Login;
async function connect(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${s.port}/ws?token=${token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ op: 'hello', lastSeq: 0 }));
  await nextFrame(ws, (f) => f.op === 'hello');
  return ws;
}
const chat = async (a: Login, kind: 'group' | 'direct' | 'channel', members: number[]) =>
  ((await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind, title: kind === 'direct' ? null : 'Группа', memberIds: members }) })).json()) as { id: number }).id;
let n = 0;
async function call(ws: WebSocket, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqId = 'r' + ++n;
  const got = nextFrame(ws, (f) => (f.op === 'ack' || f.op === 'err') && f.reqId === reqId);
  ws.send(JSON.stringify({ ...frame, reqId }));
  const f = await got;
  if (f.op === 'err') throw new Error(f.code);
  return (f as { result: Record<string, unknown> }).result;
}
const quiet = (ws: WebSocket, op: string, ms = 300) => new Promise<boolean>((ok) => {
  const on = (e: MessageEvent) => { if ((JSON.parse(String(e.data)) as ServerFrame).op === op) { ws.removeEventListener('message', on); ok(false); } };
  ws.addEventListener('message', on);
  setTimeout(() => { ws.removeEventListener('message', on); ok(true); }, ms);
});
const PUB = (c: string) => c.repeat(87);
/** /dev/chats ставит всем роль участника: создатель — владелец, как в настоящей группе. */
const own = async (chatId: number, userId: number) => { await sql`update chat_members set role = 'owner' where chat_id = ${chatId} and user_id = ${userId}`; await sql`update chats set owner_id = ${userId} where id = ${chatId}`; };
const service = async (chatId: number) => (await sql`select sender_id, service_data from messages where chat_id = ${chatId} and service_type = 'group_call' order by id`)
  .map((r) => ({ sender: Number(r.sender_id), ...(r.service_data as { groupCall: object }).groupCall }));
const state = (ws: WebSocket, members: number) => nextFrame(ws, (f) => f.op === 'groupCallState' && f.members.length === members) as Promise<Extract<ServerFrame, { op: 'groupCallState' }>>;

test('a member starts a call once; the group sees the banner and the history line; strangers and direct chats cannot', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Чужой');
  const g = await chat(a, 'group', [a.userId, b.userId]);
  const d = await chat(a, 'direct', [a.userId, b.userId]);
  const wa = await connect(a.token), wb = await connect(b.token), wc = await connect(c.token);
  await expect(call(wc, { op: 'groupCallStart', chatId: g })).rejects.toThrow('not_member');
  await expect(call(wa, { op: 'groupCallStart', chatId: d })).rejects.toThrow('bad_frame');
  const r = await call(wa, { op: 'groupCallStart', chatId: g });
  expect(r).toMatchObject({ started: true, callId: expect.any(String) });
  expect(await call(wb, { op: 'groupCallStart', chatId: g })).toEqual({ callId: r.callId, started: false });   // второй — тот же звонок
  expect((await call(wb, { op: 'groupCallGet', chatId: g })).call).toMatchObject({ callId: r.callId, count: 0 });
  expect(await service(g)).toEqual([{ sender: a.userId, callId: r.callId, state: 'started' }]);
  expect((await chatEventsOf(g, 'groupCall' as never)).at(-1)).toMatchObject({ call: { callId: r.callId, count: 0 } });
  wa.close(); wb.close(); wc.close();
});

test('in big groups only an admin with the calls right can start', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const g = await chat(a, 'group', [a.userId, b.userId]);
  await own(g, a.userId);
  await sql`update chats set members_count = 500 where id = ${g}`;
  const wa = await connect(a.token), wb = await connect(b.token);
  await expect(call(wb, { op: 'groupCallStart', chatId: g })).rejects.toThrow('forbidden');
  expect((await call(wa, { op: 'groupCallStart', chatId: g })).started).toBe(true);   // владелец — все права
  wa.close(); wb.close();
});

test('join gives a one-room LiveKit pass; every join and leave bumps the epoch; keys go only to sessions in the call', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера'), x = await login('Чужой');
  const g = await chat(a, 'group', [a.userId, b.userId, c.userId]);
  const wa = await connect(a.token), wb = await connect(b.token), wc = await connect(c.token), wx = await connect(x.token);
  const { callId } = await call(wa, { op: 'groupCallStart', chatId: g }) as { callId: string };
  await expect(call(wx, { op: 'groupCallJoin', callId, pub: PUB('x'), muted: false, video: false })).rejects.toThrow('not_member');

  const ja = await call(wa, { op: 'groupCallJoin', callId, pub: PUB('a'), muted: false, video: false }) as { token: string; identity: string; epoch: number };
  expect(ja.epoch).toBe(1);
  const [h, body, sig] = ja.token.split('.');
  expect(createHmac('sha256', process.env.LIVEKIT_API_SECRET!).update(`${h}.${body}`).digest('base64url')).toBe(sig);
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  expect(claims).toMatchObject({ iss: 'testkey', sub: ja.identity, video: { room: callId, roomJoin: true, canPublish: true, canSubscribe: true } });
  expect(claims.exp - claims.nbf).toBeLessThanOrEqual(620);

  const sa = state(wa, 2);
  const jb = await call(wb, { op: 'groupCallJoin', callId, pub: PUB('b'), muted: true, video: false }) as { epoch: number };
  expect(jb.epoch).toBe(2);
  const st = await sa;
  expect(st.epoch).toBe(2);
  expect(st.members.map((m) => [m.userId, m.muted, m.pub[0]])).toEqual([[a.userId, false, 'a'], [b.userId, true, 'b']]);

  // ключи: адресно, только в звонок; Вера (в группе, но не в звонке) их не получает
  const bSession = st.members.find((m) => m.userId === b.userId)!.session;
  const vSession = 999_999;
  const gotB = nextFrame(wb, (f) => f.op === 'groupCallKeys');
  const quietC = quiet(wc, 'groupCallKeys');
  wa.send(JSON.stringify({ op: 'groupCallKeys', callId, epoch: 2, to: [{ session: bSession, data: 'k'.repeat(40) }, { session: vSession, data: 'k'.repeat(40) }] }));
  expect(await gotB).toMatchObject({ op: 'groupCallKeys', callId, epoch: 2, userId: a.userId, data: 'k'.repeat(40) });
  expect(await quietC).toBe(true);
  // старая эпоха — мимо
  const quietB = quiet(wb, 'groupCallKeys');
  wa.send(JSON.stringify({ op: 'groupCallKeys', callId, epoch: 0, to: [{ session: bSession, data: 'k'.repeat(40) }] }));
  expect(await quietB).toBe(true);

  // выход Бориса — эпоха 3 у оставшихся; последний вышел — звонок окончен, одна строка истории
  const sa1 = state(wa, 1);
  wb.send(JSON.stringify({ op: 'groupCallLeave', callId }));
  expect((await sa1).epoch).toBe(3);
  const ended = nextFrame(wa, (f) => f.op === 'groupCallEnded');
  wa.send(JSON.stringify({ op: 'groupCallLeave', callId }));
  expect(await ended).toMatchObject({ callId, chatId: g });
  await Bun.sleep(150);
  expect((await service(g)).map((r) => (r as { state: string }).state)).toEqual(['started', 'ended']);
  const [row] = await sql`select ended_at, duration from group_calls where id = ${callId}`;
  expect(row.ended_at).not.toBeNull();
  expect((await chatEventsOf(g, 'groupCall' as never)).at(-1)).toMatchObject({ call: null });
  wa.close(); wb.close(); wc.close(); wx.close();
});

test('admin mute holds until allowed; kick and leaving the group remove from the call; end for all; stale members are swept', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const g = await chat(a, 'group', [a.userId, b.userId, c.userId]);
  await own(g, a.userId);
  const wa = await connect(a.token), wb = await connect(b.token), wc = await connect(c.token);
  const { callId } = await call(wa, { op: 'groupCallStart', chatId: g }) as { callId: string };
  for (const [w, ch] of [[wa, 'a'], [wb, 'b'], [wc, 'c']] as const) await call(w, { op: 'groupCallJoin', callId, pub: PUB(ch), muted: false, video: false });
  await Bun.sleep(100);

  await expect(call(wb, { op: 'groupCallMute', callId, userId: c.userId })).rejects.toThrow('forbidden');
  const muted = nextFrame(wc, (f) => f.op === 'groupCallMuted');
  await call(wa, { op: 'groupCallMute', callId, userId: c.userId });
  expect(await muted).toMatchObject({ by: a.userId });
  // Вера пытается включить микрофон сама — остаётся выключенным
  const after = nextFrame(wa, (f) => f.op === 'groupCallState' && f.members.some((m) => m.userId === c.userId && m.mutedByAdmin === true && m.hand != null));
  wc.send(JSON.stringify({ op: 'groupCallUpdate', callId, muted: false, video: false, screen: false, hand: true }));
  const st = await after;
  const vera = st.members.find((m) => m.userId === c.userId)!;
  expect(vera.muted).toBe(true);
  expect(vera.hand).not.toBeNull();   // но руку поднять может

  // удалить из звонка
  const kicked = nextFrame(wc, (f) => f.op === 'groupCallKicked');
  await call(wa, { op: 'groupCallKick', callId, userId: c.userId });
  await kicked;
  // Борис вышел из группы — уходит и из звонка
  const two = state(wa, 1);
  await fetch(`${base}/groups/${g}/members/${b.userId}`, { method: 'DELETE', headers: { cookie: `relay_session=${b.token}` } });
  await two;

  // зависший участник (без пинга) — убирается проверкой; последний — конец звонка
  await valkey().send('HSET', [key(`gcall:${callId}:m`), '424242', JSON.stringify({ userId: 1, session: 424242, pub: PUB('z'), muted: true, video: false, screen: false, hand: null, joinedAt: 0, at: 0 })]);
  const publish = (t: string, m: string) => s.publish(t, m);
  await checkGroupCall(publish, callId);
  expect((await call(wa, { op: 'groupCallGet', chatId: g })).call).toMatchObject({ count: 1 });

  // начавший завершает для всех
  const end = nextFrame(wa, (f) => f.op === 'groupCallEnded');
  await call(wa, { op: 'groupCallEnd', callId });
  await end;
  expect((await call(wa, { op: 'groupCallGet', chatId: g })).call).toBeNull();
  wa.close(); wb.close(); wc.close();
});

test('LiveKit token is HS256 over header.body with the API secret', () => {
  const t = liveKitToken({ room: 'r1', roomJoin: true }, 'u1-s2', 60, { apiKey: 'k', secret: 'sec', now: 1_000_000 });
  const [h, b, sig] = t.split('.');
  expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
  expect(JSON.parse(Buffer.from(b, 'base64url').toString())).toEqual({ iss: 'k', sub: 'u1-s2', nbf: 990, exp: 1060, video: { room: 'r1', roomJoin: true } });
  expect(createHmac('sha256', 'sec').update(`${h}.${b}`).digest('base64url')).toBe(sig);
});

test('«new members without mic»: only an admin sets it; newcomers join gagged (not admins), turning it off frees them; data channel allowed in the pass', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const g = await chat(a, 'group', [a.userId, b.userId, c.userId]);
  await own(g, a.userId);
  const wa = await connect(a.token), wb = await connect(b.token), wc = await connect(c.token);
  const { callId } = await call(wa, { op: 'groupCallStart', chatId: g }) as { callId: string };
  const ja = await call(wa, { op: 'groupCallJoin', callId, pub: PUB('a'), muted: false, video: false }) as { token: string };
  const grant = JSON.parse(Buffer.from(ja.token.split('.')[1], 'base64url').toString()).video;
  expect(grant.canPublishData).toBe(true);   // реакции и чат звонка — каналом данных LiveKit (шифрует клиент)
  await expect(call(wb, { op: 'groupCallSettings', callId, joinMuted: true })).rejects.toThrow('forbidden');
  const on = state(wa, 1);
  expect(await call(wa, { op: 'groupCallSettings', callId, joinMuted: true })).toEqual({ ok: true });
  expect((await on).joinMuted).toBe(true);

  const two = state(wa, 2);
  await call(wb, { op: 'groupCallJoin', callId, pub: PUB('b'), muted: false, video: false });
  const st = await two;
  expect(st.members.find((m) => m.userId === b.userId)).toMatchObject({ muted: true, mutedByAdmin: true, mutedOnJoin: true });
  expect(st.members.find((m) => m.userId === a.userId)?.mutedByAdmin).toBeUndefined();
  // заглушённый правилом не включит микрофон сам
  const upd = state(wa, 2);
  wb.send(JSON.stringify({ op: 'groupCallUpdate', callId, muted: false, video: false, screen: false, hand: false }));
  expect((await upd).members.find((m) => m.userId === b.userId)?.muted).toBe(true);
  // Веру админ заглушил лично — выключение правила её не освобождает
  const three = state(wa, 3);
  await call(wc, { op: 'groupCallJoin', callId, pub: PUB('c'), muted: false, video: false });
  await three;
  await call(wa, { op: 'groupCallMute', callId, userId: c.userId });
  const off = nextFrame(wa, (f) => f.op === 'groupCallState' && !f.joinMuted) as Promise<Extract<ServerFrame, { op: 'groupCallState' }>>;
  await call(wa, { op: 'groupCallSettings', callId, joinMuted: false });
  const after = await off;
  expect(after.members.find((m) => m.userId === b.userId)?.mutedByAdmin).toBe(false);
  expect(after.members.find((m) => m.userId === c.userId)?.mutedByAdmin).toBe(true);
  wa.close(); wb.close(); wc.close();
});

test('raised hand → the admin allows speaking; strangers cannot', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const g = await chat(a, 'group', [a.userId, b.userId]);
  await own(g, a.userId);
  const wa = await connect(a.token), wb = await connect(b.token);
  const { callId } = await call(wa, { op: 'groupCallStart', chatId: g }) as { callId: string };
  await call(wa, { op: 'groupCallJoin', callId, pub: PUB('a'), muted: false, video: false });
  await call(wa, { op: 'groupCallSettings', callId, joinMuted: true });
  const two = state(wa, 2);
  await call(wb, { op: 'groupCallJoin', callId, pub: PUB('b'), muted: false, video: false });
  expect((await two).members.find((m) => m.userId === b.userId)?.mutedByAdmin).toBe(true);
  await expect(call(wb, { op: 'groupCallAllow', callId, userId: b.userId })).rejects.toThrow('forbidden');
  const freed = nextFrame(wa, (f) => f.op === 'groupCallState' && f.members.some((m) => m.userId === b.userId && !m.mutedByAdmin)) as Promise<Extract<ServerFrame, { op: 'groupCallState' }>>;
  expect(await call(wa, { op: 'groupCallAllow', callId, userId: b.userId })).toEqual({ ok: true });
  expect((await freed).members.find((m) => m.userId === b.userId)?.mutedOnJoin).toBeUndefined();
  wa.close(); wb.close();
});
