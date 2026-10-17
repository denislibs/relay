import { createHash, randomBytes } from 'node:crypto';
import { sql } from './db';

const SESSION_DAYS = 30;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createUser(name: string): Promise<number> {
  const [row] = await sql`insert into users (name) values (${name.slice(0, 64) || 'user'}) returning id`;
  return row.id as number;
}

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (token_hash, user_id, expires_at) values (${hash(token)}, ${userId}, now() + ${SESSION_DAYS + ' days'}::interval)`;
  return token;
}

export async function userIdFromToken(token: string | null): Promise<number | null> {
  if (!token) return null;
  const [row] = await sql`select user_id from sessions where token_hash = ${hash(token)} and expires_at > now()`;
  return row ? (row.user_id as number) : null;
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

/** Выход: удаляем строку текущего сеанса. */
export async function deleteSession(token: string): Promise<void> {
  await sql`delete from sessions where token_hash = ${hash(token)}`;
}

export function clearSessionCookie(): string {
  return 'relay_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}
