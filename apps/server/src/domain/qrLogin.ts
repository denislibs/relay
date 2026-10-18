import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../db';
import { DomainError } from './errors';

/**
 * Вход по QR: новое устройство показывает токен (живёт 30 с, затем новый), вошедшее устройство его подтверждает.
 * В базе только хэш токена. Подтверждённый токен даёт сеанс один раз — при следующем опросе.
 */
export const QR_TTL_SEC = 30;
const hash = (t: string) => createHash('sha256').update('relay-qr:' + t).digest('hex');
const valid = (t: unknown): t is string => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t);

export async function createQr(device: string | null, ip: string | null): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString('base64url');
  await sql`delete from qr_logins where expires_at < now() - interval '1 hour'`;
  const [r] = await sql`insert into qr_logins (token_hash, device, ip, expires_at) values (${hash(token)}, ${device}, ${ip}, now() + ${QR_TTL_SEC + ' seconds'}::interval) returning expires_at`;
  return { token, expiresAt: new Date(r.expires_at as string).toISOString() };
}

/** Опрос с нового устройства: 'wait' — ещё не подтвердили, 'expired' — нужен новый токен, userId — входим. */
export async function pollQr(token: unknown): Promise<'wait' | 'expired' | { userId: number }> {
  if (!valid(token)) return 'expired';
  // подтверждённый токен годится ещё минуту после срока показа: подтверждение могло прийти на последней секунде
  const [r] = await sql`
    update qr_logins set used_at = now()
     where token_hash = ${hash(token)} and accepted_at is not null and used_at is null and expires_at > now() - interval '60 seconds'
     returning user_id`;
  if (r) return { userId: Number(r.user_id) };
  const [live] = await sql`select 1 from qr_logins where token_hash = ${hash(token)} and accepted_at is null and expires_at > now()`;
  return live ? 'wait' : 'expired';
}

/** Что подтверждаем: устройство и адрес нового входа. */
export async function qrInfo(token: unknown): Promise<{ device: string | null; ip: string | null; createdAt: string }> {
  if (!valid(token)) throw new DomainError('qr_expired');
  const [r] = await sql`select device, ip, created_at from qr_logins where token_hash = ${hash(token)} and accepted_at is null and expires_at > now()`;
  if (!r) throw new DomainError('qr_expired');
  return { device: r.device as string | null, ip: r.ip as string | null, createdAt: new Date(r.created_at as string).toISOString() };
}

/** Подтверждение с вошедшего устройства; только подтверждённым сеансом (свежий вход по коду не может впускать других). */
export async function acceptQr(userId: number, sessionConfirmed: boolean, token: unknown): Promise<{ ok: true }> {
  if (!sessionConfirmed) throw new DomainError('fresh_session');
  if (!valid(token)) throw new DomainError('qr_expired');
  const [r] = await sql`
    update qr_logins set user_id = ${userId}, accepted_at = now()
     where token_hash = ${hash(token)} and accepted_at is null and expires_at > now() returning 1`;
  if (!r) throw new DomainError('qr_expired');
  return { ok: true };
}
