import type { SessionInfo } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';

const DEFAULT_TTL_DAYS = 180;
/** «в сети»: сокет в этом процессе или запрос не позже, чем столько назад */
const ONLINE_MS = 2 * 60_000;

// ---- живые сокеты сеансов в этом процессе ----

export interface LiveSocket { send(msg: string): unknown; close(code?: number, reason?: string): unknown }
const live = new Map<number, Set<LiveSocket>>();

export function trackSocket(sessionId: number, ws: LiveSocket): void {
  let set = live.get(sessionId);
  if (!set) live.set(sessionId, (set = new Set()));
  set.add(ws);
}
export function untrackSocket(sessionId: number, ws: LiveSocket): void {
  const set = live.get(sessionId);
  if (!set) return;
  set.delete(ws);
  if (!set.size) live.delete(sessionId);
}
export const isLive = (sessionId: number): boolean => live.has(sessionId);

export const TERMINATED_FRAME = JSON.stringify({ op: 'sessionTerminated' });
/** 4001 — сеанс завершён: клиент не переподключается. */
export const CLOSE_TERMINATED = 4001;

/** Сеанс завершён (в любом процессе — через NOTIFY sessions): сокеты этого процесса закрываются.
 *  Кадр sessionTerminated к этому моменту уже опубликован в топик session:<id> (realtime.ts) и уходит раньше закрытия. */
export function closeLive(sessionId: number): void {
  const set = live.get(sessionId);
  if (!set) return;
  live.delete(sessionId);
  for (const ws of set) {
    try { ws.close(CLOSE_TERMINATED, 'session_terminated'); } catch { /* сокет уже закрыт */ }
  }
}

/** Сообщить всем процессам о завершённых сеансах (уходит после коммита транзакции). */
async function notifyTerminated(db: Tx | typeof sql, ids: number[]): Promise<void> {
  if (ids.length) await db`select pg_notify('sessions', ${JSON.stringify(ids)})`;
}

// ---- список и завершение ----

type Row = { id: number; device: string | null; ip: string | null; created_at: Date; last_active_at: Date };

/** Сеансы пользователя: текущий первым, дальше — по последней активности. */
export async function listSessions(userId: number, currentId: number): Promise<SessionInfo[]> {
  const rows = await sql<Row[]>`
    select id, device, ip, created_at, last_active_at from sessions
     where user_id = ${userId} and expires_at > now()
     order by (id = ${currentId}) desc, last_active_at desc, id desc`;
  const now = Date.now();
  return rows.map((r) => ({
    id: Number(r.id),
    device: r.device || 'Браузер',
    ip: r.ip,
    createdAt: new Date(r.created_at).toISOString(),
    lastActiveAt: new Date(r.last_active_at).toISOString(),
    current: Number(r.id) === currentId,
    online: Number(r.id) === currentId || isLive(Number(r.id)) || now - new Date(r.last_active_at).getTime() < ONLINE_MS,
  }));
}

/** Завершить свой другой сеанс. Текущий — только через /logout (400); чужой или несуществующий — 404. */
export async function terminateSession(userId: number, currentId: number, id: number): Promise<{ ok: true; id: number }> {
  if (id === currentId) throw new DomainError('bad_frame');
  await sql.begin(async (tx) => {
    const rows = await tx`delete from sessions where id = ${id} and user_id = ${userId} returning id`;
    if (!rows.length) throw new DomainError('not_found');
    await notifyTerminated(tx, [id]);
  });
  return { ok: true, id };
}

/** Завершить все сеансы, кроме текущего. */
export async function terminateOthers(userId: number, currentId: number): Promise<{ ok: true; ids: number[] }> {
  const ids = await sql.begin(async (tx) => {
    const rows = await tx`delete from sessions where user_id = ${userId} and id <> ${currentId} returning id`;
    const ids = rows.map((r) => Number(r.id));
    await notifyTerminated(tx, ids);
    return ids;
  }) as number[];
  return { ok: true, ids };
}

/** Выход (POST /logout) удалил строку: закрыть сокеты этого сеанса в других вкладках. */
export function sessionEnded(id: number): Promise<void> {
  return notifyTerminated(sql, [id]);
}

/**
 * Автозавершение: удалить сеансы, неактивные дольше срока владельца (user_settings.sessions_ttl_days), и истёкшие.
 * userId — только его сеансы (при входе и смене срока), без него — все (раз в час).
 */
export async function sweepInactive(userId?: number): Promise<number[]> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      delete from sessions s
       where ${userId == null ? tx`true` : tx`s.user_id = ${userId}`}
         and (s.expires_at <= now()
              or s.last_active_at < now() - make_interval(days => coalesce((select us.sessions_ttl_days from user_settings us where us.user_id = s.user_id), ${DEFAULT_TTL_DAYS})))
       returning s.id`;
    const ids = rows.map((r) => Number(r.id));
    await notifyTerminated(tx, ids);
    return ids;
  }) as Promise<number[]>;
}
