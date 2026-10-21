import { afterAll, beforeEach, expect, test } from 'bun:test';
import { clientProof, makeVerifier } from '@relay/protocol/src/srp';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { clearOutbox, devOutbox } from '../src/domain/devOutbox';
import '../src/jobs/kinds';
import { drainJobs } from '../src/jobs/worker';
import { opened, resetDb } from './helpers';

process.env.DEV_LOGIN = '1';
const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(async () => { await resetDb(); await clearOutbox(); });

type Res = { status: number; json: Record<string, any>; cookie: string | null };
async function call(path: string, data?: unknown, cookie?: string | null, method = 'POST'): Promise<Res> {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const set = res.headers.get('set-cookie');
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: set ? set.split(';')[0] : null };
}

/** Новый номер в dev: код → регистрация → сеанс. */
async function signUp(phone: string, firstName = 'Анна') {
  const code = await call('/auth/code', { login: phone });
  const step = await call('/auth/signin', { attemptId: code.json.attemptId, code: code.json.devCode });
  expect(step.json).toMatchObject({ signupRequired: true });
  const done = await call('/auth/signup', { pendingId: step.json.pendingId, firstName, lastName: 'Иванова' });
  expect(done.status).toBe(200);
  return { userId: done.json.userId as number, cookie: done.cookie! };
}

test('a new phone signs up after the code; the number is then taken and the code signs in', async () => {
  const { userId, cookie } = await signUp('+79990000001');
  expect((await call('/me', undefined, cookie, 'GET')).json).toMatchObject({ firstName: 'Анна', lastName: 'Иванова', phone: '+79990000001' });
  // тот же номер — уже вход (сеанс у аккаунта есть, код уходит в служебный чат)
  const code = await call('/auth/code', { login: '+79990000001' });
  const again = await call('/auth/signin', { attemptId: code.json.attemptId, code: code.json.devCode });
  expect(again.json).toEqual({ userId });
  expect(again.cookie).toContain('relay_session=');
  // без имени — нельзя; без кода — нельзя
  const c2 = await call('/auth/code', { login: '+79990000002' });
  const s2 = await call('/auth/signin', { attemptId: c2.json.attemptId, code: c2.json.devCode });
  expect((await call('/auth/signup', { pendingId: s2.json.pendingId, firstName: '  ' })).json.code).toBe('name_invalid');
  expect((await call('/auth/signup', { pendingId: crypto.randomUUID(), firstName: 'X' })).json.code).toBe('code_expired');
});

test('without dev delivery an unknown phone cannot sign up', async () => {
  process.env.DEV_LOGIN = '0';
  try {
    const code = await call('/auth/code', { login: '+79990000003' });
    expect(code.json.devCode).toBeUndefined();
    expect((await call('/auth/signin', { attemptId: code.json.attemptId, code: '12345' })).json.code).toBe('code_invalid');
  } finally { process.env.DEV_LOGIN = '1'; }
});

test('cloud password: set with SRP, sign-in needs the proof, wrong password and replayed challenge fail', async () => {
  const { userId, cookie } = await signUp('+79990000010');
  const next = { ...(await makeVerifier('correct horse')), hint: 'лошадь', email: 'anna@example.com' };
  expect((await call('/settings/password', { next }, cookie, 'PUT')).json).toEqual({ enabled: true });
  expect((await call('/settings/password', undefined, cookie, 'GET')).json).toMatchObject({ enabled: true, hint: 'лошадь', email: 'a•••@example.com' });
  // смена без доказательства текущего — нельзя
  expect((await call('/settings/password', { next: await makeVerifier('x') }, cookie, 'PUT')).json.code).toBe('password_invalid');

  const code = await call('/auth/code', { login: '+79990000010' });
  const step = await call('/auth/signin', { attemptId: code.json.attemptId, code: code.json.devCode });
  expect(step.json).toMatchObject({ passwordNeeded: true, hint: 'лошадь' });
  expect(step.cookie).toBeNull();

  const ch1 = (await call('/auth/password/challenge', { pendingId: step.json.pendingId })).json;
  const bad = await clientProof('wrong', ch1.salt, ch1.B);
  expect((await call('/auth/password/check', { pendingId: step.json.pendingId, srpId: ch1.srpId, ...bad })).json.code).toBe('password_invalid');

  const ch2 = (await call('/auth/password/challenge', { pendingId: step.json.pendingId })).json;
  const good = await clientProof('correct horse', ch2.salt, ch2.B);
  const ok = await call('/auth/password/check', { pendingId: step.json.pendingId, srpId: ch2.srpId, ...good });
  expect(ok.json).toEqual({ userId });
  expect(ok.cookie).toContain('relay_session=');
  // тот же вызов второй раз не годится
  expect((await call('/auth/password/check', { pendingId: step.json.pendingId, srpId: ch2.srpId, ...good })).json.code).toBe('code_expired');

  // снятие пароля — с доказательством
  const ch3 = (await call('/settings/password/challenge', {}, cookie)).json;
  expect((await call('/settings/password', { srpId: ch3.srpId, ...(await clientProof('correct horse', ch3.salt, ch3.B)) }, cookie, 'DELETE')).json).toEqual({ enabled: false });
});

test('forgot password: code to the recovery email removes the password and signs in', async () => {
  const { userId, cookie } = await signUp('+79990000020');
  await call('/settings/password', { next: { ...(await makeVerifier('pw')), email: 'boris@example.com' } }, cookie, 'PUT');
  const code = await call('/auth/code', { login: '+79990000020' });
  const step = await call('/auth/signin', { attemptId: code.json.attemptId, code: code.json.devCode });
  expect((await call('/auth/password/recover', { pendingId: step.json.pendingId })).json).toEqual({ emailPattern: 'b••••@example.com' });
  expect(await devOutbox()).toEqual([]);              // в запросе письмо не отправляется — только задача
  await drainJobs();
  const mail = (await devOutbox())[0];
  expect(mail).toMatchObject({ to: 'boris@example.com', kind: 'recovery' });
  expect((await call('/auth/password/recover/check', { pendingId: step.json.pendingId, code: '000000' })).json.code).toBe('code_invalid');
  const ok = await call('/auth/password/recover/check', { pendingId: step.json.pendingId, code: mail.code });
  expect(ok.json).toEqual({ userId });
  expect((await sql`select count(*)::int as n from user_passwords`)[0].n).toBe(0);
  // код не остаётся в очереди: выполненная задача удалена, а в jobs_dead секрет не копируется
  expect((await sql`select count(*)::int as n from jobs where kind = 'mail.recovery'`)[0].n).toBe(0);
});

test('QR: waits, a confirmed session accepts, the new device gets a session once; fresh sessions cannot accept', async () => {
  const { userId, cookie } = await signUp('+79990000030');   // регистрация — сеанс подтверждён
  const qr = (await call('/auth/qr')).json;
  expect(qr.token).toHaveLength(43);
  expect((await call('/auth/qr/poll', { token: qr.token })).json).toEqual({ status: 'wait' });
  expect((await call(`/auth/qr/info?token=${qr.token}`, undefined, cookie, 'GET')).json).toMatchObject({ device: expect.any(String) });

  // сеанс, открытый кодом (неподтверждённый), впускать не может
  const c = await call('/auth/code', { login: '+79990000030' });
  const fresh = await call('/auth/signin', { attemptId: c.json.attemptId, code: c.json.devCode });
  expect((await call('/auth/qr/accept', { token: qr.token }, fresh.cookie)).json.code).toBe('fresh_session');

  expect((await call('/auth/qr/accept', { token: qr.token }, cookie)).json).toEqual({ ok: true });
  const done = await call('/auth/qr/poll', { token: qr.token });
  expect(done.json).toEqual({ userId });
  expect(done.cookie).toContain('relay_session=');
  expect((await call('/auth/qr/poll', { token: qr.token })).json).toEqual({ status: 'expired' });   // один раз
  expect((await call('/auth/qr/accept', { token: qr.token }, cookie)).json.code).toBe('qr_expired');
});

/* ---------- виртуальный аутентификатор WebAuthn (ES256, attestation none) ---------- */

function cbor(v: unknown): Uint8Array {
  const out: number[] = [];
  const head = (major: number, n: number) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 256) out.push((major << 5) | 24, n);
    else out.push((major << 5) | 25, n >> 8, n & 255);
  };
  const enc = (x: unknown): void => {
    if (typeof x === 'number') { if (x >= 0) head(0, x); else head(1, -1 - x); }
    else if (typeof x === 'string') { const b = new TextEncoder().encode(x); head(3, b.length); out.push(...b); }
    else if (x instanceof Uint8Array) { head(2, x.length); out.push(...x); }
    else if (x instanceof Map) { head(5, x.size); for (const [k, val] of x) { enc(k); enc(val); } }
    else throw new Error('cbor: ' + typeof x);
  };
  enc(v);
  return new Uint8Array(out);
}
const b64u = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let x = b.slice(i); if (x[0] & 0x80) x = cat(new Uint8Array([0]), x); return cat(new Uint8Array([2, x.length]), x); };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(new Uint8Array([0x30, body.length]), body);
}

async function authenticator() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const rpHash = await sha(new TextEncoder().encode('localhost'));
  let counter = 0;
  const authData = (flags: number, attested?: Uint8Array) => {
    const c = new Uint8Array(4); new DataView(c.buffer).setUint32(0, counter);
    return cat(rpHash, new Uint8Array([flags]), c, attested ?? new Uint8Array());
  };
  return {
    id: b64u(credId),
    async create(challenge: string) {
      const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33)]]));
      const attested = cat(new Uint8Array(16), new Uint8Array([0, credId.length]), credId, cose);
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge, origin: base }));
      const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(0x45, attested)]]));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] } };
    },
    async get(challenge: string) {
      counter++;
      const ad = authData(0x05);
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: base }));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, cat(ad, await sha(clientDataJSON))));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(ad), signature: b64u(der(sig)) } };
    },
  };
}

test('passkeys: register in settings, sign in without a phone, delete; unknown key is rejected', async () => {
  const { userId, cookie } = await signUp('+79990000040');
  const auth = await authenticator();
  const reg = (await call('/settings/passkeys/options', {}, cookie)).json;
  expect(reg.options.authenticatorSelection.residentKey).toBe('required');
  const list = await call('/settings/passkeys', { id: reg.id, response: await auth.create(reg.options.challenge) }, cookie);
  expect(list.json.passkeys).toHaveLength(1);

  const opt = (await call('/auth/passkey/options')).json;
  const done = await call('/auth/passkey/finish', { id: opt.id, response: await auth.get(opt.options.challenge) });
  expect(done.json).toEqual({ userId });
  expect(done.cookie).toContain('relay_session=');
  // challenge одноразовый
  expect((await call('/auth/passkey/finish', { id: opt.id, response: await auth.get(opt.options.challenge) })).json.code).toBe('passkey_invalid');

  const stranger = await authenticator();
  const opt2 = (await call('/auth/passkey/options')).json;
  expect((await call('/auth/passkey/finish', { id: opt2.id, response: await stranger.get(opt2.options.challenge) })).json.code).toBe('passkey_not_found');

  // с облачным паролем после паскея — шаг пароля
  await call('/settings/password', { next: await makeVerifier('pw') }, cookie, 'PUT');
  const opt3 = (await call('/auth/passkey/options')).json;
  expect((await call('/auth/passkey/finish', { id: opt3.id, response: await auth.get(opt3.options.challenge) })).json).toMatchObject({ passwordNeeded: true });

  expect((await call(`/settings/passkeys/${auth.id}`, undefined, cookie, 'DELETE')).json.passkeys).toHaveLength(0);
});

test('login CSRF: every POST /auth/* wants JSON from our own origin', async () => {
  for (const path of ['/auth/qr', '/auth/passkey/options', '/auth/password/challenge', '/auth/signup']) {
    const foreign = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    expect(foreign.status).toBe(400);
    const form = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: 'a=1' });
    expect(form.status).toBe(400);
  }
});

test('a login finished with the cloud password posts «new login» to the service chat; sign-up does not', async () => {
  const { userId, cookie } = await signUp('+79990000050');
  const notices = async () => (await sql`select count(*)::int as n from messages m join service_chats s on s.chat_id = m.chat_id where s.user_id = ${userId} and m.service_type = 'new_login'`)[0].n as number;
  expect(await notices()).toBe(0);
  await call('/settings/password', { next: await makeVerifier('pw') }, cookie, 'PUT');
  const code = await call('/auth/code', { login: '+79990000050' });
  const step = await call('/auth/signin', { attemptId: code.json.attemptId, code: code.json.devCode });
  const ch = (await call('/auth/password/challenge', { pendingId: step.json.pendingId })).json;
  await call('/auth/password/check', { pendingId: step.json.pendingId, srpId: ch.srpId, ...(await clientProof('pw', ch.salt, ch.B)) });
  expect(await notices()).toBe(1);
  const [s] = await sql`select confirmed_at from sessions where user_id = ${userId} order by id desc limit 1`;
  expect(s.confirmed_at).toBeNull();   // вход по коду (+ пароль) — «Это вы?» на других устройствах
});

test('«new login» only when a confirmed device can answer it: after logging out everywhere — no question', async () => {
  const { userId, cookie } = await signUp('+79990000051');
  const notices = async () => (await sql`select count(*)::int as n from messages m join service_chats s on s.chat_id = m.chat_id where s.user_id = ${userId} and m.service_type = 'new_login'`)[0].n as number;
  // единственный сеанс вышел — следующий вход некому подтверждать
  await call('/logout', {}, cookie);
  const code = await call('/auth/code', { login: '+79990000051' });
  await call('/auth/signin', { attemptId: code.json.attemptId, code: code.json.devCode });
  expect(await notices()).toBe(0);
  // ещё один вход: есть другой сеанс, но он сам не подтверждён — тоже без вопроса
  const again = await call('/auth/code', { login: '+79990000051' });
  await call('/auth/signin', { attemptId: again.json.attemptId, code: again.json.devCode });
  expect(await notices()).toBe(0);
});

test('the login code is hidden under a spoiler and stays copyable (code entity on the same range)', async () => {
  const { codeMessage } = await import('../src/domain/login');
  const m = codeMessage('12345');
  const at = m.body.indexOf('12345');
  expect(m.entities).toEqual([{ type: 'code', offset: at, length: 5 }, { type: 'spoiler', offset: at, length: 5 }]);
});

/* ---------- ключ устройства с самого входа (deviceAuth.ts: deviceProof) ---------- */

async function deviceOf() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const key = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  const sign = async (purpose: string, nonce: string) => Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`relay-device|${purpose}|${nonce}`))).toString('base64');
  return { key, sign, proof: async () => { const { nonce } = (await (await fetch(base + '/session/challenge')).json()) as { nonce: string }; return { key, nonce, sig: await sign('bind', nonce) }; } };
}
const cookiesOf = async (path: string, data: unknown) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(data) });
  const set = res.headers.getSetCookie?.() ?? [];
  const pick = (n: string) => set.find((c) => c.startsWith(n + '='))?.split(';')[0] ?? null;
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any>, session: pick('relay_session'), access: pick('relay_access') };
};

test('sign-in with a device key: the session is bound from the start — the long cookie alone opens nothing', async () => {
  const { userId } = await signUp('+79990000060');
  const dev = await deviceOf();
  const code = await call('/auth/code', { login: '+79990000060' });
  const r = await cookiesOf('/auth/signin', { attemptId: code.json.attemptId, code: code.json.devCode, device: await dev.proof() });
  expect(r.json).toEqual({ userId });
  expect(r.access).toMatch(/^relay_access=.+/);
  const [s] = await sql`select device_key is not null as bound from sessions where user_id = ${userId} order by id desc limit 1`;
  expect(s.bound).toBe(true);
  expect((await call('/me', undefined, r.session, 'GET')).status).toBe(401);   // украденный долгий cookie — ничего
  expect((await call('/me', undefined, `${r.session}; ${r.access}`, 'GET')).status).toBe(200);
});

test('a bad device proof refuses the sign-in before the code is checked — the code stays usable', async () => {
  await signUp('+79990000061');
  const dev = await deviceOf();
  const code = await call('/auth/code', { login: '+79990000061' });
  const forged = { ...(await dev.proof()), sig: await dev.sign('refresh', 'x') };
  const bad = await cookiesOf('/auth/signin', { attemptId: code.json.attemptId, code: code.json.devCode, device: forged });
  expect(bad.status).toBe(400);
  expect(bad.json.code).toBe('device_invalid');
  const ok = await cookiesOf('/auth/signin', { attemptId: code.json.attemptId, code: code.json.devCode, device: await dev.proof() });
  expect(ok.status).toBe(200);
});

test('QR: only the device that created the code can take the login — not whoever saw the QR', async () => {
  const { userId, cookie } = await signUp('+79990000062');
  const owner = await deviceOf(), peeker = await deviceOf();
  const qr = await call('/auth/qr', { device: await owner.proof() });
  expect((await call('/auth/qr/accept', { token: qr.json.token }, cookie)).json).toEqual({ ok: true });
  const stolen = await cookiesOf('/auth/qr/poll', { token: qr.json.token, device: await peeker.proof() });
  expect(stolen.session).toBeNull();
  expect(stolen.json.status).toBe('expired');
  const mine = await cookiesOf('/auth/qr/poll', { token: qr.json.token, device: await owner.proof() });
  expect(mine.json).toEqual({ userId });
  expect(mine.access).toMatch(/^relay_access=.+/);
});

test('passkey: the challenge carries the device key — finishing it with another key is refused', async () => {
  const { userId, cookie } = await signUp('+79990000063');
  const auth = await authenticator();
  const reg = (await call('/settings/passkeys/options', {}, cookie)).json;
  await call('/settings/passkeys', { id: reg.id, response: await auth.create(reg.options.challenge) }, cookie);
  const mine = await deviceOf(), other = await deviceOf();
  const opt = (await call('/auth/passkey/options', { device: await mine.proof() })).json;
  const swapped = await cookiesOf('/auth/passkey/finish', { id: opt.id, response: await auth.get(opt.options.challenge), device: await other.proof() });
  expect(swapped.json.code).toBe('device_invalid');
  const opt2 = (await call('/auth/passkey/options', { device: await mine.proof() })).json;
  const ok = await cookiesOf('/auth/passkey/finish', { id: opt2.id, response: await auth.get(opt2.options.challenge), device: await mine.proof() });
  expect(ok.json).toEqual({ userId });
  expect(ok.access).toMatch(/^relay_access=.+/);
});

/* ---------- новый сеанс первые сутки; коды скрываются; место входа ---------- */

test('a new login is limited for a day: no password, passkeys, ending or letting in others; «it is me» lifts it; the first session is free', async () => {
  const { userId, cookie: first } = await signUp('+79990000070');
  // первый сеанс аккаунта — без ограничений
  expect((await call('/settings/passkeys/options', {}, first)).status).toBe(200);
  // вход паскеем при живом первом сеансе — подтверждён, но первые сутки ограничен
  const auth = await authenticator();
  const reg = (await call('/settings/passkeys/options', {}, first)).json;
  await call('/settings/passkeys', { id: reg.id, response: await auth.create(reg.options.challenge) }, first);
  const opt = (await call('/auth/passkey/options')).json;
  const fresh = (await call('/auth/passkey/finish', { id: opt.id, response: await auth.get(opt.options.challenge) })).cookie!;
  const [s] = await sql`select id, restricted_until > now() as limited, login_method from sessions where user_id = ${userId} order by id desc limit 1`;
  expect(s).toMatchObject({ limited: true, login_method: 'passkey' });
  for (const [path, method] of [['/settings/passkeys/options', 'POST'], ['/settings/password', 'PUT'], ['/settings/password', 'DELETE']] as const) {
    expect((await call(path, {}, fresh, method)).json.code).toBe('fresh_session');
  }
  expect((await call(`/sessions/${(await sql`select min(id) as id from sessions where user_id = ${userId}`)[0].id}`, undefined, fresh, 'DELETE')).json.code).toBe('fresh_session');
  const qr = await call('/auth/qr', {});
  expect((await call('/auth/qr/accept', { token: qr.json.token }, fresh)).json.code).toBe('fresh_session');
  // в списке — ограничение, способ входа
  const mine = ((await call("/sessions", undefined, fresh, "GET")).json as unknown as { current: boolean }[]).find((x: { current: boolean }) => x.current);
  expect(mine).toMatchObject({ limited: true, method: 'passkey', place: 'Локальная сеть' });
  // «Это я» со старого устройства снимает ограничение
  await call(`/sessions/${s.id}/confirm`, {}, first);
  expect((await call('/settings/passkeys/options', {}, fresh)).status).toBe(200);
});

test('login codes leave the chat once used or replaced: digits hidden, a note instead', async () => {
  const { userId } = await signUp('+79990000071');
  const text = async () => (await opened(await sql`select m.* from messages m join service_chats s on s.chat_id = m.chat_id where s.user_id = ${userId} and m.service_type = 'login_code' order by m.id`)).map((r) => r.body as string);
  const a = await call('/auth/code', { login: '+79990000071' });
  const b = await call('/auth/code', { login: '+79990000071' });
  let bodies = await text();
  expect(bodies[0]).toContain('•••••');
  expect(bodies[0]).toContain('Код заменён новым.');
  expect(bodies[0]).not.toContain(a.json.devCode);
  expect(bodies[1]).toContain(b.json.devCode);
  await call('/auth/signin', { attemptId: b.json.attemptId, code: b.json.devCode });
  bodies = await text();
  expect(bodies[1]).not.toContain(b.json.devCode);
  expect(bodies[1]).toContain('Код использован для входа.');
});

test('«new login» names the place and the method, and flags a country the account never signed in from', async () => {
  const { setGeoReader } = await import('../src/geoip');
  const places: Record<string, { country: { names: { ru: string } }; city: { names: { ru: string } } }> = {
    '203.0.113.5': { country: { names: { ru: 'Россия' } }, city: { names: { ru: 'Москва' } } },
    '198.51.100.7': { country: { names: { ru: 'Бразилия' } }, city: { names: { ru: 'Сан-Паулу' } } },
  };
  setGeoReader({ get: (ip: string) => places[ip] ?? null } as never);
  const prev = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  try {
    const login = async (ip: string) => {
      const code = await call('/auth/code', { login: '+79990000072' });
      await fetch(base + '/auth/signin', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-forwarded-for': ip }, body: JSON.stringify({ attemptId: code.json.attemptId, code: code.json.devCode }) });
    };
    const { userId, cookie } = await signUp('+79990000072');
    await sql`update sessions set country = 'Россия', city = 'Москва' where user_id = ${userId}`;
    await login('203.0.113.5');
    const last = async () => (await opened(await sql`select m.* from messages m join service_chats s on s.chat_id = m.chat_id where s.user_id = ${userId} and m.service_type = 'new_login' order by m.id desc limit 1`))[0].body as string;
    let body = await last();
    expect(body).toContain('Место: Москва, Россия');
    expect(body).toContain('Способ входа: код из Relay');
    expect(body).not.toContain('Необычное место');
    await login('198.51.100.7');
    body = await last();
    expect(body).toContain('Место: Сан-Паулу, Бразилия');
    expect(body).toContain('Необычное место: раньше вы входили только из Россия.');
    expect(cookie).toBeTruthy();
  } finally {
    process.env.TRUST_PROXY = prev;
    setGeoReader(null);
  }
});
