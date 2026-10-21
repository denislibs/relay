import { readAccessToken, sessionIdFromAccess } from './deviceAuth';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from './db';
import { clientIp, parseDevice, type IpSource } from './device';
import { SESSION_DAYS, sweepInactive } from './domain/sessions';

const DEFAULT_TTL_DAYS = 180;
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createUser(name: string): Promise<number> {
  const [row] = await sql`insert into users (name) values (${name.slice(0, 64) || 'user'}) returning id`;
  return row.id as number;
}

/**
 * Новый сеанс — единственный путь входа (любой будущий вход идёт через него): сначала чистка неактивных сеансов
 * этого человека, затем строка с устройством (грубо по User-Agent) и IP входа.
 */
/** deviceKey — публичный ключ устройства (deviceProof при входе): сеанс сразу привязан к нему. */
export async function createSession(userId: number, from?: { req: Request; server: IpSource }, opts: { confirmed?: boolean; deviceKey?: Uint8Array | null } = {}): Promise<string> {
  await sweepInactive(userId).catch((e) => console.error('sessions sweep:', e));
  const device = from ? parseDevice(from.req.headers.get('user-agent')) : null;
  const ip = from ? clientIp(from.req, from.server) : null;
  const token = randomBytes(32).toString('base64url');
  const key = opts.deviceKey ? Buffer.from(opts.deviceKey) : null;
  await sql`insert into sessions (token_hash, user_id, expires_at, device, ip, confirmed_at, device_key, bound_at)
            values (${hashToken(token)}, ${userId}, now() + ${SESSION_DAYS + ' days'}::interval, ${device}, ${ip}, ${opts.confirmed === false ? null : sql`now()`},
                    ${key}, ${key ? sql`now()` : null})`;
  return token;
}

/** refresh — срок продлён: ответу нужен свежий cookie (sessionCookie). */
export interface SessionRef { userId: number; sessionId: number; refresh: boolean }

/**
 * Сеанс по токену. Неактивный дольше срока автозавершения — уже не действует (даже если чистка ещё не дошла).
 * last_active_at трогаем не чаще раза в минуту: один UPDATE только у «несвежей» строки.
 * Срок строки скользит: отстал от «сейчас + SESSION_DAYS» больше чем на день — продлеваем (и выдаём cookie заново).
 */
export async function sessionFromToken(token: string | null): Promise<SessionRef | null> {
  if (!token) return null;
  return sessionWhere(sql`s.token_hash = ${hashToken(token)}`);
}

/** Сеанс по id (cookie доступа уже проверен) — с теми же проверками срока и активности. */
export function sessionFromId(sessionId: number): Promise<SessionRef | null> {
  return sessionWhere(sql`s.id = ${sessionId}`);
}

async function sessionWhere(cond: ReturnType<typeof sql>): Promise<(SessionRef & { bound: boolean }) | null> {
  const [row] = await sql`
    select s.id, s.user_id, s.device_key is not null as bound, s.last_active_at < now() - interval '1 minute' as stale,
           s.expires_at < now() + ${SESSION_DAYS - 1 + ' days'}::interval as slide
      from sessions s left join user_settings us on us.user_id = s.user_id
     where ${cond} and s.expires_at > now()
       and s.last_active_at > now() - make_interval(days => coalesce(us.sessions_ttl_days, ${DEFAULT_TTL_DAYS}))`;
  if (!row) return null;
  if (row.stale || row.slide) {
    await sql`update sessions set last_active_at = now(), expires_at = greatest(expires_at, now() + ${SESSION_DAYS + ' days'}::interval)
               where id = ${row.id} and (last_active_at < now() - interval '1 minute' or expires_at < now() + ${SESSION_DAYS - 1 + ' days'}::interval)`;
  }
  return { userId: Number(row.user_id), sessionId: Number(row.id), refresh: !!row.slide, bound: !!row.bound };
}

/**
 * Кто делает запрос. Cookie доступа (короткий, после подписи ключом устройства) — сеанс. Иначе долгий cookie: у сеанса,
 * не привязанного к устройству, — как раньше; у привязанного — 'refresh' (он один ничего не открывает: пусть клиент
 * обновит доступ подписью). Нет ничего — null.
 */
export async function authenticate(req: Request): Promise<SessionRef | 'refresh' | null> {
  const sid = await sessionIdFromAccess(readAccessToken(req));
  if (sid != null) { const s = await sessionFromId(sid); if (s) return s; }
  const s = await sessionFromToken(readSessionToken(req));
  if (!s) return null;
  return (s as SessionRef & { bound?: boolean }).bound ? 'refresh' : s;
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
  const [row] = await sql`delete from sessions where token_hash = ${hashToken(token)} returning id`;
  return row ? Number(row.id) : null;
}

export function clearSessionCookie(): string {
  return 'relay_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}
