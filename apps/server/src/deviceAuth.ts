// Сеанс, привязанный к ключу устройства (этап 8 плана шифрования; как DBSC у Chrome).
//   - вызов: GET /session/challenge → nonce (HMAC-подписанный, живёт 2 минуты, хранить не нужно);
//   - POST /session/refresh {nonce, sig, key?}: нужен долгий cookie сеанса; key (SPKI, base64) привязывается при первом
//     обращении, дальше подпись проверяется им; ответ — короткий cookie доступа relay_access (ACCESS_SEC);
//   - обычные запросы: cookie доступа; долгий cookie у привязанного сеанса — 401 access_expired (клиент обновит доступ);
//   - WebSocket привязанного сеанса: кадр challenge при открытии, клиент отвечает prove — до него кадры не выполняются.
// Подпись — ECDSA P-256 SHA-256 над «relay-device|<refresh|ws|bind>|<nonce>».
// Вход (любой: код, пароль, восстановление, регистрация, паскей, QR) присылает ключ с доказательством (deviceProof) —
// сеанс создаётся уже привязанным, с первым доступом: его cookie без ключа бесполезен с первого запроса.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from './db';
import { DomainError } from './domain/errors';

export const ACCESS_SEC = 10 * 60;
const CHALLENGE_MS = 2 * 60_000;
const enc = new TextEncoder();
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

let secret: Promise<Buffer> | null = null;
/** Ключ HMAC для вызовов: один на систему, в server_meta (все процессы сервера проверяют одинаково). */
function challengeSecret(): Promise<Buffer> {
  return secret ??= (async () => {
    await sql`insert into server_meta (k, v) values ('device_challenge_key', ${randomBytes(32).toString('base64')}) on conflict (k) do nothing`;
    const [r] = await sql`select v from server_meta where k = 'device_challenge_key'`;
    return Buffer.from(r.v as string, 'base64');
  })().catch((e) => { secret = null; throw e; });
}

export async function newChallenge(now = Date.now()): Promise<string> {
  const body = `${now}.${randomBytes(16).toString('base64url')}`;
  return `${body}.${createHmac('sha256', await challengeSecret()).update(body).digest('base64url')}`;
}

async function challengeOk(nonce: unknown, now = Date.now()): Promise<boolean> {
  if (typeof nonce !== 'string' || nonce.length > 200) return false;
  const i = nonce.lastIndexOf('.');
  if (i < 0) return false;
  const body = nonce.slice(0, i), mac = Buffer.from(nonce.slice(i + 1), 'base64url');
  const want = createHmac('sha256', await challengeSecret()).update(body).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return false;
  const at = Number(body.split('.')[0]);
  return Number.isFinite(at) && now - at >= -5_000 && now - at <= CHALLENGE_MS;
}

/** Подпись устройства над вызовом. spki — публичный ключ сеанса. */
export async function verifyDevice(spki: Uint8Array, purpose: 'refresh' | 'ws' | 'bind', nonce: string, sig: unknown): Promise<boolean> {
  if (typeof sig !== 'string' || !(await challengeOk(nonce))) return false;
  try {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(sig, 'base64'), enc.encode(`relay-device|${purpose}|${nonce}`));
  } catch { return false; }
}

/** Сеанс привязан? (публичный ключ или null) */
export async function deviceKeyOf(sessionId: number): Promise<Uint8Array | null> {
  const [r] = await sql`select device_key from sessions where id = ${sessionId}`;
  return r?.device_key ? new Uint8Array(r.device_key as Uint8Array) : null;
}

/**
 * Обновить доступ: привязать ключ (первый раз) или проверить подпись; выдать токен доступа. null — отказ
 * (подпись не та, вызов просрочен, ключ не тот, сеанс привязан к другому устройству).
 */
export async function refreshAccess(sessionId: number, body: { nonce?: unknown; sig?: unknown; key?: unknown }): Promise<string | null> {
  const bound = await deviceKeyOf(sessionId);
  let spki = bound;
  if (!bound) {
    if (typeof body.key !== 'string' || body.key.length > 400) return null;
    spki = new Uint8Array(Buffer.from(body.key, 'base64'));
  }
  if (!spki || !(await verifyDevice(spki, 'refresh', body.nonce as string, body.sig))) return null;
  if (!bound) {
    // первая привязка; гонка двух вкладок — выигрывает первая, вторая получит отказ и повторит с тем же ключом
    const [r] = await sql`update sessions set device_key = ${Buffer.from(spki)}, bound_at = now() where id = ${sessionId} and device_key is null returning id`;
    if (!r && !Buffer.from((await deviceKeyOf(sessionId)) ?? []).equals(Buffer.from(spki))) return null;
  }
  return issueAccess(sessionId);
}

/** Новый короткий доступ сеанса (cookie relay_access). */
export async function issueAccess(sessionId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql`delete from session_access where session_id = ${sessionId} and expires_at < now()`;
  await sql`insert into session_access (token_hash, session_id, expires_at) values (${hash(token)}, ${sessionId}, now() + make_interval(secs => ${ACCESS_SEC}))`;
  return token;
}

/**
 * Ключ устройства при входе: {key, nonce, sig} — публичный ключ (SPKI, base64) и подпись «relay-device|bind|<вызов>»
 * им же: клиент действительно держит закрытую часть. Ничего не прислали — null (старый клиент: сеанс без привязки,
 * привяжется при первом обновлении доступа). Прислали негодное — device_invalid, вход не выполняется.
 */
export async function deviceProof(v: unknown): Promise<Uint8Array | null> {
  if (v == null) return null;
  const d = v as { key?: unknown; nonce?: unknown; sig?: unknown };
  if (typeof d.key !== 'string' || d.key.length > 400 || typeof d.nonce !== 'string') throw new DomainError('device_invalid');
  const spki = new Uint8Array(Buffer.from(d.key, 'base64'));
  if (!(await verifyDevice(spki, 'bind', d.nonce, d.sig))) throw new DomainError('device_invalid');
  return spki;
}

/** Тот же ли это ключ (байты SPKI). */
export const sameKey = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean =>
  !!a && !!b && a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

export const accessCookie = (token: string) => `__Host-relay_access=${encodeURIComponent(token)}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ACCESS_SEC}`;
export const clearAccessCookie = () => '__Host-relay_access=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';

export function readAccessToken(req: Request): string | null {
  const c = req.headers.get('cookie') ?? '';
  const m = /(?:^|;\s*)__Host-relay_access=([^;]+)/.exec(c) ?? /(?:^|;\s*)relay_access=([^;]+)/.exec(c);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Сеанс по cookie доступа (не просрочен) — его id; иначе null. */
export async function sessionIdFromAccess(token: string | null): Promise<number | null> {
  if (!token) return null;
  const [r] = await sql`select session_id from session_access where token_hash = ${hash(token)} and expires_at > now()`;
  return r ? Number(r.session_id) : null;
}
