import { RECENTLY, type PresenceItem } from '@relay/protocol';
import { sql } from '../db';
import { canSeeLastSeen, privacyCtx, type PrivacyCtx } from './privacy';

/**
 * Кто в сети: число открытых WebSocket пользователя в этом процессе.
 * «Не в сети» объявляем не сразу, а через GRACE_MS: перезагрузка вкладки или короткий обрыв не мигают
 * у собеседников. Изменения рассылаются собеседникам по личным чатам сразу, мимо журнала — это не данные,
 * а состояние момента. (Один процесс сервера; для нескольких понадобится общий реестр, например через NOTIFY.)
 *
 * Правило «Последний визит» (privacy.ts, с взаимностью): кому не положено — {online: null, lastSeen: 'recently'};
 * таким собеседникам о входе и выходе не сообщаем вовсе — иначе само время кадра выдало бы, когда человек в сети.
 */
const conns = new Map<number, number>();
const leaving = new Map<number, ReturnType<typeof setTimeout>>();
const graceMs = () => Number(process.env.RELAY_PRESENCE_GRACE_MS ?? 4000);
/** Публикация в топик пользователя на том сервере, где живёт соединение. */
export type Publish = (topic: string, msg: string) => void;

export function isOnline(userId: number): boolean {
  return (conns.get(userId) ?? 0) > 0 || leaving.has(userId);
}

const hidden = (userId: number): PresenceItem => ({ userId, online: null, lastSeen: RECENTLY });
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/** Присутствие owner глазами viewer. */
export function presenceFor(viewer: number, owner: number, lastSeenAt: unknown, ctx: PrivacyCtx): PresenceItem {
  return canSeeLastSeen(viewer, owner, ctx) ? { userId: owner, online: isOnline(owner), lastSeen: iso(lastSeenAt) } : hidden(owner);
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
  for (const [v, o] of dirs) {
    const [t] = await sql`select (
        exists (select 1 from contacts where owner_id = ${v} and user_id = ${o})
        or exists (select 1 from chat_members m join chats ch on ch.id = m.chat_id and ch.kind = 'direct'
                    join chat_members x on x.chat_id = m.chat_id and x.user_id = ${o} where m.user_id = ${v})
      ) as ok`;
    if (t.ok) publish(`user:${v}`, JSON.stringify({ op: 'presence', items: [presenceFor(v, o, seen.get(o), c.after)] }));
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
    for (const peer of peers) publish(`user:${peer}`, JSON.stringify({ op: 'presence', items: [presenceFor(peer, userId, row?.last_seen_at, ctx)] }));
  }
  const own = await listPresence(userId);
  if (own.length) publish(`user:${userId}`, JSON.stringify({ op: 'presence', items: own }));
}

export async function connected(publish: Publish, userId: number): Promise<void> {
  const n = (conns.get(userId) ?? 0) + 1;
  conns.set(userId, n);
  const pending = leaving.get(userId);
  if (pending) { clearTimeout(pending); leaving.delete(userId); return; } // вернулся до конца паузы — для собеседников он и не уходил
  if (n === 1) await announce(publish, { userId, online: true, lastSeen: null });
}

export function disconnected(publish: Publish, userId: number): void {
  const n = Math.max(0, (conns.get(userId) ?? 0) - 1);
  if (n > 0) { conns.set(userId, n); return; }
  conns.delete(userId);
  leaving.set(userId, setTimeout(async () => {
    leaving.delete(userId);
    if ((conns.get(userId) ?? 0) > 0) return;
    const [row] = await sql`update users set last_seen_at = now() where id = ${userId} returning last_seen_at`;
    await announce(publish, { userId, online: false, lastSeen: row ? iso(row.last_seen_at) : null });
  }, graceMs()));
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
  return rows.map((r) => presenceFor(userId, Number(r.id), r.last_seen_at, ctx));
}

/** Только для тестов: база сброшена, id пользователей начнутся заново — забыть соединения прежних тестов. */
export function resetPresence(): void {
  for (const t of leaving.values()) clearTimeout(t);
  leaving.clear();
  conns.clear();
}
