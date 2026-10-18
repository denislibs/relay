import { createHash, randomInt } from 'node:crypto';
import { serverChallenge, serverVerify } from '@relay/protocol/src/srp';
import { sql } from '../db';
import { enqueue } from '../jobs/queue';
import { DomainError } from './errors';

/**
 * Облачный пароль (SRP-6a) и незавершённый вход.
 * Первый фактор (код, QR, паскей) пройден, а у аккаунта есть пароль → login_pending; сеанс выдаётся только после
 * проверки доказательства. Регистрация нового номера — тоже login_pending (kind 'signup').
 */

const PENDING_MIN = 10, CHALLENGE_SEC = 60, MAX_PENDING_TRIES = 5, MAX_WRONG_PER_HOUR = 10;
const RECOVERY_MIN = 10, RECOVERY_TRIES = 5;
const MAX_HINT = 64, MAX_EMAIL = 254;
const hashCode = (code: string) => createHash('sha256').update('relay-recovery:' + code).digest('hex');

/** fresh — аккаунт только что создан: сообщать о «новом входе» некому. */
export type FirstFactor = { userId: number; confirmed: boolean; fresh?: boolean };
export type LoginStep =
  | { session: FirstFactor }
  | { passwordNeeded: true; pendingId: string; hint: string }
  | { signupRequired: true; pendingId: string };

/** Итог первого фактора: сразу сеанс или шаг пароля. */
export async function afterFirstFactor(f: FirstFactor): Promise<LoginStep> {
  const [pw] = await sql`select hint from user_passwords where user_id = ${f.userId}`;
  if (!pw) return { session: f };
  const id = crypto.randomUUID();
  await sql`delete from login_pending where expires_at < now() - interval '1 day'`;
  await sql`insert into login_pending (id, kind, user_id, confirmed, expires_at)
            values (${id}, 'password', ${f.userId}, ${f.confirmed}, now() + ${PENDING_MIN + ' minutes'}::interval)`;
  return { passwordNeeded: true, pendingId: id, hint: pw.hint as string };
}

export async function startSignup(phone: string): Promise<LoginStep> {
  const id = crypto.randomUUID();
  await sql`insert into login_pending (id, kind, phone, confirmed, expires_at)
            values (${id}, 'signup', ${phone}, true, now() + ${PENDING_MIN + ' minutes'}::interval)`;
  return { signupRequired: true, pendingId: id };
}

async function livePending(id: unknown, kind: 'password' | 'signup') {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new DomainError('code_expired');
  const [p] = await sql`select * from login_pending where id = ${id} and kind = ${kind} and dead_at is null and expires_at > now()`;
  if (!p) throw new DomainError('code_expired');
  return p;
}

/** Регистрация: имя обязательно (до 70), фамилия до 64; номер занят за это время — code_expired. */
export async function finishSignup(pendingId: unknown, first: unknown, last: unknown): Promise<FirstFactor> {
  const p = await livePending(pendingId, 'signup');
  const firstName = typeof first === 'string' ? first.trim().slice(0, 70) : '';
  const lastName = typeof last === 'string' ? last.trim().slice(0, 64) : '';
  if (!firstName) throw new DomainError('name_invalid');
  return sql.begin(async (tx) => {
    const [taken] = await tx`select 1 from users where phone = ${p.phone}`;
    if (taken) throw new DomainError('code_expired');
    const name = lastName ? `${firstName} ${lastName}` : firstName;
    const [u] = await tx`insert into users (name, first_name, last_name, phone) values (${name}, ${firstName}, ${lastName || null}, ${p.phone}) returning id`;
    await tx`update login_pending set dead_at = now() where id = ${p.id}`;
    return { userId: Number(u.id), confirmed: true };
  });
}

/** Одноразовый SRP-вызов для пользователя (вход вторым шагом или подтверждение смены пароля). */
export async function challengeFor(userId: number): Promise<{ srpId: string; salt: string; B: string; hint: string }> {
  const [pw] = await sql`select salt, verifier, hint from user_passwords where user_id = ${userId}`;
  if (!pw) throw new DomainError('password_missing');
  const { b, B } = await serverChallenge(pw.verifier as string);
  const srpId = crypto.randomUUID();
  await sql`delete from srp_challenges where expires_at < now()`;
  await sql`insert into srp_challenges (id, user_id, b, big_b, expires_at) values (${srpId}, ${userId}, ${b}, ${B}, now() + ${CHALLENGE_SEC + ' seconds'}::interval)`;
  return { srpId, salt: pw.salt as string, B, hint: pw.hint as string };
}

export type SrpProof = { srpId: string; A: string; M1: string };
const isProof = (p: unknown): p is SrpProof => !!p && typeof p === 'object'
  && typeof (p as SrpProof).srpId === 'string' && typeof (p as SrpProof).A === 'string' && typeof (p as SrpProof).M1 === 'string'
  && (p as SrpProof).A.length <= 600 && (p as SrpProof).M1.length <= 100;

/** Проверка доказательства; вызов сгорает в любом случае (повтор того же srpId не пройдёт). */
async function verifyProof(userId: number, proof: unknown): Promise<boolean> {
  if (!isProof(proof) || !/^[0-9a-f-]{36}$/.test(proof.srpId)) return false;
  const [c] = await sql`delete from srp_challenges where id = ${proof.srpId} and user_id = ${userId} and expires_at > now() returning b, big_b`;
  const [pw] = await sql`select verifier from user_passwords where user_id = ${userId}`;
  if (!c || !pw) return false;
  return serverVerify(pw.verifier as string, c.b as string, c.big_b as string, proof.A, proof.M1);
}

async function wrongLastHour(userId: number): Promise<number> {
  const [{ n }] = await sql`select coalesce(sum(tries), 0)::int as n from login_pending where user_id = ${userId} and kind = 'password' and created_at > now() - interval '1 hour'`;
  return n;
}

export async function pendingChallenge(pendingId: unknown) {
  const p = await livePending(pendingId, 'password');
  return challengeFor(Number(p.user_id));
}

/** Второй шаг входа: неверно — password_invalid; 5 ошибок гасят вход; 10 за час на аккаунт — flood. */
export async function checkPending(pendingId: unknown, proof: unknown): Promise<FirstFactor> {
  const p = await livePending(pendingId, 'password');
  const userId = Number(p.user_id);
  if (await wrongLastHour(userId) >= MAX_WRONG_PER_HOUR) throw new DomainError('flood');
  if (!(await verifyProof(userId, proof))) {
    await sql`update login_pending set tries = tries + 1, dead_at = case when tries + 1 >= ${MAX_PENDING_TRIES} then now() end where id = ${p.id}`;
    throw new DomainError('password_invalid');
  }
  await sql`update login_pending set dead_at = now() where id = ${p.id}`;
  return { userId, confirmed: p.confirmed as boolean };
}

const maskEmail = (e: string) => e.replace(/^(.)(.*)(@.*)$/, (_, a, mid, d) => a + '•'.repeat(Math.min(6, Math.max(2, mid.length))) + d);

/** «Забыли пароль?» — код на почту восстановления. Почты нет — recovery_unavailable. */
export async function startRecovery(pendingId: unknown): Promise<{ emailPattern: string }> {
  const p = await livePending(pendingId, 'password');
  const [pw] = await sql`select email from user_passwords where user_id = ${p.user_id}`;
  if (!pw?.email) throw new DomainError('recovery_unavailable');
  const code = String(randomInt(0, 1e6)).padStart(6, '0');
  await sql.begin(async (tx) => {
    await tx`insert into password_recovery (pending_id, code_hash, expires_at) values (${p.id}, ${hashCode(code)}, now() + ${RECOVERY_MIN + ' minutes'}::interval)
              on conflict (pending_id) do update set code_hash = excluded.code_hash, tries = 0, expires_at = excluded.expires_at`;
    // код — под secret: в jobs_dead не копируется; письмо, не ушедшее за срок жизни кода, бесполезно
    await enqueue(tx, 'mail.recovery', { to: pw.email as string, secret: { code } }, { maxAttempts: 5 });
  });
  return { emailPattern: maskEmail(pw.email as string) };
}

/** Верный код восстановления снимает облачный пароль и завершает вход (сеанс неподтверждённый, как после кода). */
export async function finishRecovery(pendingId: unknown, code: unknown): Promise<FirstFactor> {
  const p = await livePending(pendingId, 'password');
  const [r] = await sql`select code_hash, tries from password_recovery where pending_id = ${p.id} and expires_at > now()`;
  if (!r || r.tries >= RECOVERY_TRIES) throw new DomainError('code_expired');
  if (typeof code !== 'string' || hashCode(code.trim()) !== r.code_hash) {
    await sql`update password_recovery set tries = tries + 1 where pending_id = ${p.id}`;
    throw new DomainError('code_invalid');
  }
  await sql.begin(async (tx) => {
    await tx`delete from user_passwords where user_id = ${p.user_id}`;
    await tx`update login_pending set dead_at = now() where id = ${p.id}`;
  });
  return { userId: Number(p.user_id), confirmed: false };
}

/* ---------- настройки ---------- */

export async function passwordState(userId: number): Promise<{ enabled: boolean; hint: string; email: string | null }> {
  const [pw] = await sql`select hint, email from user_passwords where user_id = ${userId}`;
  return { enabled: !!pw, hint: (pw?.hint as string) ?? '', email: pw?.email ? maskEmail(pw.email as string) : null };
}

type NewPassword = { salt: string; verifier: string; hint?: string; email?: string | null };
const isNew = (x: unknown): x is NewPassword => !!x && typeof x === 'object'
  && typeof (x as NewPassword).salt === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test((x as NewPassword).salt)
  && typeof (x as NewPassword).verifier === 'string' && /^[0-9a-f]{1,512}$/.test((x as NewPassword).verifier);

/** Установка или смена. Пароль уже есть — нужно доказательство текущего (proof). */
export async function setPassword(userId: number, body: unknown): Promise<{ enabled: true }> {
  const b = (body ?? {}) as { next?: unknown; proof?: unknown };
  if (!isNew(b.next)) throw new DomainError('bad_frame');
  const hint = typeof b.next.hint === 'string' ? b.next.hint.trim().slice(0, MAX_HINT) : '';
  const email = typeof b.next.email === 'string' && b.next.email.trim() ? b.next.email.trim().slice(0, MAX_EMAIL) : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DomainError('email_invalid');
  const [has] = await sql`select 1 from user_passwords where user_id = ${userId}`;
  if (has && !(await verifyProof(userId, b.proof))) throw new DomainError('password_invalid');
  await sql`insert into user_passwords (user_id, salt, verifier, hint, email) values (${userId}, ${b.next.salt}, ${b.next.verifier}, ${hint}, ${email})
            on conflict (user_id) do update set salt = excluded.salt, verifier = excluded.verifier, hint = excluded.hint, email = excluded.email, updated_at = now()`;
  return { enabled: true };
}

export async function removePassword(userId: number, proof: unknown): Promise<{ enabled: false }> {
  if (!(await verifyProof(userId, proof))) throw new DomainError('password_invalid');
  await sql`delete from user_passwords where user_id = ${userId}`;
  return { enabled: false };
}
