import { RECENTLY, type PresenceItem } from '@relay/protocol';
import { sql } from '../db';
import { connect, connectionCount, disconnect, leave, onlineUsers, PROCESS_ID } from './liveRegistry';
import { canSeeLastSeen, privacyCtx, type PrivacyCtx } from './privacy';
import { DomainError } from './errors';
import { nameForSql } from './profile';

/**
 * Кто в сети — по всей системе (liveRegistry.ts, Valkey). «В сети» объявляем на первом сокете во всех процессах,
 * «не в сети» — через GRACE_MS после последнего: перезагрузка вкладки или короткий обрыв не мигают у собеседников.
 * Таймер ставит процесс, на котором ушёл последний сокет. Рассылка собеседникам — через шину (publish), мимо
 * журнала: это не данные, а состояние момента.
 *
 * Правило «Последний визит» (privacy.ts, с взаимностью): кому не положено — {online: null, lastSeen: 'recently'};
 * таким собеседникам о входе и выходе не сообщаем вовсе — иначе само время кадра выдало бы, когда человек в сети.
 */
const leaving = new Map<number, ReturnType<typeof setTimeout>>();
const graceMs = () => Number(process.env.RELAY_PRESENCE_GRACE_MS ?? 4000);
/** Публикация в топик пользователя на том сервере, где живёт соединение. */
export type Publish = (topic: string, msg: string) => void;

// подключения и отключения одного пользователя в этом процессе — по очереди: «ушёл → вернулся» не перепутаются
const queue = new Map<number, Promise<unknown>>();
function serial<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const next = (queue.get(userId) ?? Promise.resolve()).then(fn, fn);
  queue.set(userId, next);
  void next.finally(() => { if (queue.get(userId) === next) queue.delete(userId); }).catch(() => {});
  return next;
}

const hidden = (userId: number): PresenceItem => ({ userId, online: null, lastSeen: RECENTLY });
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/** Присутствие owner глазами viewer. */
export function presenceFor(viewer: number, owner: number, lastSeenAt: unknown, ctx: PrivacyCtx, online: boolean): PresenceItem {
  return canSeeLastSeen(viewer, owner, ctx) ? { userId: owner, online, lastSeen: iso(lastSeenAt) } : hidden(owner);
}

/** Кому сообщать о присутствии пользователя: собеседникам по личным чатам и тем, у кого он в контактах. */
async function peersOf(userId: number): Promise<number[]> {
  const rows = await sql`
    select o.user_id from chat_members m
    join chats c on c.id = m.chat_id and c.kind = 'direct'
    join chat_members o on o.chat_id = m.chat_id and o.user_id <> m.user_id
    where m.user_id = ${userId}
    union
    select owner_id from contacts where user_id = ${userId}`;
  return rows.map((r) => Number(r.user_id));
}

/** Разослать присутствие пользователя тем собеседникам, кому его видно (остальным — ничего). */
async function announce(publish: Publish, item: PresenceItem): Promise<void> {
  const peers = await peersOf(item.userId);
  if (!peers.length) return;
  const ctx = await privacyCtx(sql, peers.map((p) => [p, item.userId]));
  const msg = JSON.stringify({ op: 'presence', items: [item] });
  for (const peer of peers) if (canSeeLastSeen(peer, item.userId, ctx)) publish(`user:${peer}`, msg);
}

/** Связь двух людей изменилась (контакт, блокировка): контексты приватности пары до и после. */
export interface PairChange { a: number; b: number; before: PrivacyCtx; after: PrivacyCtx }

/**
 * Каждой стороне пары — её нынешний вид другой, но только если он изменился (точное время ↔ «недавно»)
 * и только тому, кто этого человека вообще отслеживает (личный чат или контакт) — как listPresence.
 */
export async function announcePair(publish: Publish, c: PairChange): Promise<void> {
  const dirs = ([[c.a, c.b], [c.b, c.a]] as const).filter(([v, o]) => canSeeLastSeen(v, o, c.before) !== canSeeLastSeen(v, o, c.after));
  if (!dirs.length) return;
  const rows = await sql`
    select u.id, u.last_seen_at from users u where u.id = any(${[c.a, c.b]}::bigint[])`;
  const seen = new Map(rows.map((r) => [Number(r.id), r.last_seen_at]));
  const online = await onlineUsers([c.a, c.b]);
  for (const [v, o] of dirs) {
    const [t] = await sql`select (
        exists (select 1 from contacts where owner_id = ${v} and user_id = ${o})
        or exists (select 1 from chat_members m join chats ch on ch.id = m.chat_id and ch.kind = 'direct'
                    join chat_members x on x.chat_id = m.chat_id and x.user_id = ${o} where m.user_id = ${v})
      ) as ok`;
    if (t.ok) publish(`user:${v}`, JSON.stringify({ op: 'presence', items: [presenceFor(v, o, seen.get(o), c.after, online.has(o))] }));
  }
}

/**
 * Правило «Последний визит» изменилось: всем собеседникам — их нынешний вид этого человека
 * (в том числе «недавно»), а ему самому — снимок собеседников (взаимность меняет и то, что видит он).
 */
export async function reannounce(publish: Publish, userId: number): Promise<void> {
  const peers = await peersOf(userId);
  if (peers.length) {
    const ctx = await privacyCtx(sql, peers.map((p) => [p, userId]));
    const [row] = await sql`select last_seen_at from users where id = ${userId}`;
    const on = (await onlineUsers([userId])).has(userId);
    for (const peer of peers) publish(`user:${peer}`, JSON.stringify({ op: 'presence', items: [presenceFor(peer, userId, row?.last_seen_at, ctx, on)] }));
  }
  const own = await listPresence(userId);
  if (own.length) publish(`user:${userId}`, JSON.stringify({ op: 'presence', items: own }));
}

export async function connected(publish: Publish, userId: number): Promise<void> {
  const pending = leaving.get(userId);
  if (pending) { clearTimeout(pending); leaving.delete(userId); }
  const { total, returning } = await serial(userId, () => connect(userId));
  // первый сокет во всей системе и не возврат в паузе — собеседникам «в сети»
  if (total === 1 && !returning) await announce(publish, { userId, online: true, lastSeen: null });
}

export function disconnected(publish: Publish, userId: number): void {
  const token = crypto.randomUUID();
  void serial(userId, () => disconnect(userId, PROCESS_ID, token)).then((total) => {
    if (total > 0) return;                         // ещё есть сокеты — здесь или в другом процессе
    leaving.set(userId, setTimeout(() => {
      leaving.delete(userId);
      void (async () => {
        // вернулся за паузу (в любом процессе) или пауза уже чужая, более поздняя, — уход объявит её таймер
        if (!(await leave(userId, token))) return;
        const [row] = await sql`update users set last_seen_at = now() where id = ${userId} returning last_seen_at`;
        await announce(publish, { userId, online: false, lastSeen: row ? iso(row.last_seen_at) : null });
        // вернулся, пока объявляли уход: его «в сети» могло обогнать наш кадр — повторить, чтобы последним было верное
        if ((await connectionCount(userId)) > 0) await announce(publish, { userId, online: true, lastSeen: null });
      })().catch((e) => console.error('presence:', e));
    }, graceMs()));
  }).catch((e) => console.error('presence:', e));
}

/** Присутствие всех собеседников и контактов пользователя — снимок после подключения. */
export async function listPresence(userId: number): Promise<PresenceItem[]> {
  const rows = await sql`
    select u.id, u.last_seen_at from users u
     where u.id in (
       select o.user_id from chat_members m
         join chats c on c.id = m.chat_id and c.kind = 'direct'
         join chat_members o on o.chat_id = m.chat_id and o.user_id <> m.user_id
        where m.user_id = ${userId}
       union
       select user_id from contacts where owner_id = ${userId})`;
  const ctx = await privacyCtx(sql, rows.map((r) => [userId, Number(r.id)]));
  const online = await onlineUsers(rows.map((r) => Number(r.id)));
  return rows.map((r) => presenceFor(userId, Number(r.id), r.last_seen_at, ctx, online.has(Number(r.id))));
}

/** Только для тестов: забыть таймеры прежних тестов (ключи Valkey чистит resetDb через flushOwn). */
export function resetPresence(): void {
  for (const t of leaving.values()) clearTimeout(t);
  leaving.clear();
  queue.clear();
}

/**
 * Участники группы для панели «Информация»: имя (как его видит зритель), @имя, присутствие с учётом приватности
 * и владелец — создатель группы (автор служебного «создал(а) группу»). Онлайн сверху, дальше — по последнему визиту.
 */
export async function chatMembers(viewer: number, chatId: number): Promise<{ ownerId: number | null; members: (PresenceItem & { name: string; username: string | null })[] }> {
  const [me] = await sql`select 1 from chat_members where chat_id = ${chatId} and user_id = ${viewer}`;
  if (!me) throw new DomainError('not_member');
  const rows = await sql`
    select u.id, ${nameForSql(viewer)} as name, u.username, u.last_seen_at from chat_members m join users u on u.id = m.user_id
     where m.chat_id = ${chatId} and not u.system limit 1000`;
  const [owner] = await sql`select sender_id from messages where chat_id = ${chatId} and service_type = 'group_created' order by id limit 1`;
  const ids = rows.map((r) => Number(r.id));
  const ctx = await privacyCtx(sql, ids.filter((id) => id !== viewer).map((id) => [viewer, id] as [number, number]));
  const online = await onlineUsers(ids);
  const members = rows.map((r) => {
    const id = Number(r.id);
    const p = id === viewer ? { userId: id, online: true, lastSeen: null } : presenceFor(viewer, id, r.last_seen_at, ctx, online.has(id));
    return { ...p, name: r.name as string, username: (r.username as string | null) ?? null };
  });
  const seen = (m: { lastSeen: string | null }) => (m.lastSeen && m.lastSeen !== RECENTLY ? Date.parse(m.lastSeen) || 0 : 0);
  members.sort((a, b) => Number(!!b.online) - Number(!!a.online) || seen(b) - seen(a) || a.name.localeCompare(b.name, 'ru'));
  return { ownerId: owner ? Number(owner.sender_id) : null, members };
}
