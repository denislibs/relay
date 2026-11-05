import type { Server } from 'bun';
import { clearLegacySessionCookie, createSession, hashToken, sessionCookie, type LoginMethod } from './auth';
import { accessCookie, clearAccessCookie, deviceProof, issueAccess, sameKey } from './deviceAuth';
import { DomainError } from './domain/errors';
import { sql } from './db';
import { clientIp, devAllowed, parseDevice } from './device';
import { devOutbox } from './domain/devOutbox';
import { requestCode, signIn } from './domain/login';
import { deletePasskey, finishLogin, listPasskeys, loginOptions, registerPasskey, registrationOptions } from './domain/passkeys';
import {
  afterFirstFactor, checkPending, finishRecovery, finishSignup, passwordState, pendingChallenge, removePassword, setPassword, startRecovery, startSignup,
  challengeFor, type LoginStep,
} from './domain/password';
import { acceptQr, createQr, pollQr, qrInfo } from './domain/qrLogin';
import { announceLogin, assertConfirmed } from './domain/sessions';

/** Маршруты входа. null — путь не наш. До сеанса — /auth/*, с сеансом — /settings/password|passkeys и подтверждение QR. */

/**
 * Вход без сеанса ставит cookie — защита от login CSRF: только JSON (простая кросс-сайтовая форма
 * так не умеет, а fetch с таким типом требует preflight, который мы не разрешаем) и Origin, если он есть, — наш хост.
 */
export function signInRequestOk(req: Request): boolean {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return false;
  const origin = req.headers.get('origin');
  if (origin == null) return true;
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  // за доверенным прокси (TRUST_PROXY=1, как у clientIp) Host мог быть переписан — исходный в X-Forwarded-Host
  const fwd = process.env.TRUST_PROXY === '1' ? req.headers.get('x-forwarded-host')?.split(',')[0].trim() : undefined;
  return host === (req.headers.get('host') ?? new URL(req.url).host) || (!!fwd && host === fwd);
}

const body = async (req: Request) => ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

/**
 * Шаг входа → ответ: сеанс (cookie) или следующий шаг (пароль, регистрация).
 * device — ключ устройства (deviceProof): сеанс создаётся привязанным к нему и сразу с коротким доступом — долгий
 * cookie без ключа ничего не открывает уже с первого запроса. Без ключа (старый клиент) — как раньше: доступ
 * прежнего сеанса этого браузера сбрасываем, иначе он ещё до 10 минут перебивал бы новый вход.
 */
async function reply(step: LoginStep, req: Request, server: Server, device: Uint8Array | null, method: LoginMethod): Promise<Response> {
  if (!('session' in step)) return Response.json(step);
  const { userId, confirmed } = step.session;
  const fresh = !!step.session.fresh;
  // пароль после кода: способ — «код и пароль»
  const token = await createSession(userId, { req, server }, { confirmed, deviceKey: device, method: fresh ? 'signup' : method, restrict: !fresh && method !== 'qr' });   // QR впустило другое, вошедшее устройство — без ограничения
  // «Новый вход» в служебный чат и sessionsChanged (плашка «Это вы?» для неподтверждённых) — для любого входа, кроме регистрации
  if (!step.session.fresh) await announceLogin(userId, token);
  const h = new Headers();
  h.append('set-cookie', sessionCookie(token));
  h.append('set-cookie', clearLegacySessionCookie());   // прежнее имя (до __Host-) — прочь
  if (device) {
    const [s] = await sql`select id from sessions where token_hash = ${hashToken(token)}`;
    h.append('set-cookie', accessCookie(await issueAccess(Number(s.id))));
  } else h.append('set-cookie', clearAccessCookie());
  return Response.json({ userId }, { headers: h });
}

export async function publicAuthRoute(req: Request, url: URL, server: Server): Promise<Response | null> {
  const p = url.pathname, post = req.method === 'POST';
  if (!p.startsWith('/auth/') && p !== '/dev/codes') return null;
  if (post && !signInRequestOk(req)) return Response.json({ code: 'bad_frame' }, { status: 400 });

  if (req.method === 'GET' && p === '/auth/config') return Response.json({ dev: process.env.DEV_LOGIN === '1' });
  if (req.method === 'GET' && p === '/dev/codes' && devAllowed(req, server)) return Response.json({ items: await devOutbox() });

  if (post && p === '/auth/code') {
    const { login } = await body(req);
    if (typeof login !== 'string' || !login.trim() || login.length > 64) return Response.json({ code: 'bad_frame' }, { status: 400 });
    return Response.json(await requestCode(login, clientIp(req, server)));
  }
  if (post && p === '/auth/signin') {
    const { attemptId, code, device } = await body(req);
    if (typeof attemptId !== 'string' || typeof code !== 'string') return Response.json({ code: 'bad_frame' }, { status: 400 });
    const key = await deviceProof(device);   // до проверки кода: негодный ключ не сжигает попытку
    const r = await signIn(attemptId, code);
    // вход по коду — сеанс неподтверждённый («Это вы?» на других устройствах)
    return reply('signupPhone' in r ? await startSignup(r.signupPhone) : await afterFirstFactor({ userId: r.userId, confirmed: false }), req, server, key, 'code');
  }
  if (post && p === '/auth/signup') {
    const b = await body(req);
    const key = await deviceProof(b.device);
    return reply({ session: { ...(await finishSignup(b.pendingId, b.firstName, b.lastName)), fresh: true } }, req, server, key, 'signup');
  }
  if (post && p === '/auth/password/challenge') return Response.json(await pendingChallenge((await body(req)).pendingId));
  if (post && p === '/auth/password/check') {
    const b = await body(req);
    const key = await deviceProof(b.device);
    return reply({ session: await checkPending(b.pendingId, b) }, req, server, key, 'password');
  }
  if (post && p === '/auth/password/recover') return Response.json(await startRecovery((await body(req)).pendingId));
  if (post && p === '/auth/password/recover/check') {
    const b = await body(req);
    const key = await deviceProof(b.device);
    return reply({ session: await finishRecovery(b.pendingId, b.code) }, req, server, key, 'recovery');
  }

  // QR: ключ нового устройства записан при создании кода — забрать вход опросом может только оно (подпись этим ключом),
  // а не тот, кто подсмотрел или сфотографировал QR
  if (post && p === '/auth/qr') {
    const key = await deviceProof((await body(req)).device);
    return Response.json(await createQr(parseDevice(req.headers.get('user-agent')), clientIp(req, server), key));
  }
  if (post && p === '/auth/qr/poll') {
    const b = await body(req);
    const key = await deviceProof(b.device);
    const r = await pollQr(b.token, key);
    if (typeof r === 'string') return Response.json({ status: r });
    return reply(await afterFirstFactor({ userId: r.userId, confirmed: true }), req, server, key, 'qr');   // впустило вошедшее устройство
  }

  // паскей: ключ устройства записан вместе с вызовом — подпись паскея над этим вызовом впускает именно это устройство
  if (post && p === '/auth/passkey/options') return Response.json(await loginOptions(req, await deviceProof((await body(req)).device)));
  if (post && p === '/auth/passkey/finish') {
    const b = await body(req);
    const key = await deviceProof(b.device);
    const { userId, deviceKey } = await finishLogin(req, b.id, b.response);
    if (deviceKey && !sameKey(deviceKey, key)) throw new DomainError('device_invalid');   // вызов выдан другому устройству
    return reply(await afterFirstFactor({ userId, confirmed: true }), req, server, key, 'passkey');
  }
  return null;
}

export async function privateAuthRoute(req: Request, url: URL, auth: { userId: number; sessionId: number }): Promise<Response | null> {
  const p = url.pathname, { userId } = auth;

  if (req.method === 'GET' && p === '/auth/qr/info') return Response.json(await qrInfo(url.searchParams.get('token')));
  // новый сеанс (первые сутки или не подтверждён) не впускает другие устройства и не трогает защиту аккаунта
  const settled = () => assertConfirmed(sql, auth.sessionId);
  if (req.method === 'POST' && p === '/auth/qr/accept') {
    await settled();
    return Response.json(await acceptQr(userId, true, (await body(req)).token));
  }

  if (p === '/settings/password') {
    if (req.method === 'GET') return Response.json(await passwordState(userId));
    if (req.method === 'PUT' || req.method === 'DELETE') await settled();   // пароль и почта восстановления
    if (req.method === 'PUT') return Response.json(await setPassword(userId, await body(req)));
    if (req.method === 'DELETE') return Response.json(await removePassword(userId, await body(req)));
  }
  // доказательство текущего пароля для смены/снятия: вызов SRP своему аккаунту
  if (req.method === 'POST' && p === '/settings/password/challenge') return Response.json(await challengeFor(userId));

  if (req.method === 'GET' && p === '/settings/passkeys') return Response.json(await listPasskeys(userId));
  if (req.method === 'POST' && p === '/settings/passkeys/options') { await settled(); return Response.json(await registrationOptions(req, userId)); }
  if (req.method === 'POST' && p === '/settings/passkeys') {
    await settled();
    const b = await body(req);
    return Response.json(await registerPasskey(req, userId, b.id, b.response));
  }
  const pk = /^\/settings\/passkeys\/([A-Za-z0-9_-]{1,1024})$/.exec(p);
  if (pk && req.method === 'DELETE') { await settled(); return Response.json(await deletePasskey(userId, pk[1])); }
  return null;
}
