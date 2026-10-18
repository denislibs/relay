import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { NO_PREVIEW } from '@relay/protocol';
import { sendMessage } from '../src/domain/messages';
import { postService } from '../src/domain/service';
import '../src/jobs/kinds';
import { drainJobs } from '../src/jobs/worker';
import { connect, processAlive } from '../src/domain/liveRegistry';
import { makeChat, makeUser, resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => { server.stop(true); push.stop(true); });
beforeEach(async () => { await resetDb(); got.length = 0; status = 201; });

// поддельный push-сервис: копит запросы, отвечает status
const got: { path: string; auth: string; encoding: string; body: Uint8Array }[] = [];
let status = 201;
const push = Bun.serve({ port: 0, async fetch(req) {
  got.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization') ?? '', encoding: req.headers.get('content-encoding') ?? '', body: new Uint8Array(await req.arrayBuffer()) });
  return new Response(null, { status });
} });
const endpoint = (n: number) => `http://localhost:${push.port}/ep/${n}`;

const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const enc = new TextEncoder();
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, n * 8));
}

/** Браузер: ключи подписки и расшифровка по RFC 8291. */
async function browser() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys: { p256dh: b64u(pub), auth: b64u(auth) },
    async decrypt(body: Uint8Array) {
      const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), rec = body.slice(21 + idlen);
      const as = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, pair.privateKey, 256));
      const ikm = await hkdf(auth, shared, cat(enc.encode('WebPush: info\0'), pub, asPub), 32);
      const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, rec));
      expect(plain[plain.length - 1]).toBe(2);
      return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
    },
  };
}

/** сеанс пользователя (как после входа) — подписка без него невозможна */
async function sessionFor(userId: number): Promise<number> {
  const [r] = await sql`insert into sessions (token_hash, user_id, expires_at) values (${crypto.randomUUID()}, ${userId}, now() + interval '30 days') returning id`;
  return Number(r.id);
}

test('offline member gets an encrypted push signed with the VAPID key; sender and muted chats do not', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]), other = await makeChat([a, b, await makeUser('Вера')]);
  const br = await browser();
  const { subscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(1), keys: br.keys, muted: [other] }, await sessionFor(b));
  await subscribe(a, { endpoint: endpoint(2), keys: (await browser()).keys }, await sessionFor(a));

  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'привет' });
  await sendMessage(a, { chatId: other, clientId: crypto.randomUUID(), body: 'в заглушённый' });
  await drainJobs();
  expect(got.length).toBe(1);
  expect(got[0].encoding).toBe('aes128gcm');
  expect(await br.decrypt(got[0].body)).toEqual({ chatId: chat, id: message.id, title: 'Анна', body: 'привет' });

  // подпись JWT проверяется публичным ключом из /push/key
  const { key } = await (await fetch(`${base}/push/key`)).json() as { key: string };
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(got[0].auth)!;
  expect(m[4]).toBe(key);
  const pub = await crypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(m[3], 'base64url'), enc.encode(`${m[1]}.${m[2]}`))).toBe(true);
  expect(JSON.parse(Buffer.from(m[2], 'base64url').toString()).aud).toBe(`http://localhost:${push.port}`);
});

test('gone subscription is forgotten; HTTP subscribe needs a session', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const { subscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(3), keys: (await browser()).keys }, await sessionFor(b));
  status = 410;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'x' });
  await drainJobs();
  expect((await sql`select count(*)::int as n from push_subscriptions`)[0].n).toBe(0);
  expect((await fetch(`${base}/push/subscription`, { method: 'POST', body: JSON.stringify({ endpoint: endpoint(4), keys: { p256dh: 'x', auth: 'y' } }) })).status).toBe(401);
});

test('direct push is titled with the recipient\'s contact name for the sender; group body too', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]), group = await makeChat([a, b, await makeUser('Вера')]);
  await sql`insert into contacts (owner_id, user_id, first_name, last_name) values (${b}, ${a}, 'Аня', 'С')`;
  const br = await browser();
  const { subscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(5), keys: br.keys }, await sessionFor(b));
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'привет' });
  await drainJobs();
  expect(await br.decrypt(got[0].body)).toMatchObject({ title: 'Аня С', body: 'привет' });
  await sendMessage(a, { chatId: group, clientId: crypto.randomUUID(), body: 'всем' });
  await drainJobs();
  expect(await br.decrypt(got[1].body)).toMatchObject({ title: 'Группа', body: 'Аня С: всем' });
});

// ---- подписка принадлежит сеансу ----
type U = { userId: number; token: string };
const login = async (name: string): Promise<U> =>
  (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const call = (u: U, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { cookie: `relay_session=${u.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const sessionIdOf = async (u: U) => ((await (await call(u, 'GET', '/sessions')).json()) as { id: number; current: boolean }[]).find((s) => s.current)!.id;
/** отправить и дождаться всех push; вернуть пути endpoint'ов, куда ушло */
async function sendAndCollect(from: number, chatId: number): Promise<string[]> {
  got.length = 0;
  await sendMessage(from, { chatId, clientId: crypto.randomUUID(), body: 'секрет' });
  await drainJobs();
  return got.map((g) => g.path).sort();
}

test('terminated and logged-out sessions get no push; the other session still does', async () => {
  const a1 = await login('Анна'), a2 = await login('Анна'), a3 = await login('Анна');
  const b = await makeUser('Борис');
  const chat = await makeChat([a1.userId, b]);
  for (const [u, n] of [[a1, 11], [a2, 12], [a3, 13]] as const) {
    expect((await call(u, 'POST', '/push/subscription', { endpoint: endpoint(n), keys: (await browser()).keys })).status).toBe(200);
  }
  expect(await sendAndCollect(b, chat)).toEqual(['/ep/11', '/ep/12', '/ep/13']);

  // «Завершить сеанс» a2 из a1
  expect((await call(a1, 'DELETE', `/sessions/${await sessionIdOf(a2)}`)).status).toBe(200);
  expect(await sendAndCollect(b, chat)).toEqual(['/ep/11', '/ep/13']);

  // обычный выход a3
  expect((await call(a3, 'POST', '/logout')).status).toBe(200);
  expect(await sendAndCollect(b, chat)).toEqual(['/ep/11']);
  expect((await sql`select endpoint from push_subscriptions`).map((r) => r.endpoint)).toEqual([endpoint(11)]);
});

test('terminate-others and the inactivity sweep drop subscriptions', async () => {
  const a1 = await login('Анна'), a2 = await login('Анна');
  const b = await makeUser('Борис');
  const chat = await makeChat([a1.userId, b]);
  await call(a1, 'POST', '/push/subscription', { endpoint: endpoint(21), keys: (await browser()).keys });
  await call(a2, 'POST', '/push/subscription', { endpoint: endpoint(22), keys: (await browser()).keys });
  expect(await sendAndCollect(b, chat)).toEqual(['/ep/21', '/ep/22']);

  expect((await call(a1, 'DELETE', '/sessions?others=1')).status).toBe(200);
  expect(await sendAndCollect(b, chat)).toEqual(['/ep/21']);

  // автозавершение по неактивности
  await sql`update sessions set last_active_at = now() - interval '400 days' where user_id = ${a1.userId}`;
  const { sweepInactive } = await import('../src/domain/sessions');
  await sweepInactive(a1.userId);
  expect(await sendAndCollect(b, chat)).toEqual([]);
  expect((await sql`select count(*)::int as n from push_subscriptions`)[0].n).toBe(0);
});

test('expired or inactive-past-TTL sessions get no push before the sweep removes them', async () => {
  const a1 = await login('Анна'), a2 = await login('Анна'), a3 = await login('Анна');
  const b = await makeUser('Борис');
  const chat = await makeChat([a1.userId, b]);
  for (const [u, n] of [[a1, 41], [a2, 42], [a3, 43]] as const) {
    expect((await call(u, 'POST', '/push/subscription', { endpoint: endpoint(n), keys: (await browser()).keys })).status).toBe(200);
  }
  // a2 — срок cookie истёк; a3 — неактивен дольше срока владельца (30 дней); строки ещё на месте
  await sql`insert into user_settings (user_id, sessions_ttl_days) values (${a1.userId}, 30) on conflict (user_id) do update set sessions_ttl_days = 30`;
  await sql`update sessions set expires_at = now() - interval '1 minute' where id = ${await sessionIdOf(a2)}`;
  await sql`update sessions set last_active_at = now() - interval '31 days' where id = ${await sessionIdOf(a3)}`;
  expect(await sendAndCollect(b, chat)).toEqual(['/ep/41']);
  expect((await sql`select count(*)::int as n from push_subscriptions`)[0].n).toBe(3);

  // без своих настроек — срок по умолчанию (180 дней)
  await sql`delete from user_settings where user_id = ${a1.userId}`;
  expect(await sendAndCollect(b, chat)).toEqual(['/ep/41', '/ep/43']);
  await sql`update sessions set last_active_at = now() - interval '181 days' where id = ${await sessionIdOf(a1)}`;
  expect(await sendAndCollect(b, chat)).toEqual(['/ep/43']);
});

test('a subscription cannot exist without a session', async () => {
  const a = await makeUser('Анна');
  const fails = async (p: PromiseLike<unknown>) => { try { await p; return false; } catch { return true; } };
  expect(await fails(sql`insert into push_subscriptions (endpoint, user_id, p256dh, auth) values (${endpoint(51)}, ${a}, 'x', 'y')`)).toBe(true);
  expect((await sql`select count(*)::int as n from push_subscriptions`)[0].n).toBe(0);
});

test('migration 106 removes legacy subscriptions without a session and makes session_id required', async () => {
  const a = await makeUser('Анна');
  const sid = await sessionFor(a);
  const text = await Bun.file(new URL('../migrations/106_push_session_required.sql', import.meta.url)).text();
  // как было до 106: столбец допускает null, есть старая строка без сеанса; всё в транзакции, которую откатываем
  const rollback = new Error('rollback');
  await expect(sql.begin(async (tx) => {
    await tx`alter table push_subscriptions alter column session_id drop not null`;
    await tx`insert into push_subscriptions (endpoint, user_id, p256dh, auth, session_id) values (${endpoint(61)}, ${a}, 'x', 'y', null), (${endpoint(62)}, ${a}, 'x', 'y', ${sid})`;
    await tx.unsafe(text);
    await tx.unsafe(text);   // идемпотентна
    expect((await tx`select endpoint from push_subscriptions`).map((r) => r.endpoint)).toEqual([endpoint(62)]);
    expect((await tx`select is_nullable from information_schema.columns where table_name = 'push_subscriptions' and column_name = 'session_id'`)[0].is_nullable).toBe('NO');
    throw rollback;
  })).rejects.toBe(rollback);
  expect((await sql`select is_nullable from information_schema.columns where table_name = 'push_subscriptions' and column_name = 'session_id'`)[0].is_nullable).toBe('NO');
});

test('hideText subscription gets «Relay» / «Новое сообщение»; the flag follows updates and SW resubscribe', async () => {
  const a = await login('Анна');
  const b = await makeUser('Борис');
  const chat = await makeChat([a.userId, b]), group = await makeChat([a.userId, b, await makeUser('Вера')]);
  const br = await browser();
  await call(a, 'POST', '/push/subscription', { endpoint: endpoint(31), keys: br.keys, hideText: true });
  await sendAndCollect(b, chat);
  expect(await br.decrypt(got[0].body)).toMatchObject({ chatId: chat, title: 'Relay', body: NO_PREVIEW });
  await sendAndCollect(b, group);
  expect(await br.decrypt(got[0].body)).toMatchObject({ chatId: group, title: 'Relay', body: NO_PREVIEW });

  // SW переподписался без флага и с новым endpoint — флаг переезжает
  const br2 = await browser();
  await call(a, 'POST', '/push/subscription', { endpoint: endpoint(32), keys: br2.keys, oldEndpoint: endpoint(31) });
  expect(await sendAndCollect(b, chat)).toEqual(['/ep/32']);
  expect(await br2.decrypt(got[0].body)).toMatchObject({ title: 'Relay', body: NO_PREVIEW });

  // флаг сняли в настройках — снова имя и текст
  await call(a, 'POST', '/push/subscription', { endpoint: endpoint(32), keys: br2.keys, hideText: false });
  await sendAndCollect(b, chat);
  expect(await br2.decrypt(got[0].body)).toMatchObject({ title: 'Борис', body: 'секрет' });
  expect((await call(a, 'POST', '/push/subscription', { endpoint: endpoint(32), keys: br2.keys, hideText: 'yes' })).status).toBe(400);
});

test('service push: login_code is masked, new_login keeps its text', async () => {
  const a = await makeUser('Анна');
  const br = await browser();
  const { subscribe } = await import('../src/domain/push');
  await subscribe(a, { endpoint: endpoint(1), keys: br.keys }, await sessionFor(a));

  const code = await sql.begin((tx) => postService(tx, a, { type: 'login_code', body: 'Код: 12345' }));
  await drainJobs();
  expect(got.length).toBe(1);
  const first = await br.decrypt(got[0].body);
  expect(first.body).toBe('Код для входа в Relay');
  expect(first.system).toBe(true);   // SW покажет знак Relay иконкой

  const login = await sql.begin((tx) => postService(tx, a, { type: 'new_login', body: 'Новый вход' }));
  await drainJobs();
  expect(got.length).toBe(2);
  expect((await br.decrypt(got[1].body)).body).toBe('Новый вход');
});

test('spoiler text never reaches a push: it is replaced with filler, the rest stays', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const br = await browser();
  const { subscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(7), keys: br.keys }, await sessionFor(b));
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'пароль: tiger42', entities: [{ type: 'spoiler', offset: 8, length: 7 }] });
  await drainJobs();
  const p = await br.decrypt(got[0].body) as { body: string };
  expect(p.body.startsWith('пароль: ')).toBe(true);
  expect(p.body).not.toContain('tiger42');
  expect(p.body.length).toBe('пароль: tiger42'.length);
});

test('no worker yet: the push waits in jobs and is delivered once a worker runs', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const br = await browser();
  const { subscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(20), keys: br.keys }, await sessionFor(b));
  got.length = 0;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'дождись' });
  await Bun.sleep(100);
  expect(got.length).toBe(0);                                         // в процессе сервера ничего не уходит
  expect((await sql`select kind from jobs where kind like 'push.%'`).map((r) => r.kind)).toEqual(['push.message']);
  await drainJobs();
  expect(got.length).toBe(1);
  expect(await br.decrypt(got[0].body)).toMatchObject({ body: 'дождись' });
});

test('push service 503 is retried; 400 is dropped to jobs_dead; 410 forgets the subscription', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const { subscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(21), keys: (await browser()).keys }, await sessionFor(b));
  got.length = 0;

  status = 503;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'раз' });
  await drainJobs();
  expect(got.length).toBe(1);
  expect((await sql`select kind from jobs`).map((r) => r.kind)).toEqual(['push.deliver']);   // ждёт повтора
  status = 201;
  await sql`update jobs set run_at = now()`;
  await drainJobs();
  expect(got.length).toBe(2);
  expect((await sql`select count(*)::int as n from jobs`)[0].n).toBe(0);

  status = 400;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'два' });
  await drainJobs();
  expect((await sql`select kind from jobs_dead`).map((r) => r.kind)).toEqual(['push.deliver']);

  status = 410;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'три' });
  await drainJobs();
  expect((await sql`select count(*)::int as n from push_subscriptions`)[0].n).toBe(0);
  status = 201;
});

test('a subscription removed before delivery is skipped quietly', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const { subscribe, unsubscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(22), keys: (await browser()).keys }, await sessionFor(b));
  got.length = 0;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'x' });
  const [job] = await (await import('../src/jobs/queue')).claim(1);   // push.message
  await (await import('../src/jobs/worker')).runJob(job);             // поставил push.deliver
  await unsubscribe(b, endpoint(22));
  await drainJobs();
  expect(got.length).toBe(0);
  expect((await sql`select count(*)::int as n from jobs_dead`)[0].n).toBe(0);
});

test('an online recipient (any process) gets no push', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const { subscribe } = await import('../src/domain/push');
  await subscribe(b, { endpoint: endpoint(23), keys: (await browser()).keys }, await sessionFor(b));
  await processAlive('other-proc');
  await connect(b, 'other-proc');
  got.length = 0;
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'вижу сам' });
  await drainJobs();
  expect(got.length).toBe(0);
});
