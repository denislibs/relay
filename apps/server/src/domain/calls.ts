import { createHmac } from 'node:crypto';
import { callEnds, callRequests } from '../obs/appMetrics';
import { CALL_PING_MS, CALL_RING_MS, type CallEndReason, type CallInfo, type CallServerFrame, type IceServer } from '@relay/protocol';
import { sql } from '../db';
import { enqueue } from '../jobs/queue';
import { hit, key, PREFIX, valkey } from '../valkey';
import { DomainError } from './errors';
import { serviceMessage } from './groups';
import { canSee, privacyCtx } from './privacy';
import { onlineUsers } from './liveRegistry';

/**
 * Звонки 1:1 (docs/plans/2026-11-06-relay-calls.md). Сервер решает только «кто, с кем, в каком состоянии»:
 * первый принявший, занятость, истечение — атомарно скриптами Valkey (общий для процессов). Ключи звонка и
 * сигналинг WebRTC — шифротекст клиентов, сервер его пересылает, но не читает.
 *
 *   call:<id>       хэш звонка; живёт, пока звонит (RING_TTL) или пока стороны подтверждают разговор (LIVE_TTL)
 *   busy:<user>     id звонка, в котором пользователь участвует (звонящий — с запроса, адресат — с ответа)
 *   incoming:<user> множество звонящих ему сейчас (для вкладки, открытой посреди звонка)
 *
 * Долговечно — только служебное сообщение в личном чате, одно на звонок (пишет тот, кто перевёл звонок в ended).
 */

export type Publish = (topic: string, msg: string) => void;

const RING_TTL = Math.ceil(CALL_RING_MS / 1000) + 15;
const LIVE_TTL = Math.ceil((CALL_PING_MS * 3) / 1000) + 10;   // три пропущенных подтверждения — звонок брошен
const ENDED_TTL = 120;                                          // ended держим недолго: поздний кадр получит «звонок завершён»
const REQUESTS_PER_MIN = 10;
const SIGNALS_PER_SEC = 60;

const run = (script: string, keys: string[], args: (string | number)[]) =>
  valkey().send('EVAL', [script, String(keys.length), ...keys, ...args.map(String)]);

// KEYS: call, busy:caller, busy:callee, incoming:callee. ARGV: callId, ringTtl, затем пары поле-значение
const REQUEST = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'dup' end
local mine = redis.call('GET', KEYS[2])
if mine and mine ~= ARGV[1] then return 'self' end
if redis.call('EXISTS', KEYS[3]) == 1 then return 'busy' end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
for i = 3, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[4], ARGV[1])
redis.call('EXPIRE', KEYS[4], ARGV[2])
return 'ok'`;

// KEYS: call, busy:callee, busy:caller. ARGV: callId, session, tab, now, liveTtl
const ACCEPT = `
if redis.call('HGET', KEYS[1], 'state') ~= 'ringing' then return 'gone' end
local cur = redis.call('GET', KEYS[2])
if cur and cur ~= ARGV[1] then return 'busy' end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[5])
redis.call('HSET', KEYS[1], 'state', 'accepted', 'aSession', ARGV[2], 'aTab', ARGV[3], 'acceptedAt', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('EXPIRE', KEYS[3], ARGV[5])
return 'ok'`;

// KEYS: call, busy:caller, busy:callee, incoming:callee. ARGV: callId, endedTtl. Возвращает прежнее состояние
// и время ответа — только тому, кто перевёл звонок в ended (он и пишет историю)
const END = `
local st = redis.call('HGET', KEYS[1], 'state')
if not st or st == 'ended' then return false end
local at = redis.call('HGET', KEYS[1], 'acceptedAt') or ''
redis.call('HSET', KEYS[1], 'state', 'ended')
redis.call('EXPIRE', KEYS[1], ARGV[2])
for i = 2, 3 do if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end end
redis.call('SREM', KEYS[4], ARGV[1])
return { st, at }`;

// разговор жив: продлить звонок и занятость обеих сторон. KEYS: call, busy:caller, busy:callee. ARGV: callId, ttl
const PING = `
if redis.call('HGET', KEYS[1], 'state') ~= 'accepted' then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[2])
for i = 2, 3 do if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('EXPIRE', KEYS[i], ARGV[2]) end end
return 1`;

type Call = {
  id: string; chatId: number; caller: number; callee: number; video: boolean; commit: string; at: number;
  state: 'ringing' | 'accepted' | 'ended'; cSession: number; cTab: string; aSession?: number; aTab?: string; acceptedAt?: number;
  pushed: boolean;   // адресату ушёл пуш о звонке: конец звонка тоже пушем (закрыть уведомление / «пропущенный»)
};

const callKey = (id: string) => key('call:' + id);
const busyKey = (u: number) => key('busy:' + u);
const incomingKey = (u: number) => key('incoming:' + u);

async function load(id: string): Promise<Call | null> {
  const flat = (await valkey().send('HGETALL', [callKey(id)])) as string[] | Record<string, string> | null;
  const h: Record<string, string> = Array.isArray(flat) ? Object.fromEntries(flat.flatMap((v, i, a) => (i % 2 ? [] : [[v, a[i + 1]]]))) : (flat ?? {});
  if (!h.state) return null;
  return {
    id, chatId: Number(h.chatId), caller: Number(h.caller), callee: Number(h.callee), video: h.video === '1', commit: h.commit, at: Number(h.at),
    state: h.state as Call['state'], cSession: Number(h.cSession), cTab: h.cTab, pushed: h.pushed === '1',
    ...(h.aSession ? { aSession: Number(h.aSession), aTab: h.aTab, acceptedAt: Number(h.acceptedAt) } : {}),
  };
}

const info = (c: Call): CallInfo => ({ callId: c.id, chatId: c.chatId, caller: c.caller, callee: c.callee, video: c.video, commit: c.commit, state: c.state === 'accepted' ? 'accepted' : 'ringing', at: c.at });
const send = (publish: Publish, topic: string, f: CallServerFrame) => publish(topic, JSON.stringify(f));

/**
 * Серверы ICE для пользователя: STUN — как есть, TURN — с временной учёткой (REST API coturn, use-auth-secret):
 * username = «срок:пользователь», credential = HMAC-SHA1(секрет, username). Учётка живёт 2 часа.
 */
export function iceServersFor(userId: number, now = Date.now(), env: Record<string, string | undefined> = process.env): IceServer[] {
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const out: IceServer[] = [];
  const stun = list(env.RELAY_STUN_URLS);
  if (stun.length) out.push({ urls: stun });
  const turn = list(env.RELAY_TURN_URLS), secret = env.RELAY_TURN_SECRET;
  if (turn.length && secret) {
    const username = `${Math.floor(now / 1000) + 2 * 3600}:${userId}`;
    out.push({ urls: turn, username, credential: createHmac('sha1', secret).update(username).digest('base64') });
  }
  return out;
}

/** Звонок в личный чат. Отказ по приватности и блокировке — одинаковый «недоступен», без причины. */
export async function requestCall(publish: Publish, userId: number, sessionId: number,
  f: { callId: string; chatId: number; video: boolean; commit: string; tab: string }): Promise<{ ok: true } | { ok: false; reason: 'unavailable' | 'in_call' | 'busy' | 'flood' }> {
  // исход попытки — в relay_call_requests_total (ok или причина отказа; исключение — код ошибки)
  try {
    const r = await requestCallOnce(publish, userId, sessionId, f);
    callRequests.inc({ result: r.ok ? 'ok' : r.reason });
    return r;
  } catch (e) { callRequests.inc({ result: e instanceof DomainError ? e.code : 'internal' }); throw e; }
}

async function requestCallOnce(publish: Publish, userId: number, sessionId: number,
  f: { callId: string; chatId: number; video: boolean; commit: string; tab: string }): Promise<{ ok: true } | { ok: false; reason: 'unavailable' | 'in_call' | 'busy' | 'flood' }> {
  if ((await hit(`callreq:${userId}`, 60)) > REQUESTS_PER_MIN) return { ok: false, reason: 'flood' };
  const [c] = await sql`
    select c.kind, o.user_id as peer, u.system
      from chats c
      join chat_members m on m.chat_id = c.id and m.user_id = ${userId}
      join chat_members o on o.chat_id = c.id and o.user_id <> ${userId}
      join users u on u.id = o.user_id
     where c.id = ${f.chatId} and c.deleted_at is null`;
  if (!c || c.kind !== 'direct') throw new DomainError('not_member');
  const callee = Number(c.peer);
  if (c.system) return { ok: false, reason: 'unavailable' };
  const ctx = await privacyCtx(sql, [[userId, callee]]);
  if (!canSee(userId, callee, 'calls', ctx)) return { ok: false, reason: 'unavailable' };   // и блокировка тоже

  const now = Date.now();
  const fields: (string | number)[] = ['chatId', f.chatId, 'caller', userId, 'callee', callee, 'video', f.video ? 1 : 0, 'commit', f.commit,
    'at', now, 'state', 'ringing', 'cSession', sessionId, 'cTab', f.tab];
  const r = String(await run(REQUEST, [callKey(f.callId), busyKey(userId), busyKey(callee), incomingKey(callee)], [f.callId, RING_TTL, ...fields]));
  if (r === 'dup') return { ok: true };   // повтор того же запроса (переподключение)
  if (r === 'self') return { ok: false, reason: 'in_call' };
  if (r === 'busy') {
    await historyOnly(f.chatId, userId, f.video, 'busy');
    return { ok: false, reason: 'busy' };
  }
  const call = (await load(f.callId))!;
  send(publish, `user:${callee}`, { op: 'callIncoming', call: info(call) });
  await enqueue(sql, 'call.ring', { callId: f.callId }, { runAt: new Date(now + CALL_RING_MS), dedupeKey: `call:${f.callId}:ring` });
  // ни одной живой вкладки у адресата — звонок доходит пушем (открытая вкладка, даже скрытая, звонит сама)
  if (!(await onlineUsers([callee])).has(callee)) {
    await valkey().send('HSET', [callKey(f.callId), 'pushed', '1']);
    await enqueue(sql, 'push.call', { callId: f.callId, chatId: f.chatId, caller: userId, callee, video: f.video }, { dedupeKey: `push.call:${f.callId}` });
  }
  return { ok: true };
}

/** Входящий показан на устройстве адресата: звонящему — «Звонок…» (один раз). */
export async function receivedCall(publish: Publish, userId: number, callId: string): Promise<void> {
  const c = await load(callId);
  if (!c || c.callee !== userId || c.state !== 'ringing') return;
  if (Number(await valkey().send('HSETNX', [callKey(callId), 'rung', '1'])) === 1) send(publish, `session:${c.cSession}`, { op: 'callRinging', callId });
}

/** Ответ адресата: звонок получает первая ответившая вкладка, остальные устройства и вкладки гаснут по by. */
export async function acceptCall(publish: Publish, userId: number, sessionId: number, f: { callId: string; tab: string; pub: string }): Promise<{ ok: boolean; reason?: 'gone' | 'in_call' }> {
  const c = await load(f.callId);
  if (!c || c.callee !== userId) return { ok: false, reason: 'gone' };
  const r = String(await run(ACCEPT, [callKey(f.callId), busyKey(userId), busyKey(c.caller)], [f.callId, sessionId, f.tab, Date.now(), LIVE_TTL]));
  if (r !== 'ok') return { ok: false, reason: r === 'busy' ? 'in_call' : 'gone' };
  await valkey().send('SREM', [incomingKey(userId), f.callId]);
  if (c.pushed) await enqueue(sql, 'push.call', { callId: c.id, chatId: c.chatId, caller: c.caller, callee: c.callee, video: c.video, end: true },
    { dedupeKey: `push.call:${c.id}:end` }).catch((e) => console.error('call push:', e));   // ответили — уведомление на остальных устройствах закрыть
  const by = { session: sessionId, tab: f.tab };
  send(publish, `session:${c.cSession}`, { op: 'callAccepted', callId: f.callId, by, pub: f.pub, iceServers: iceServersFor(c.caller) });
  send(publish, `user:${userId}`, { op: 'callAccepted', callId: f.callId, by, iceServers: iceServersFor(userId) });
  return { ok: true };
}

/** Звонящий раскрывает ключ — только после ответа и только из своей сессии. */
export async function confirmCall(publish: Publish, userId: number, sessionId: number, f: { callId: string; pub: string }): Promise<void> {
  const c = await load(f.callId);
  if (!c || c.state !== 'accepted' || c.caller !== userId || c.cSession !== sessionId) return;
  send(publish, `session:${c.aSession}`, { op: 'callConfirm', callId: f.callId, pub: f.pub });
}

/** Сигнальный пакет — второй стороне, только между сессиями, которые ведут звонок. */
export async function relaySignal(publish: Publish, userId: number, sessionId: number, f: { callId: string; data: string }): Promise<void> {
  const c = await load(f.callId);
  if (!c || c.state !== 'accepted') return;
  let to: number | undefined;
  if (c.caller === userId && c.cSession === sessionId) to = c.aSession;
  else if (c.callee === userId && c.aSession === sessionId) to = c.cSession;
  if (to == null) return;
  if ((await hit(`callsig:${f.callId}:${userId}`, 1)) > SIGNALS_PER_SEC) return;
  send(publish, `session:${to}`, { op: 'callSignal', callId: f.callId, data: f.data });
}

/** Разговор жив — продлить. */
export async function pingCall(userId: number, sessionId: number, callId: string): Promise<void> {
  const c = await load(callId);
  if (!c || !((c.caller === userId && c.cSession === sessionId) || (c.callee === userId && c.aSession === sessionId))) return;
  await run(PING, [callKey(callId), busyKey(c.caller), busyKey(c.callee)], [callId, LIVE_TTL]);
}

/** До ответа: адресат отклоняет (с любого своего устройства), звонящий отменяет. */
export async function declineCall(publish: Publish, userId: number, sessionId: number, callId: string): Promise<void> {
  const c = await load(callId);
  if (!c || c.state !== 'ringing') return;
  if (c.callee === userId) await finish(publish, c, 'declined');
  else if (c.caller === userId && c.cSession === sessionId) await finish(publish, c, 'cancelled');
}

/** «Отклонить» из уведомления (service worker, без WebSocket): только адресат и только пока звонят. */
export async function declineFromPush(publish: Publish, userId: number, callId: string): Promise<{ ok: boolean }> {
  const c = await load(callId);
  if (!c || c.callee !== userId || c.state !== 'ringing') return { ok: false };
  await finish(publish, c, 'declined');
  return { ok: true };
}

/** Положить трубку: до ответа — как отмена/отклонение, после — конец разговора (failed — так и не соединились). */
export async function hangupCall(publish: Publish, userId: number, sessionId: number, f: { callId: string; failed?: boolean }): Promise<void> {
  const c = await load(f.callId);
  if (!c || c.state === 'ended') return;
  if (c.state === 'ringing') return declineCall(publish, userId, sessionId, f.callId);
  const mine = (c.caller === userId && c.cSession === sessionId) || (c.callee === userId && c.aSession === sessionId);
  if (mine) await finish(publish, c, f.failed ? 'failed' : 'ended');
}

/** Никто не ответил за CALL_RING_MS (задача call.ring). */
export async function expireRing(publish: Publish, callId: string): Promise<void> {
  const c = await load(callId);
  if (c?.state === 'ringing') await finish(publish, c, 'missed');
}

/** Мой текущий звонок: идёт разговор или мне звонят (вкладка открыта посреди звонка). */
export async function currentCall(userId: number): Promise<CallInfo | null> {
  const ids = new Set<string>();
  const busy = (await valkey().send('GET', [busyKey(userId)])) as string | null;
  if (busy) ids.add(busy);
  for (const id of ((await valkey().send('SMEMBERS', [incomingKey(userId)])) as string[]) ?? []) ids.add(id);
  for (const id of ids) {
    const c = await load(id);
    if (!c || c.state === 'ended') { await valkey().send('SREM', [incomingKey(userId), id]); continue; }
    if (c.state === 'ringing' && c.callee !== userId) continue;   // мой исходящий — его ведёт вкладка, которая звонит
    return info(c);
  }
  return null;
}

async function finish(publish: Publish, c: Call, reason: CallEndReason): Promise<void> {
  callEnds.inc({ reason });
  const r = (await run(END, [callKey(c.id), busyKey(c.caller), busyKey(c.callee), incomingKey(c.callee)], [c.id, ENDED_TTL])) as [string, string] | null;
  if (!r) return;   // уже завершил кто-то другой (и написал историю)
  const duration = r[1] ? Math.max(0, Math.round((Date.now() - Number(r[1])) / 1000)) : undefined;
  const f: CallServerFrame = { op: 'callEnded', callId: c.id, reason, ...(duration != null ? { duration } : {}) };
  send(publish, `user:${c.caller}`, f);
  send(publish, `user:${c.callee}`, f);
  if (c.pushed && r[0] === 'ringing') {
    // уведомление о звонке на устройствах без вкладок: закрыть; не ответил и не отклонил — «Пропущенный звонок»
    // (ответили — его закрыл уже acceptCall)
    const missed = reason === 'missed' || reason === 'cancelled';
    await enqueue(sql, 'push.call', { callId: c.id, chatId: c.chatId, caller: c.caller, callee: c.callee, video: c.video, end: true, missed },
      { dedupeKey: `push.call:${c.id}:end` }).catch((e) => console.error('call push:', e));
  }
  await historyOnly(c.chatId, c.caller, c.video, reason, duration);
}

/** Служебное сообщение о звонке в личный чат (автор — звонящий). */
async function historyOnly(chatId: number, caller: number, video: boolean, reason: CallEndReason, duration?: number): Promise<void> {
  try {
    await sql.begin((tx) => serviceMessage(tx, chatId, caller, 'call', { call: { video, reason, ...(duration != null ? { duration } : {}) } }, '', 'direct'));
  } catch (e) { console.error('call history:', e); }
}

/** Тесты: префикс ключей звонков. */
export const CALL_KEY_PREFIX = PREFIX + 'call:';
