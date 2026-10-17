import { createHash, randomBytes } from 'node:crypto';
import { sql } from './db';

// предельный срок cookie и строки; настоящий предел — неактивность (user_settings.sessions_ttl_days, не больше года)
const SESSION_DAYS = 366;
const DEFAULT_TTL_DAYS = 180;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createUser(name: string): Promise<number> {
  const [row] = await sql`insert into users (name) values (${name.slice(0, 64) || 'user'}) returning id`;
  return row.id as number;
}

/** Новый сеанс; device — грубое имя из User-Agent (device.ts), ip — адрес входа. */
export async function createSession(userId: number, meta: { device?: string | null; ip?: string | null } = {}): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (token_hash, user_id, expires_at, device, ip) values (${hash(token)}, ${userId}, now() + ${SESSION_DAYS + ' days'}::interval, ${meta.device ?? null}, ${meta.ip ?? null})`;
  return token;
}

export interface SessionRef { userId: number; sessionId: number }

/**
 * Сеанс по токену. Неактивный дольше срока автозавершения — уже не действует (даже если чистка ещё не дошла).
 * last_active_at трогаем не чаще раза в минуту: один UPDATE только у «несвежей» строки.
 */
export async function sessionFromToken(token: string | null): Promise<SessionRef | null> {
  if (!token) return null;
  const [row] = await sql`
    select s.id, s.user_id, s.last_active_at < now() - interval '1 minute' as stale
      from sessions s left join user_settings us on us.user_id = s.user_id
     where s.token_hash = ${hash(token)} and s.expires_at > now()
       and s.last_active_at > now() - make_interval(days => coalesce(us.sessions_ttl_days, ${DEFAULT_TTL_DAYS}))`;
  if (!row) return null;
  if (row.stale) await sql`update sessions set last_active_at = now() where id = ${row.id} and last_active_at < now() - interval '1 minute'`;
  return { userId: Number(row.user_id), sessionId: Number(row.id) };
}

export async function userIdFromToken(token: string | null): Promise<number | null> {
  return (await sessionFromToken(token))?.userId ?? null;
}

export function readSessionToken(req: Request): string | null {
  const cookie = req.headers.get('cookie') ?? '';
  const m = /(?:^|;\s*)relay_session=([^;]+)/.exec(cookie);
  if (m) return decodeURIComponent(m[1]);
  if (process.env.DEV_LOGIN === '1') return new URL(req.url).searchParams.get('token');
  return null;
}

export function sessionCookie(token: string): string {
  return `relay_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

/** Выход: удаляем строку текущего сеанса; id — чтобы закрыть сокеты этого сеанса в других вкладках. */
export async function deleteSession(token: string): Promise<number | null> {
  const [row] = await sql`delete from sessions where token_hash = ${hash(token)} returning id`;
  return row ? Number(row.id) : null;
}

export function clearSessionCookie(): string {
  return 'relay_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}
