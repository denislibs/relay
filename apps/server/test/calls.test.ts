import type { ServerFrame } from '@relay/protocol';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { expireRing, iceServersFor } from '../src/domain/calls';
import { writeRule } from '../src/domain/privacy';
import { createServer } from '../src/http';
import { nextFrame, resetDb } from './helpers';
import { LIMITS, setLimit } from '../src/domain/flood';

// звонки 1:1: сервер решает, кто принял, кто занят, когда истекло; сигналинг пересылает только между сессиями звонка
const s = createServer({ port: 0 });
afterAll(() => s.stop(true));
beforeEach(async () => { setLimit(); await resetDb(); });
const base = `http://localhost:${s.port}`;
type Login = { userId: number; token: string };
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as Login;
async function connect(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${s.port}/ws?token=${token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ op: 'hello', lastSeq: 0 }));   // подписки готовы, когда пришёл hello
  await nextFrame(ws, (f) => f.op === 'hello');
  return ws;
}
const direct = async (a: Login, b: Login) =>
  ((await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number }).id;
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
const COMMIT = 'c'.repeat(43), PUB_A = 'a'.repeat(43), PUB_B = 'b'.repeat(43), DATA = 'x'.repeat(40);
const history = async (chatId: number) => (await sql`select sender_id, service_type, service_data from messages where chat_id = ${chatId} and service_type = 'call' order by id`)
  .map((r) => ({ sender: Number(r.sender_id), ...(r.service_data as { call: object }).call }));

test('ring on every device, answered on one: others go quiet, keys and signals flow only between the two sessions', async () => {
  const a = await login('Анна'), b1 = await login('Борис'), b2 = await login('Борис');
  expect(b2.userId).toBe(b1.userId);
  const chatId = await direct(a, b1);
  const wa = await connect(a.token), wb1 = await connect(b1.token), wb2 = await connect(b2.token);
  const callId = crypto.randomUUID();

  const inc1 = nextFrame(wb1, (f) => f.op === 'callIncoming'), inc2 = nextFrame(wb2, (f) => f.op === 'callIncoming');
  expect(await call(wa, { op: 'callRequest', callId, chatId, video: true, commit: COMMIT, tab: 'tabaaaaa' })).toEqual({ ok: true });
  const incoming = await inc1;
  expect(incoming).toMatchObject({ op: 'callIncoming', call: { callId, chatId, caller: a.userId, callee: b1.userId, video: true, commit: COMMIT, state: 'ringing' } });
  await inc2;

  const ringing = nextFrame(wa, (f) => f.op === 'callRinging');
  wb1.send(JSON.stringify({ op: 'callReceived', callId }));
  wb2.send(JSON.stringify({ op: 'callReceived', callId }));
  expect(await ringing).toEqual({ op: 'callRinging', callId });

  // вкладка, открытая посреди звонка, узнаёт о нём
  expect((await call(wb2, { op: 'callGet' })).call).toMatchObject({ callId, state: 'ringing' });

  const accA = nextFrame(wa, (f) => f.op === 'callAccepted'), accB2 = nextFrame(wb2, (f) => f.op === 'callAccepted');
  expect(await call(wb1, { op: 'callAccept', callId, tab: 'tabbbbbb', pub: PUB_B })).toEqual({ ok: true });
  const accepted = await accA as Extract<ServerFrame, { op: 'callAccepted' }>;
  expect(accepted).toMatchObject({ callId, pub: PUB_B, by: { tab: 'tabbbbbb' } });
  const other = await accB2 as Extract<ServerFrame, { op: 'callAccepted' }>;
  expect(other.by).toEqual(accepted.by);   // второе устройство видит, что ответили не на нём
  expect(other.pub).toBeUndefined();
  // второе устройство ответить уже не может
  expect(await call(wb2, { op: 'callAccept', callId, tab: 'tabcccccc', pub: PUB_B })).toEqual({ ok: false, reason: 'gone' });

  const conf = nextFrame(wb1, (f) => f.op === 'callConfirm');
  wa.send(JSON.stringify({ op: 'callConfirm', callId, pub: PUB_A }));
  expect(await conf).toEqual({ op: 'callConfirm', callId, pub: PUB_A });

  const sigB = nextFrame(wb1, (f) => f.op === 'callSignal');
  const quietB2 = quiet(wb2, 'callSignal');
  wa.send(JSON.stringify({ op: 'callSignal', callId, data: DATA }));
  expect(await sigB).toEqual({ op: 'callSignal', callId, data: DATA });
  expect(await quietB2).toBe(true);   // сигнал — только принявшей сессии
  const sigA = nextFrame(wa, (f) => f.op === 'callSignal');
  wb1.send(JSON.stringify({ op: 'callSignal', callId, data: DATA + 'y' }));
  expect((await sigA as { data: string }).data).toBe(DATA + 'y');
  // непринявшее устройство адресата слать сигналы не может
  const quietA = quiet(wa, 'callSignal');
  wb2.send(JSON.stringify({ op: 'callSignal', callId, data: DATA }));
  expect(await quietA).toBe(true);

  const endA = nextFrame(wa, (f) => f.op === 'callEnded'), endB2 = nextFrame(wb2, (f) => f.op === 'callEnded');
  wb1.send(JSON.stringify({ op: 'callHangup', callId }));
  expect(await endA).toMatchObject({ callId, reason: 'ended' });
  await endB2;
  await Bun.sleep(100);
  expect(await history(chatId)).toEqual([{ sender: a.userId, video: true, reason: 'ended', duration: expect.any(Number) }]);
  expect((await call(wa, { op: 'callGet' })).call).toBeNull();
  wa.close(); wb1.close(); wb2.close();
});

test('decline, cancel, busy, missed — each ends the call once with its own history line', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Вера');
  const ab = await direct(a, b), cb = await direct(c, b);
  const wa = await connect(a.token), wb = await connect(b.token), wc = await connect(c.token);

  // отклонил
  let id = crypto.randomUUID();
  await call(wa, { op: 'callRequest', callId: id, chatId: ab, video: false, commit: COMMIT, tab: 'tabaaaaa' });
  let end = nextFrame(wa, (f) => f.op === 'callEnded');
  wb.send(JSON.stringify({ op: 'callDecline', callId: id }));
  expect(await end).toMatchObject({ reason: 'declined' });

  // отменил звонящий
  id = crypto.randomUUID();
  await call(wa, { op: 'callRequest', callId: id, chatId: ab, video: false, commit: COMMIT, tab: 'tabaaaaa' });
  end = nextFrame(wb, (f) => f.op === 'callEnded');
  wa.send(JSON.stringify({ op: 'callHangup', callId: id }));
  expect(await end).toMatchObject({ reason: 'cancelled' });

  // занят: Борис разговаривает с Анной — Вере «занято»
  id = crypto.randomUUID();
  await call(wa, { op: 'callRequest', callId: id, chatId: ab, video: false, commit: COMMIT, tab: 'tabaaaaa' });
  await call(wb, { op: 'callAccept', callId: id, tab: 'tabbbbbb', pub: PUB_B });
  expect(await call(wc, { op: 'callRequest', callId: crypto.randomUUID(), chatId: cb, video: false, commit: COMMIT, tab: 'tabcccccc' })).toEqual({ ok: false, reason: 'busy' });
  // и сама Анна второй звонок начать не может
  expect(await call(wa, { op: 'callRequest', callId: crypto.randomUUID(), chatId: ab, video: false, commit: COMMIT, tab: 'tabaaaaa' })).toEqual({ ok: false, reason: 'in_call' });
  end = nextFrame(wb, (f) => f.op === 'callEnded');
  wa.send(JSON.stringify({ op: 'callHangup', callId: id, failed: true }));
  expect(await end).toMatchObject({ reason: 'failed' });

  // никто не ответил (задача call.ring) — пропущен; повторная задача ничего не пишет
  id = crypto.randomUUID();
  await call(wa, { op: 'callRequest', callId: id, chatId: ab, video: true, commit: COMMIT, tab: 'tabaaaaa' });
  expect((await sql`select run_at - now() as d from jobs where kind = 'call.ring'`).length).toBeGreaterThan(0);
  end = nextFrame(wb, (f) => f.op === 'callEnded');
  const publish = (topic: string, msg: string) => s.publish(topic, msg);
  await expireRing(publish, id);
  await expireRing(publish, id);
  expect(await end).toMatchObject({ reason: 'missed' });
  await Bun.sleep(100);

  expect((await history(ab)).map((h) => h.reason)).toEqual(['declined', 'cancelled', 'failed', 'missed']);
  expect((await history(cb)).map((h) => h.reason)).toEqual(['busy']);
  wa.close(); wb.close(); wc.close();
});

test('privacy «who can call me» and blocks give the same «unavailable»; groups cannot be called; rate limit', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await direct(a, b);
  const wa = await connect(a.token), wb = await connect(b.token);
  const req = () => call(wa, { op: 'callRequest', callId: crypto.randomUUID(), chatId, video: false, commit: COMMIT, tab: 'tabaaaaa' });

  await sql.begin((tx) => writeRule(tx, b.userId, 'calls', { mode: 'nobody', allow: [], deny: [] }));
  const silent = quiet(wb, 'callIncoming');
  expect(await req()).toEqual({ ok: false, reason: 'unavailable' });
  expect(await silent).toBe(true);
  await sql.begin((tx) => writeRule(tx, b.userId, 'calls', { mode: 'nobody', allow: [a.userId], deny: [] }));
  const ok = await req();
  expect(ok).toEqual({ ok: true });
  await sql`delete from privacy_rules`;
  await Bun.sleep(50);

  await sql`insert into blocks (owner_id, user_id) values (${b.userId}, ${a.userId})`;
  const a2 = await login('Анна2');
  const wa2 = await connect(a2.token);
  const chat2 = await direct(a2, b);
  await sql`insert into blocks (owner_id, user_id) values (${b.userId}, ${a2.userId})`;
  expect(await call(wa2, { op: 'callRequest', callId: crypto.randomUUID(), chatId: chat2, video: false, commit: COMMIT, tab: 'tabdddddd' })).toEqual({ ok: false, reason: 'unavailable' });

  const g = ((await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'group', title: 'Г', memberIds: [a.userId, b.userId] }) })).json()) as { id: number }).id;
  await expect(call(wa, { op: 'callRequest', callId: crypto.randomUUID(), chatId: g, video: false, commit: COMMIT, tab: 'tabaaaaa' })).rejects.toThrow('not_member');

  // лимит частоты: 10 запросов в минуту
  const c = await login('Вера');
  const wc = await connect(c.token);
  const cc = await direct(c, b);
  const results = [];
  setLimit('callRing', LIMITS.callRing);   // лимиты в тестах выключены (setup.ts) — этот проверяет звонки
  for (let i = 0; i < 12; i++) results.push((await call(wc, { op: 'callRequest', callId: crypto.randomUUID(), chatId: cc, video: false, commit: COMMIT, tab: 'tabcccccc' })).reason);
  expect(results.slice(-2)).toEqual(['flood', 'flood']);
  wa.close(); wb.close(); wa2.close(); wc.close();
});

test('bad call frames are dropped by the parser', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chatId = await direct(a, b);
  const wa = await connect(a.token), wb = await connect(b.token);
  const silent = quiet(wb, 'callIncoming');
  for (const bad of [
    { op: 'callRequest', reqId: 'x', callId: 'not-a-uuid', chatId, video: false, commit: COMMIT, tab: 'tabaaaaa' },
    { op: 'callRequest', reqId: 'x', callId: crypto.randomUUID(), chatId, video: false, commit: 'short', tab: 'tabaaaaa' },
    { op: 'callRequest', reqId: 'x', callId: crypto.randomUUID(), chatId, video: false, commit: COMMIT, tab: 'BAD TAB' },
    { op: 'callSignal', callId: crypto.randomUUID(), data: 'не base64 <script>' },
  ]) wa.send(JSON.stringify(bad));
  expect(await silent).toBe(true);
  wa.close(); wb.close();
});

test('TURN credentials are time-limited HMAC per user; nothing configured — no servers', () => {
  expect(iceServersFor(1, 0, {})).toEqual([]);
  const ice = iceServersFor(7, 1_000_000, { RELAY_STUN_URLS: 'stun:turn.example:3478', RELAY_TURN_URLS: 'turn:turn.example:3478?transport=udp, turns:turn.example:5349', RELAY_TURN_SECRET: 's3cret' });
  expect(ice[0]).toEqual({ urls: ['stun:turn.example:3478'] });
  expect(ice[1].urls).toEqual(['turn:turn.example:3478?transport=udp', 'turns:turn.example:5349']);
  expect(ice[1].username).toBe(`${1000 + 7200}:7`);
  const want = new Bun.CryptoHasher('sha1', 's3cret').update(ice[1].username!).digest('base64');
  expect(ice[1].credential).toBe(want);
});
