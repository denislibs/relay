import { GROUP_CALL_FACES, GROUP_CALL_MEMBERS_MAX, GROUP_CALL_PING_MS, GROUP_CALL_TITLE_MAX, graphemes, type GroupCallMember, type GroupCallPlan, type GroupCallServerFrame, type GroupCallSummary } from '@relay/protocol';
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

async function meta(id: string): Promise<{ chatId: number; epoch: number; startedBy: number; startedAt: number; joinMuted: boolean; title: string | null } | null> {
  const flat = (await valkey().send('HGETALL', [callKey(id)])) as string[] | Record<string, string> | null;
  const h: Record<string, string> = Array.isArray(flat) ? Object.fromEntries(flat.flatMap((v, i, a) => (i % 2 ? [] : [[v, a[i + 1]]]))) : (flat ?? {});
  if (!h.chatId) return null;
  return { chatId: Number(h.chatId), epoch: Number(h.epoch ?? 0), startedBy: Number(h.startedBy), startedAt: Number(h.startedAt), joinMuted: h.joinMuted === '1', title: h.title || null };
}

const pub = (m: Member): GroupCallMember => { const { at: _, ...rest } = m; return rest; };

/** Состав и эпоха — всем, кто в звонке (их сессиям). */
async function broadcast(publish: Publish, id: string, chatId: number, epoch: number, list?: Member[]): Promise<void> {
  const ms = list ?? await members(id);
  const [jm, title] = (await valkey().send('HMGET', [callKey(id), 'joinMuted', 'title'])) as (string | null)[];
  const f: GroupCallServerFrame = { op: 'groupCallState', callId: id, chatId, epoch, members: ms.map(pub), ...(jm === '1' ? { joinMuted: true } : {}), ...(title ? { title } : {}) };
  for (const m of ms) send(publish, `session:${m.session}`, f);
}

/** Плашка «Идёт звонок» у всех участников группы (журнал группы). */
async function summarize(chatId: number, id: string | null): Promise<void> {
  let call: GroupCallSummary | null = null;
  if (id) {
    const m = await meta(id);
    const ms = await members(id);
    if (m) call = summaryOf(id, m, ms);
  }
  const plan = await planOf(chatId);
  await sql.begin((tx) => chatEvent(tx, chatId, { type: 'groupCall', chatId, call, plan }, 'group'));
}

const summaryOf = (id: string, m: { startedAt: number; title: string | null }, ms: Member[]): GroupCallSummary =>
  ({ callId: id, count: ms.length, startedAt: m.startedAt, faces: [...new Set(ms.map((x) => x.userId))].slice(0, GROUP_CALL_FACES), ...(m.title ? { title: m.title } : {}) });

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
  return summaryOf(id, m, await members(id));
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
  // запланированный звонок группы начался: название — от плана, план (и его напоминания) больше не нужен
  const [plan] = await sql`delete from group_call_plans where chat_id = ${chatId} returning title`;
  const title = (plan?.title as string | null) ?? null;
  await valkey().send('HSET', [callKey(id), 'chatId', String(chatId), 'epoch', '0', 'startedBy', String(userId), 'startedAt', String(now), ...(title ? ['title', title] : [])]);
  await valkey().send('EXPIRE', [callKey(id), String(TTL)]);
  await sql.begin(async (tx) => {
    await tx`insert into group_calls (id, chat_id, started_by, started_at, title) values (${id}, ${chatId}, ${userId}, to_timestamp(${now / 1000}), ${title})`;
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
  const ctx = await groupCtx(sql, m.chatId, userId);
  const ms = await members(f.callId);
  if (!ms.some((x) => x.session === sessionId) && ms.length >= GROUP_CALL_MEMBERS_MAX) throw new DomainError('forbidden', 'full');
  const prev = ms.find((x) => x.session === sessionId);
  // «новые участники без микрофона» (админ включил): входит заглушённым, кроме админов звонка; повторный вход — как был
  const gag = prev ? { mutedByAdmin: prev.mutedByAdmin, mutedOnJoin: prev.mutedOnJoin } : m.joinMuted && !hasAdmin(ctx, 'calls') ? { mutedByAdmin: true, mutedOnJoin: true } : {};
  const member: Member = { userId, session: sessionId, pub: f.pub, muted: gag.mutedByAdmin ? true : f.muted, video: f.video, screen: false, hand: null, joinedAt: prev?.joinedAt ?? Date.now(), at: Date.now(), ...gag };
  await valkey().send('HSET', [membersKey(f.callId), String(sessionId), JSON.stringify(member)]);
  await valkey().send('EXPIRE', [membersKey(f.callId), String(TTL)]);
  const epoch = Number(await valkey().send('HINCRBY', [callKey(f.callId), 'epoch', '1']));
  const identity = identityOf(userId, sessionId);
  const token = liveKitToken({ room: f.callId, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: false }, identity, 600, { name: String(userId) });
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
    const next: Member = { ...x, muted: true, mutedByAdmin: true, mutedOnJoin: undefined, hand: null };   // лично — правило входа уже ни при чём
    await valkey().send('HSET', [membersKey(f.callId), String(x.session), JSON.stringify(next)]);
    send(publish, `session:${x.session}`, { op: 'groupCallMuted', callId: f.callId, by: userId });
  }
  await broadcast(publish, f.callId, m.chatId, m.epoch);
  return { ok: true };
}

/** Настройки звонка (админ): «новые участники без микрофона». Выключили — заглушённые этим правилом снова могут говорить. */
export async function setGroupCallSettings(publish: Publish, userId: number, f: { callId: string; joinMuted?: boolean; title?: string }): Promise<{ ok: true }> {
  const { m } = await adminCtx(userId, f.callId);
  if (f.title !== undefined) {
    const title = validCallTitle(f.title);
    await valkey().send('HSET', [callKey(f.callId), 'title', title ?? '']);
    await sql`update group_calls set title = ${title} where id = ${f.callId}`;
    await summarize(m.chatId, f.callId);
  }
  if (f.joinMuted === undefined) { await broadcast(publish, f.callId, m.chatId, m.epoch); return { ok: true }; }
  await valkey().send('HSET', [callKey(f.callId), 'joinMuted', f.joinMuted ? '1' : '0']);
  if (!f.joinMuted) {
    for (const x of await members(f.callId)) {
      if (!x.mutedOnJoin) continue;
      await valkey().send('HSET', [membersKey(f.callId), String(x.session), JSON.stringify({ ...x, mutedByAdmin: false, mutedOnJoin: undefined })]);
    }
  }
  await broadcast(publish, f.callId, m.chatId, m.epoch);
  return { ok: true };
}

/** Разрешить говорить снова (админ снимает свой запрет; участник включит микрофон сам). */
export async function allowGroupMember(publish: Publish, userId: number, f: { callId: string; userId: number }): Promise<void> {
  const { m } = await adminCtx(userId, f.callId);
  for (const x of await members(f.callId)) {
    if (x.userId !== f.userId || !x.mutedByAdmin) continue;
    await valkey().send('HSET', [membersKey(f.callId), String(x.session), JSON.stringify({ ...x, mutedByAdmin: false, mutedOnJoin: undefined, hand: null })]);
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
    out.set(chatIds[i], summaryOf(id, m, await members(id)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Запланированный звонок (этап 7 docs/plans/2026-11-07-relay-calls-features.md): один план на группу, ставит админ с
// правом calls; кто нажал «Напомнить» — напоминание в срок; звонок не начинается сам — его начинает админ (или любой,
// если в группе можно всем), название переходит звонку; не начатый через 2 часа после срока — снимается.

const PLAN_MIN_MS = 60_000;
const PLAN_MAX_MS = 30 * 24 * 3600_000;
const PLAN_STALE_MS = 2 * 3600_000;

/** Название звонка: пробелы схлопнуты, пустое — нет названия. */
export function validCallTitle(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') throw new DomainError('bad_frame', 'title');
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (graphemes(t) > GROUP_CALL_TITLE_MAX) throw new DomainError('too_long', 'title');
  return t;
}

async function planOf(chatId: number): Promise<GroupCallPlan | null> {
  const [p] = await sql`select id, title, at, created_by from group_call_plans where chat_id = ${chatId}`;
  return p ? { id: p.id as string, at: new Date(p.at as string).getTime(), title: (p.title as string | null) ?? null, by: Number(p.created_by ?? 0) } : null;
}

/** Планы групп из списка — для снимка списка чатов. */
export async function groupCallPlans(chatIds: number[]): Promise<Map<number, GroupCallPlan>> {
  const out = new Map<number, GroupCallPlan>();
  if (!chatIds.length) return out;
  for (const p of await sql`select id, chat_id, title, at, created_by from group_call_plans where chat_id = any(${chatIds}::bigint[])`)
    out.set(Number(p.chat_id), { id: p.id as string, at: new Date(p.at as string).getTime(), title: (p.title as string | null) ?? null, by: Number(p.created_by ?? 0) });
  return out;
}

/** Запланировать (или перенести): админ с «Управлением звонками». Сам админ — в напоминаемых. */
export async function planGroupCall(userId: number, chatId: number, body: { title?: unknown; at?: unknown }): Promise<GroupCallPlan> {
  const ctx = await groupCtx(sql, chatId, userId);
  if (ctx.kind !== 'group') throw new DomainError('bad_frame', 'not a group');
  if (!hasAdmin(ctx, 'calls')) throw new DomainError('forbidden', 'calls');
  const at = typeof body.at === 'number' ? body.at : NaN;
  const now = Date.now();
  if (!Number.isFinite(at) || at < now + PLAN_MIN_MS || at > now + PLAN_MAX_MS) throw new DomainError('bad_frame', 'at');
  const title = validCallTitle(body.title);
  const id = crypto.randomUUID();
  await sql.begin(async (tx) => {
    await tx`delete from group_call_plans where chat_id = ${chatId}`;
    await tx`insert into group_call_plans (id, chat_id, created_by, title, at) values (${id}, ${chatId}, ${userId}, ${title}, to_timestamp(${at / 1000}))`;
    await tx`insert into group_call_reminders (plan_id, user_id) values (${id}, ${userId})`;
    await serviceMessage(tx, chatId, userId, 'group_call', { groupCall: { callId: id, state: 'scheduled', at, ...(title ? { title } : {}) } }, '', 'group');
    await enqueue(tx, 'groupcall.remind', { planId: id }, { runAt: new Date(at), dedupeKey: `gplan:${id}:remind` });
    await enqueue(tx, 'groupcall.planExpire', { planId: id }, { runAt: new Date(at + PLAN_STALE_MS), dedupeKey: `gplan:${id}:expire` });
  });
  await summarize(chatId, (await valkey().send('GET', [chatKey(chatId)])) as string | null);
  return { id, at, title, by: userId };
}

export async function cancelGroupCallPlan(userId: number, chatId: number): Promise<{ ok: true }> {
  const ctx = await groupCtx(sql, chatId, userId);
  if (!hasAdmin(ctx, 'calls')) throw new DomainError('forbidden', 'calls');
  await sql`delete from group_call_plans where chat_id = ${chatId}`;
  await summarize(chatId, (await valkey().send('GET', [chatKey(chatId)])) as string | null);
  return { ok: true };
}

/** План группы и «напомнить мне» этого участника. */
export async function getGroupCallPlan(userId: number, chatId: number): Promise<{ plan: GroupCallPlan | null; remind: boolean }> {
  await groupCtx(sql, chatId, userId);
  const plan = await planOf(chatId);
  if (!plan) return { plan: null, remind: false };
  const [r] = await sql`select 1 from group_call_reminders where plan_id = ${plan.id} and user_id = ${userId}`;
  return { plan, remind: !!r };
}

export async function remindGroupCallPlan(userId: number, chatId: number, on: boolean): Promise<{ remind: boolean }> {
  await groupCtx(sql, chatId, userId);
  const plan = await planOf(chatId);
  if (!plan) throw new DomainError('not_found', 'plan');
  if (on) await sql`insert into group_call_reminders (plan_id, user_id) values (${plan.id}, ${userId}) on conflict do nothing`;
  else await sql`delete from group_call_reminders where plan_id = ${plan.id} and user_id = ${userId}`;
  return { remind: on };
}

/** Кого напомнить в срок (задача groupcall.remind): план ещё стоит и звонок не начат; только участники группы. */
export async function planReminders(planId: string): Promise<{ chatId: number; title: string | null; users: number[] } | null> {
  const [p] = await sql`select p.chat_id, p.title from group_call_plans p where p.id = ${planId}`;
  if (!p) return null;
  if (await valkey().send('GET', [chatKey(Number(p.chat_id))])) return null;   // уже идёт
  const users = (await sql`select r.user_id from group_call_reminders r join chat_members m on m.chat_id = ${p.chat_id} and m.user_id = r.user_id where r.plan_id = ${planId}`).map((r) => Number(r.user_id));
  return { chatId: Number(p.chat_id), title: (p.title as string | null) ?? null, users };
}

/** Не начатый через PLAN_STALE_MS после срока — снять (задача groupcall.planExpire). */
export async function expireGroupCallPlan(planId: string): Promise<void> {
  const [p] = await sql`delete from group_call_plans where id = ${planId} returning chat_id`;
  if (p) await summarize(Number(p.chat_id), (await valkey().send('GET', [chatKey(Number(p.chat_id))])) as string | null);
}
