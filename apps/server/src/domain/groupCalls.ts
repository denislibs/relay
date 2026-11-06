import { GROUP_CALL_FACES, GROUP_CALL_MEMBERS_MAX, GROUP_CALL_PING_MS, type GroupCallMember, type GroupCallServerFrame, type GroupCallSummary } from '@relay/protocol';
import { createHmac } from 'node:crypto';
import { sql } from '../db';
import { enqueue } from '../jobs/queue';
import { hit, key, valkey } from '../valkey';
import { DomainError } from './errors';
import { can, groupCtx, hasAdmin, type GroupCtx } from './groupRights';
import { serviceMessage } from './groups';
import { chatEvent } from './journal';

/**
 * Групповые звонки (docs/plans/2026-11-07-relay-group-calls.md). Медиа идёт через LiveKit; кадры шифруются на
 * устройствах ключами отправителей, которые участники раздают друг другу сами (groupCallKeys — адресно, шифротекст).
 * Сервер Relay: кто может начать и войти (пропуск LiveKit — JWT на одну комнату), состав и эпоха ключей (растёт при
 * каждом входе и выходе), плашка «Идёт звонок» в журнале группы, история — служебные сообщения.
 *
 *   gcall:<id>          хэш: chatId, epoch, startedBy, startedAt
 *   gcall:<id>:m        хэш: сессия → участник (JSON, с at — последний пинг)
 *   gcall:chat:<chatId> id идущего звонка группы
 * Долговечно — строка group_calls (начало, конец, длительность) и два служебных сообщения.
 */

export type Publish = (topic: string, msg: string) => void;

const STALE_MS = GROUP_CALL_PING_MS * 3;
const CHECK_MS = 30_000;
const TTL = 6 * 3600;
/** В больших группах начинать звонок может только админ с правом «Управление звонками» (как в Telegram). */
export const OPEN_START_MAX = 200;

type Member = GroupCallMember & { at: number };

const callKey = (id: string) => key('gcall:' + id);
const membersKey = (id: string) => key('gcall:' + id + ':m');
const chatKey = (chatId: number) => key('gcall:chat:' + chatId);
const send = (publish: Publish, topic: string, f: GroupCallServerFrame) => publish(topic, JSON.stringify(f));

const env = (k: string) => process.env[k] ?? '';

/** JWT HS256 для LiveKit: пропуск в одну комнату (или права администратора комнаты для серверного API). */
export function liveKitToken(grant: Record<string, unknown>, identity: string, ttlSec: number, opts: { name?: string; now?: number; apiKey?: string; secret?: string } = {}): string {
  const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url');
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: opts.apiKey ?? env('LIVEKIT_API_KEY'), sub: identity, ...(opts.name ? { name: opts.name } : {}), nbf: now - 10, exp: now + ttlSec, video: grant }));
  const sig = createHmac('sha256', opts.secret ?? env('LIVEKIT_API_SECRET')).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Серверный API LiveKit (Twirp): удалить комнату, участника, выключить дорожку. Ошибка — не повод ронять операцию. */
async function roomService(method: string, room: string, body: Record<string, unknown>): Promise<void> {
  const url = env('LIVEKIT_URL');
  if (!url) return;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + liveKitToken({ roomAdmin: true, room }, 'relay-server', 60) },
      body: JSON.stringify({ room, ...body }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok && res.status !== 404) console.warn('livekit', method, res.status);
  } catch (e) { console.warn('livekit', method, String(e)); }
}

/** Участник комнаты LiveKit: «u<userId>-s<session>» — сессия нужна, чтобы ключи шли именно в неё. */
export const identityOf = (userId: number, session: number) => `u${userId}-s${session}`;

async function members(id: string): Promise<Member[]> {
  const flat = (await valkey().send('HGETALL', [membersKey(id)])) as string[] | Record<string, string> | null;
  const vals = Array.isArray(flat) ? flat.filter((_, i) => i % 2 === 1) : Object.values(flat ?? {});
  return vals.map((v) => JSON.parse(v) as Member).sort((a, b) => a.joinedAt - b.joinedAt);
}

async function meta(id: string): Promise<{ chatId: number; epoch: number; startedBy: number; startedAt: number } | null> {
  const flat = (await valkey().send('HGETALL', [callKey(id)])) as string[] | Record<string, string> | null;
  const h: Record<string, string> = Array.isArray(flat) ? Object.fromEntries(flat.flatMap((v, i, a) => (i % 2 ? [] : [[v, a[i + 1]]]))) : (flat ?? {});
  if (!h.chatId) return null;
  return { chatId: Number(h.chatId), epoch: Number(h.epoch ?? 0), startedBy: Number(h.startedBy), startedAt: Number(h.startedAt) };
}

const pub = (m: Member): GroupCallMember => { const { at: _, ...rest } = m; return rest; };

/** Состав и эпоха — всем, кто в звонке (их сессиям). */
async function broadcast(publish: Publish, id: string, chatId: number, epoch: number, list?: Member[]): Promise<void> {
  const ms = list ?? await members(id);
  const f: GroupCallServerFrame = { op: 'groupCallState', callId: id, chatId, epoch, members: ms.map(pub) };
  for (const m of ms) send(publish, `session:${m.session}`, f);
}

/** Плашка «Идёт звонок» у всех участников группы (журнал группы). */
async function summarize(chatId: number, id: string | null): Promise<void> {
  let call: GroupCallSummary | null = null;
  if (id) {
    const m = await meta(id);
    const ms = await members(id);
    if (m) call = { callId: id, count: ms.length, startedAt: m.startedAt, faces: [...new Set(ms.map((x) => x.userId))].slice(0, GROUP_CALL_FACES) };
  }
  await sql.begin((tx) => chatEvent(tx, chatId, { type: 'groupCall', chatId, call }, 'group'));
}

/** Кто может начать: участник группы с правом писать; в больших группах — админ с правом «Управление звонками». */
async function startCtx(userId: number, chatId: number): Promise<GroupCtx> {
  const ctx = await groupCtx(sql, chatId, userId);
  if (ctx.kind !== 'group') throw new DomainError('bad_frame', 'not a group');
  const [c] = await sql`select members_count from chats where id = ${chatId}`;
  const big = Number(c?.members_count ?? 0) > OPEN_START_MAX;
  if (!(hasAdmin(ctx, 'calls') || (!big && can(ctx, 'text')))) throw new DomainError('forbidden', 'calls');
  return ctx;
}

/** Идущий звонок группы (для плашки при открытии чата и вкладки посреди звонка). */
export async function currentGroupCall(userId: number, chatId: number): Promise<GroupCallSummary | null> {
  await groupCtx(sql, chatId, userId);   // не участник — not_member
  const id = (await valkey().send('GET', [chatKey(chatId)])) as string | null;
  if (!id) return null;
  const m = await meta(id);
  if (!m) return null;
  const ms = await members(id);
  return { callId: id, count: ms.length, startedAt: m.startedAt, faces: [...new Set(ms.map((x) => x.userId))].slice(0, GROUP_CALL_FACES) };
}

/** Начать звонок в группе. Уже идёт — вернуть его (две кнопки одновременно не создают два звонка). */
export async function startGroupCall(userId: number, chatId: number): Promise<{ callId: string; started: boolean }> {
  await startCtx(userId, chatId);
  if ((await hit(`gcallstart:${userId}`, 60)) > 5) throw new DomainError('flood', 'calls', 60);
  const id = crypto.randomUUID();
  const now = Date.now();
  // один звонок на группу: SET NX на ключ группы
  const ok = await valkey().send('SET', [chatKey(chatId), id, 'NX', 'EX', String(TTL)]);
  if (!ok) {
    const cur = (await valkey().send('GET', [chatKey(chatId)])) as string | null;
    if (cur && await meta(cur)) return { callId: cur, started: false };
    await valkey().send('SET', [chatKey(chatId), id, 'EX', String(TTL)]);   // ключ пережил звонок — занять
  }
  await valkey().send('HSET', [callKey(id), 'chatId', String(chatId), 'epoch', '0', 'startedBy', String(userId), 'startedAt', String(now)]);
  await valkey().send('EXPIRE', [callKey(id), String(TTL)]);
  await sql.begin(async (tx) => {
    await tx`insert into group_calls (id, chat_id, started_by, started_at) values (${id}, ${chatId}, ${userId}, to_timestamp(${now / 1000}))`;
    await serviceMessage(tx, chatId, userId, 'group_call', { groupCall: { callId: id, state: 'started' } }, '', 'group');
  });
  await summarize(chatId, id);
  await enqueue(sql, 'groupcall.check', { callId: id }, { runAt: new Date(now + CHECK_MS * 2), dedupeKey: `gcall:${id}:check` });
  return { callId: id, started: true };
}

/** Войти: участник группы, звонок идёт. Эпоха растёт — у всех новые ключи отправителей. */
export async function joinGroupCall(publish: Publish, userId: number, sessionId: number, f: { callId: string; pub: string; muted: boolean; video: boolean }): Promise<{ token: string; identity: string; epoch: number; chatId: number }> {
  const m = await meta(f.callId);
  if (!m) throw new DomainError('not_found', 'call');
  await groupCtx(sql, m.chatId, userId);
  const ms = await members(f.callId);
  if (!ms.some((x) => x.session === sessionId) && ms.length >= GROUP_CALL_MEMBERS_MAX) throw new DomainError('forbidden', 'full');
  const prev = ms.find((x) => x.session === sessionId);
  const member: Member = { userId, session: sessionId, pub: f.pub, muted: f.muted, video: f.video, screen: false, hand: null, joinedAt: prev?.joinedAt ?? Date.now(), at: Date.now() };
  await valkey().send('HSET', [membersKey(f.callId), String(sessionId), JSON.stringify(member)]);
  await valkey().send('EXPIRE', [membersKey(f.callId), String(TTL)]);
  const epoch = Number(await valkey().send('HINCRBY', [callKey(f.callId), 'epoch', '1']));
  const identity = identityOf(userId, sessionId);
  const token = liveKitToken({ room: f.callId, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false }, identity, 600, { name: String(userId) });
  await broadcast(publish, f.callId, m.chatId, epoch);
  await summarize(m.chatId, f.callId);
  return { token, identity, epoch, chatId: m.chatId };
}

/** Выйти (или выкинуть ушедшего). Последний вышел — звонок окончен. */
export async function leaveGroupCall(publish: Publish, callId: string, sessionId: number): Promise<void> {
  const m = await meta(callId);
  if (!m) return;
  const removed = Number(await valkey().send('HDEL', [membersKey(callId), String(sessionId)]));
  if (!removed) return;
  const ms = await members(callId);
  if (!ms.length) { await endGroupCall(publish, callId, [sessionId]); return; }   // ушедший последним тоже узнаёт, что звонок окончен
  const epoch = Number(await valkey().send('HINCRBY', [callKey(callId), 'epoch', '1']));
  await broadcast(publish, callId, m.chatId, epoch, ms);
  await summarize(m.chatId, callId);
}

/** Ключи отправителя — адресно: только сессиям, которые сейчас в звонке, и только от участника звонка. */
export async function relayGroupKeys(publish: Publish, userId: number, sessionId: number, f: { callId: string; epoch: number; to: { session: number; data: string }[] }): Promise<void> {
  const m = await meta(f.callId);
  if (!m || f.epoch > m.epoch || f.epoch < m.epoch - 1) return;   // старые эпохи — мимо
  const ms = await members(f.callId);
  if (!ms.some((x) => x.session === sessionId && x.userId === userId)) return;
  if ((await hit(`gkeys:${f.callId}:${sessionId}`, 1)) > 20) return;
  const inCall = new Set(ms.map((x) => x.session));
  for (const t of f.to) if (inCall.has(t.session) && t.session !== sessionId) send(publish, `session:${t.session}`, { op: 'groupCallKeys', callId: f.callId, epoch: f.epoch, from: sessionId, userId, data: t.data });
}

/** Микрофон, камера, экран, рука — всем в звонке (эпоха не меняется). */
export async function updateGroupMember(publish: Publish, userId: number, sessionId: number, f: { callId: string; muted: boolean; video: boolean; screen: boolean; hand: boolean }): Promise<void> {
  const m = await meta(f.callId);
  if (!m) return;
  const raw = (await valkey().send('HGET', [membersKey(f.callId), String(sessionId)])) as string | null;
  if (!raw) return;
  const cur = JSON.parse(raw) as Member;
  if (cur.userId !== userId) return;
  // выключенный админом микрофон включить нельзя, пока не «поднимешь руку» и админ не разрешит (как в Telegram)
  const muted = cur.mutedByAdmin ? true : f.muted;
  const next: Member = { ...cur, muted, video: f.video, screen: f.screen, hand: f.hand ? (cur.hand ?? Date.now()) : null, at: Date.now() };
  await valkey().send('HSET', [membersKey(f.callId), String(sessionId), JSON.stringify(next)]);
  await broadcast(publish, f.callId, m.chatId, m.epoch);
}

export async function pingGroupCall(userId: number, sessionId: number, callId: string): Promise<void> {
  const raw = (await valkey().send('HGET', [membersKey(callId), String(sessionId)])) as string | null;
  if (!raw) return;
  const cur = JSON.parse(raw) as Member;
  if (cur.userId !== userId) return;
  await valkey().send('HSET', [membersKey(callId), String(sessionId), JSON.stringify({ ...cur, at: Date.now() })]);
}

/** Право управлять звонком: админ с «Управлением звонками» (владелец — всегда). */
async function adminCtx(userId: number, callId: string): Promise<{ m: NonNullable<Awaited<ReturnType<typeof meta>>>; ctx: GroupCtx }> {
  const m = await meta(callId);
  if (!m) throw new DomainError('not_found', 'call');
  const ctx = await groupCtx(sql, m.chatId, userId);
  if (!hasAdmin(ctx, 'calls')) throw new DomainError('forbidden', 'calls');
  return { m, ctx };
}

/** Выключить микрофон участнику (админ): LiveKit глушит дорожку, участник видит «вас выключил админ». */
export async function muteGroupMember(publish: Publish, userId: number, f: { callId: string; userId: number }): Promise<{ ok: true }> {
  const { m } = await adminCtx(userId, f.callId);
  for (const x of await members(f.callId)) {
    if (x.userId !== f.userId) continue;
    const next: Member = { ...x, muted: true, mutedByAdmin: true, hand: null };
    await valkey().send('HSET', [membersKey(f.callId), String(x.session), JSON.stringify(next)]);
    send(publish, `session:${x.session}`, { op: 'groupCallMuted', callId: f.callId, by: userId });
  }
  await broadcast(publish, f.callId, m.chatId, m.epoch);
  return { ok: true };
}

/** Разрешить говорить снова (админ снимает свой запрет; участник включит микрофон сам). */
export async function allowGroupMember(publish: Publish, userId: number, f: { callId: string; userId: number }): Promise<void> {
  const { m } = await adminCtx(userId, f.callId);
  for (const x of await members(f.callId)) {
    if (x.userId !== f.userId || !x.mutedByAdmin) continue;
    await valkey().send('HSET', [membersKey(f.callId), String(x.session), JSON.stringify({ ...x, mutedByAdmin: false, hand: null })]);
  }
  await broadcast(publish, f.callId, m.chatId, m.epoch);
}

/** Удалить из звонка (админ, или вышел из группы): все его сессии, LiveKit отключает, ключи меняются. */
export async function kickGroupMember(publish: Publish, byUserId: number | null, f: { callId: string; userId: number }): Promise<{ ok: true }> {
  if (byUserId != null) await adminCtx(byUserId, f.callId);
  for (const x of await members(f.callId)) {
    if (x.userId !== f.userId) continue;
    if (byUserId != null) send(publish, `session:${x.session}`, { op: 'groupCallKicked', callId: f.callId, by: byUserId });
    await roomService('RemoveParticipant', f.callId, { identity: identityOf(x.userId, x.session) });
    await leaveGroupCall(publish, f.callId, x.session);
  }
  return { ok: true };
}

/** Завершить для всех: начавший или админ с «Управлением звонками». */
export async function endGroupCallBy(publish: Publish, userId: number, callId: string): Promise<{ ok: true }> {
  const m = await meta(callId);
  if (!m) return { ok: true };
  const ctx = await groupCtx(sql, m.chatId, userId);
  if (!(hasAdmin(ctx, 'calls') || m.startedBy === userId)) throw new DomainError('forbidden', 'calls');
  await endGroupCall(publish, callId);
  return { ok: true };
}

/** Звонок окончен: всем в нём — groupCallEnded, LiveKit закрывает комнату, плашка гаснет, «Звонок завершён (N мин)». */
export async function endGroupCall(publish: Publish, callId: string, alsoNotify: number[] = []): Promise<void> {
  const m = await meta(callId);
  if (!m) return;
  // кто первый удалил хэш звонка, тот и завершает (история — одна)
  if (!Number(await valkey().send('DEL', [callKey(callId)]))) return;
  const ms = await members(callId);
  await valkey().send('DEL', [membersKey(callId)]);
  const cur = (await valkey().send('GET', [chatKey(m.chatId)])) as string | null;
  if (cur === callId) await valkey().send('DEL', [chatKey(m.chatId)]);
  for (const session of new Set([...ms.map((x) => x.session), ...alsoNotify])) send(publish, `session:${session}`, { op: 'groupCallEnded', callId, chatId: m.chatId });
  await roomService('DeleteRoom', callId, {});
  const duration = Math.max(0, Math.round((Date.now() - m.startedAt) / 1000));
  await sql.begin(async (tx) => {
    await tx`update group_calls set ended_at = now(), duration = ${duration} where id = ${callId} and ended_at is null`;
    await serviceMessage(tx, m.chatId, m.startedBy, 'group_call', { groupCall: { callId, state: 'ended', duration } }, '', 'group');
    await chatEvent(tx, m.chatId, { type: 'groupCall', chatId: m.chatId, call: null }, 'group');
  });
}

/** Задача groupcall.check: участники без пинга — ушли; пусто — конец; иначе проверить снова через CHECK_MS. */
export async function checkGroupCall(publish: Publish, callId: string): Promise<void> {
  const m = await meta(callId);
  if (!m) return;
  const now = Date.now();
  for (const x of await members(callId)) if (now - x.at > STALE_MS) await leaveGroupCall(publish, callId, x.session);
  if (await meta(callId)) {
    if (!(await members(callId)).length) await endGroupCall(publish, callId);
    else await enqueue(sql, 'groupcall.check', { callId }, { runAt: new Date(now + CHECK_MS), dedupeKey: `gcall:${callId}:check:${Math.floor(now / CHECK_MS)}` });
  }
}

/** Человек ушёл из группы (вышел, удалили, заблокировали): из идущего звонка — тоже. */
export async function leftGroup(publish: Publish, chatId: number, userId: number): Promise<void> {
  const id = (await valkey().send('GET', [chatKey(chatId)])) as string | null;
  if (id) await kickGroupMember(publish, null, { callId: id, userId });
}

/** Идущие звонки групп из списка (одним MGET): для снимка списка чатов. */
export async function activeGroupCalls(chatIds: number[]): Promise<Map<number, GroupCallSummary>> {
  const out = new Map<number, GroupCallSummary>();
  if (!chatIds.length) return out;
  const ids = (await valkey().send('MGET', chatIds.map(chatKey))) as (string | null)[];
  for (let i = 0; i < chatIds.length; i++) {
    const id = ids[i];
    if (!id) continue;
    const m = await meta(id);
    if (!m) continue;
    const ms = await members(id);
    out.set(chatIds[i], { callId: id, count: ms.length, startedAt: m.startedAt, faces: [...new Set(ms.map((x) => x.userId))].slice(0, GROUP_CALL_FACES) });
  }
  return out;
}
