import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { sql } from '../db';
import { parseDevice } from '../device';
import { DomainError } from './errors';

/**
 * Паскеи (WebAuthn): вход без телефона и кода — discoverable credential, аккаунт определяется по ключу.
 * Проверка подписи и формата — @simplewebauthn/server (MIT). Вызов (challenge) одноразовый и живёт 5 минут.
 */
const CHALLENGE_MIN = 5, MAX_PASSKEYS = 10;

/** Где мы: RP ID — хост, origin — схема+хост. Env (за прокси) важнее заголовков; Origin запроса должен совпадать с Host. */
export function relyingParty(req: Request): { rpID: string; origin: string } {
  if (process.env.RP_ORIGIN) {
    const u = new URL(process.env.RP_ORIGIN);
    return { rpID: process.env.RP_ID ?? u.hostname, origin: u.origin };
  }
  const host = req.headers.get('host') ?? new URL(req.url).host;
  const origin = req.headers.get('origin');
  if (origin && new URL(origin).host !== host) throw new DomainError('forbidden');
  const o = origin ?? `${new URL(req.url).protocol}//${host}`;
  return { rpID: new URL(o).hostname, origin: new URL(o).origin };
}

// известные менеджеры паролей по AAGUID — имя паскея понятнее, чем «Браузер»
const AAGUID: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'Связка ключей iCloud',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome на Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
};

async function saveChallenge(challenge: string, userId: number | null, deviceKey: Uint8Array | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await sql`delete from webauthn_challenges where expires_at < now()`;
  await sql`insert into webauthn_challenges (id, challenge, user_id, expires_at, device_key)
            values (${id}, ${challenge}, ${userId}, now() + ${CHALLENGE_MIN + ' minutes'}::interval, ${deviceKey ? Buffer.from(deviceKey) : null})`;
  return id;
}

async function takeChallenge(id: unknown, userId: number | null): Promise<{ challenge: string; deviceKey: Uint8Array | null }> {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new DomainError('passkey_invalid');
  const [c] = userId == null
    ? await sql`delete from webauthn_challenges where id = ${id} and user_id is null and expires_at > now() returning challenge, device_key`
    : await sql`delete from webauthn_challenges where id = ${id} and user_id = ${userId} and expires_at > now() returning challenge, device_key`;
  if (!c) throw new DomainError('passkey_invalid');
  return { challenge: c.challenge as string, deviceKey: c.device_key ? new Uint8Array(c.device_key as Uint8Array) : null };
}

/* ---------- вход ---------- */

/** deviceKey — ключ устройства, которое входит: хранится с вызовом, finishLogin вернёт его для сверки. */
export async function loginOptions(req: Request, deviceKey: Uint8Array | null = null) {
  const { rpID } = relyingParty(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred', allowCredentials: [] });
  return { id: await saveChallenge(options.challenge, null, deviceKey), options };
}

export async function finishLogin(req: Request, id: unknown, response: unknown): Promise<{ userId: number; deviceKey: Uint8Array | null }> {
  const { challenge, deviceKey } = await takeChallenge(id, null);
  const r = response as { id?: unknown };
  if (!r || typeof r.id !== 'string' || r.id.length > 1024) throw new DomainError('passkey_invalid');
  const [pk] = await sql`select * from passkeys where id = ${r.id}`;
  if (!pk) throw new DomainError('passkey_not_found');
  const { rpID, origin } = relyingParty(req);
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response: response as never, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: pk.id as string, publicKey: new Uint8Array(pk.public_key as Buffer), counter: Number(pk.counter), transports: pk.transports as never },
      requireUserVerification: false,
    });
  } catch { throw new DomainError('passkey_invalid'); }
  if (!verified.verified) throw new DomainError('passkey_invalid');
  await sql`update passkeys set counter = ${verified.authenticationInfo.newCounter}, last_used_at = now() where id = ${pk.id}`;
  return { userId: Number(pk.user_id), deviceKey };
}

/* ---------- настройки ---------- */

export async function listPasskeys(userId: number) {
  const rows = await sql`select id, name, created_at, last_used_at from passkeys where user_id = ${userId} order by created_at`;
  return { passkeys: rows.map((r) => ({ id: r.id as string, name: r.name as string, createdAt: new Date(r.created_at as string).toISOString(), lastUsedAt: r.last_used_at ? new Date(r.last_used_at as string).toISOString() : null })), max: MAX_PASSKEYS };
}

export async function registrationOptions(req: Request, userId: number) {
  const [u] = await sql`select name, username, phone from users where id = ${userId}`;
  const existing = await sql`select id, transports from passkeys where user_id = ${userId}`;
  if (existing.length >= MAX_PASSKEYS) throw new DomainError('too_long');
  const { rpID } = relyingParty(req);
  const options = await generateRegistrationOptions({
    rpName: 'Relay', rpID,
    userName: (u.phone as string) ?? (u.username ? '@' + u.username : String(u.name)),
    userDisplayName: String(u.name),
    userID: new TextEncoder().encode('relay:' + userId),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id as string, transports: p.transports as never })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  return { id: await saveChallenge(options.challenge, userId), options };
}

export async function registerPasskey(req: Request, userId: number, id: unknown, response: unknown) {
  const { challenge } = await takeChallenge(id, userId);
  const { rpID, origin } = relyingParty(req);
  let verified;
  try {
    verified = await verifyRegistrationResponse({ response: response as never, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
  } catch { throw new DomainError('passkey_invalid'); }
  if (!verified.verified) throw new DomainError('passkey_invalid');
  const { credential, aaguid } = verified.registrationInfo;
  const name = AAGUID[aaguid] ?? parseDevice(req.headers.get('user-agent'));
  await sql`insert into passkeys (id, user_id, public_key, counter, transports, name)
            values (${credential.id}, ${userId}, ${Buffer.from(credential.publicKey)}, ${credential.counter}, ${(credential.transports ?? []) as string[]}, ${name})
            on conflict (id) do nothing`;
  return listPasskeys(userId);
}

export async function deletePasskey(userId: number, id: string) {
  await sql`delete from passkeys where id = ${id} and user_id = ${userId}`;
  return listPasskeys(userId);
}
