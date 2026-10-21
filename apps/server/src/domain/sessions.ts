import type { SessionInfo } from '@relay/protocol';
import { isPrivateIp, placeText } from '../geoip';
import { sql, type Tx } from '../db';
import { hashToken } from '../auth';
import { DomainError } from './errors';
import { appendUpdates } from './journal';
import { LOGIN_CONFIRMED, LOGIN_ENDED, newLoginMessage, postService, resolveLoginAlerts } from './service';

export const DEFAULT_TTL_DAYS = 180;
/** предельный срок cookie и строки (скользит от последней активности); настоящий предел — неактивность (sessions_ttl_days, не больше года) */
export const SESSION_DAYS = 366;
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

/** Почему сеанс закончился: выход в этом же браузере или завершение (с другого устройства, автозавершение). */
export type EndReason = 'logout' | 'terminated';
export const terminatedFrame = (reason: EndReason): string => JSON.stringify({ op: 'sessionTerminated', reason });
/** 4001 — сеанс завершён: клиент не переподключается. */
export const CLOSE_TERMINATED = 4001;

/** Сеанс завершён (в любом процессе — через NOTIFY sessions): сокеты этого процесса закрываются.
 *  frame — послать кадр самому (проверка сокета); из NOTIFY кадр уже опубликован в топик session:<id> (realtime.ts). */
export function closeLive(sessionId: number, frame?: string): void {
  const set = live.get(sessionId);
  if (!set) return;
  live.delete(sessionId);
  for (const ws of set) {
    try { if (frame) ws.send(frame); ws.close(CLOSE_TERMINATED, 'session_terminated'); } catch { /* сокет уже закрыт */ }
  }
}

/** Сообщить всем процессам о завершённых сеансах (уходит после коммита транзакции). */
async function notifyTerminated(db: Tx | typeof sql, ids: number[], reason: EndReason = 'terminated'): Promise<void> {
  if (ids.length) await db`select pg_notify('sessions', ${JSON.stringify({ ids, reason })})`;
}

/** Разбор NOTIFY sessions: {ids, reason} (или старый вид — массив id). */
export function parseEnded(payload: string): { ids: number[]; reason: EndReason } | null {
  let v: unknown;
  try { v = JSON.parse(payload); } catch { return null; }
  if (Array.isArray(v)) return { ids: v.map(Number), reason: 'terminated' };
  const o = v as { ids?: unknown; reason?: unknown } | null;
  if (!o || !Array.isArray(o.ids)) return null;
  return { ids: o.ids.map(Number), reason: o.reason === 'logout' ? 'logout' : 'terminated' };
}

// ---- активность сокетов: NOTIFY бывает потерян (LISTEN переподключался), поэтому сокет сам проверяет свой сеанс ----

/** как часто сокет отмечает активность и проверяет, что его сеанс жив (тесты ставят 0) */
let checkMs = 60_000;
export function setLiveCheckMs(ms: number): void { checkMs = ms; }
export const liveCheckMs = (): number => checkMs;

/**
 * Отметить активность сеансов (last_active_at, скользящий expires_at) и вернуть те, что ещё живы:
 * удалённые, истёкшие и неактивные дольше срока в ответ не попадают.
 */
export async function touchSessions(ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await sql`
    update sessions s set last_active_at = now(), expires_at = greatest(s.expires_at, now() + ${SESSION_DAYS + ' days'}::interval)
     where s.id = any(${ids}) and s.expires_at > now()
       and s.last_active_at > now() - make_interval(days => coalesce((select us.sessions_ttl_days from user_settings us where us.user_id = s.user_id), ${DEFAULT_TTL_DAYS}))
     returning s.id`;
  return new Set(rows.map((r) => Number(r.id)));
}

/** Сокет сеанса: пора отметиться (раз в checkMs)? Жив — true; нет — кадр sessionTerminated и закрытие 4001. */
export async function checkSocket(sessionId: number, data: { checkedAt: number }): Promise<boolean> {
  if (Date.now() - data.checkedAt < checkMs) return true;
  data.checkedAt = Date.now();
  const alive = await touchSessions([sessionId]);
  if (alive.has(sessionId)) return true;
  closeLive(sessionId, terminatedFrame('terminated'));
  return false;
}

/** Все живые сокеты процесса разом (раз в минуту, realtime.ts): активность и закрытие тех, чей сеанс пропал. */
export async function touchLive(): Promise<number[]> {
  const ids = [...live.keys()];
  const alive = await touchSessions(ids);
  const dead = ids.filter((id) => !alive.has(id));
  for (const id of dead) closeLive(id, terminatedFrame('terminated'));
  return dead;
}

// ---- список и завершение ----

/** Сеанс не подтверждён: вход по коду без «Да, это я» и моложе недели. */
const UNCONFIRMED = sql`(confirmed_at is null and created_at > now() - interval '7 days')`;
/** Новый сеанс (как в Telegram): не подтверждён или ещё не прошли сутки после входа (restricted_until). */
const LIMITED = sql`(${UNCONFIRMED} or coalesce(restricted_until > now(), false))`;

/**
 * Новый сеанс не может: завершать, подтверждать и впускать (QR) другие, менять пароль, почту восстановления и паскеи.
 * Ограничение снимается подтверждением «Это я» с другого устройства или само — через сутки (неделю, если вход по коду
 * так и не подтвердили).
 */
export async function assertConfirmed(db: Tx | typeof sql, sessionId: number): Promise<void> {
  // for update: строка вызывающего сеанса держится до конца транзакции, параллельное завершение дождётся
  const [r] = await db`select ${LIMITED} as u from sessions where id = ${sessionId} for update`;
  if (!r) throw new DomainError('unauthorized');   // сеанса уже нет — закрыто, а не открыто
  if (r.u) throw new DomainError('fresh_session');
}

const changed = (db: Tx, userId: number) => appendUpdates(db, [{ userId, update: { type: 'sessionsChanged' } }]);

type Row = { id: number; device: string | null; ip: string | null; created_at: Date; last_active_at: Date; unconfirmed: boolean; limited: boolean;
  restricted_until: Date | null; login_method: string | null; country: string | null; city: string | null };

/** Сеансы пользователя: текущий первым, дальше — по последней активности. */
export async function listSessions(userId: number, currentId: number): Promise<SessionInfo[]> {
  const rows = await sql<Row[]>`
    select id, device, ip, created_at, last_active_at, ${UNCONFIRMED} as unconfirmed, ${LIMITED} as limited, restricted_until, login_method, country, city from sessions
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
    unconfirmed: !!r.unconfirmed,
    limited: !!r.limited,
    place: placeText({ country: r.country, city: r.city, local: !!r.ip && isPrivateIp(r.ip) }),
    method: (r.login_method as SessionInfo['method']) ?? null,
  }));
}

/** Завершить свой другой сеанс. Текущий — только через /logout (400); чужой или несуществующий — 404. */
export async function terminateSession(userId: number, currentId: number, id: number): Promise<{ ok: true; id: number }> {
  if (id === currentId) throw new DomainError('bad_frame');
  await sql.begin(async (tx) => {
    await assertConfirmed(tx, currentId);
    const rows = await tx`delete from sessions where id = ${id} and user_id = ${userId} returning id`;
    if (!rows.length) throw new DomainError('not_found');
    await changed(tx, userId);
    await resolveLoginAlerts(tx, userId, [id], LOGIN_ENDED);   // кнопки под «Новым входом» о нём больше не нужны
    await notifyTerminated(tx, [id]);
  });
  return { ok: true, id };
}

/** «Да, это я» с другого устройства. Неподтверждённый сеанс подтверждать не может, себя — тоже. */
export async function confirmSession(userId: number, currentId: number, id: number): Promise<{ ok: true }> {
  if (id === currentId) throw new DomainError('bad_frame');
  await sql.begin(async (tx) => {
    await assertConfirmed(tx, currentId);
    const rows = await tx`update sessions set confirmed_at = now(), restricted_until = null where id = ${id} and user_id = ${userId} returning id`;
    if (!rows.length) throw new DomainError('not_found');
    await changed(tx, userId);
    await resolveLoginAlerts(tx, userId, [id], LOGIN_CONFIRMED);
  });
  return { ok: true };
}

/**
 * После входа: sessionsChanged (плашка «Это вы?» на остальных устройствах) и служебное «Новый вход» с кнопками —
 * только если есть кому ответить: другой живой подтверждённый сеанс. Первый вход, вход после выхода отовсюду или
 * когда остальные сеансы сами не подтверждены — без вопроса: подтвердить его всё равно некому.
 * В сообщении — устройство, место по IP, способ входа; «необычное место» — страны входа нет ни у одного другого сеанса.
 */
export async function announceLogin(userId: number, token: string): Promise<void> {
  const [s] = await sql`select id, device, ip, created_at, country, city, login_method from sessions where token_hash = ${hashToken(token)}`;
  if (!s) return;
  await sql.begin(async (tx) => {
    const [peer] = await tx`select 1 from sessions where user_id = ${userId} and id <> ${s.id} and expires_at > now() and not ${UNCONFIRMED} limit 1`;
    if (peer) {
      const known = (await tx`select distinct country from sessions where user_id = ${userId} and id <> ${s.id} and expires_at > now() and country is not null`).map((r) => r.country as string);
      const unusual = !!s.country && known.length > 0 && !known.includes(s.country as string);
      const place = placeText({ country: s.country as string | null, city: s.city as string | null, local: !!s.ip && isPrivateIp(s.ip as string) });
      await postService(tx, userId, { type: 'new_login', ...newLoginMessage(s.device || 'Браузер', s.ip, new Date(s.created_at), Number(s.id), { place, unusual, method: s.login_method as string | null, usual: known }) });
    }
    await changed(tx, userId);
  });
}

/** Завершить все сеансы, кроме текущего. */
export async function terminateOthers(userId: number, currentId: number): Promise<{ ok: true; ids: number[] }> {
  const ids = await sql.begin(async (tx) => {
    await assertConfirmed(tx, currentId);
    const rows = await tx`delete from sessions where user_id = ${userId} and id <> ${currentId} returning id`;
    const ids = rows.map((r) => Number(r.id));
    // подписки Web Push завершённых сеансов уходят каскадом (session_id)
    if (ids.length) await changed(tx, userId);
    await resolveLoginAlerts(tx, userId, ids, LOGIN_ENDED);
    await notifyTerminated(tx, ids);
    return ids;
  }) as number[];
  return { ok: true, ids };
}

/** Список сеансов пользователя изменился (выход): остальные устройства обновят его. */
export function announceSessionsChanged(userId: number): Promise<void> {
  return sql.begin((tx) => changed(tx, userId)) as Promise<void>;
}

/** Выход (POST /logout) удалил строку: закрыть сокеты этого сеанса в других вкладках. */
export function sessionEnded(id: number): Promise<void> {
  return notifyTerminated(sql, [id], 'logout');
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
       returning s.id, s.user_id`;
    const ids = rows.map((r) => Number(r.id));
    for (const u of new Set(rows.map((r) => Number(r.user_id)))) await changed(tx, u);
    await notifyTerminated(tx, ids);
    return ids;
  }) as Promise<number[]>;
}
