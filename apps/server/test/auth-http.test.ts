import { afterAll, beforeEach, expect, test } from 'bun:test';
import type { SessionInfo } from '@relay/protocol';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { startRealtime } from '../src/realtime';
import { resetDb } from './helpers';

// Проводка входа по коду через HTTP: /auth/code → /auth/signin → сеансы, служебное сообщение, журнал.
process.env.DEV_LOGIN = '1';   // devCode в ответе /auth/code
const server = createServer({ port: 0 });
const stopRealtime = await startRealtime(server);
const base = `http://localhost:${server.port}`;
afterAll(async () => { await stopRealtime(); server.stop(true); });
beforeEach(resetDb);

const JSON_TYPE = { 'content-type': 'application/json' };
const post = (path: string, body: unknown, headers: Record<string, string> = JSON_TYPE) =>
  fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
const as = (token: string, path: string, method = 'GET') =>
  fetch(`${base}${path}`, { method, headers: { cookie: `relay_session=${token}` } });

/** Пользователь со старым (подтверждённым) сеансом через dev-вход; имя для входа по коду. */
async function existing(name: string, username: string, phone?: string): Promise<{ userId: number; token: string }> {
  const r = (await (await post('/dev/login', { name, phone })).json()) as { userId: number; token: string };
  await sql`update users set username = ${username} where id = ${r.userId}`;
  return r;
}
const tokenOf = (res: Response) => /relay_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';

test('code → sign-in: cookie, unconfirmed session, new_login notice, sessionsChanged; fresh session cannot end others; old one confirms it', async () => {
  const old = await existing('Анна', 'anna_h');
  const code = await post('/auth/code', { login: '@anna_h' });
  expect(code.status).toBe(200);
  const c = (await code.json()) as { attemptId: string; via: string; length: number; devCode?: string };
  expect(c).toMatchObject({ via: 'app', length: 5 });
  expect(typeof c.attemptId).toBe('string');
  const before = (await sql`select count(*)::int as n from updates where user_id = ${old.userId} and type = 'sessionsChanged'`)[0].n as number;

  const signin = await post('/auth/signin', { attemptId: c.attemptId, code: c.devCode });
  expect(signin.status).toBe(200);
  expect(await signin.json()).toEqual({ userId: old.userId });
  const fresh = tokenOf(signin);
  expect(fresh).not.toBe('');

  // новый сеанс виден и не подтверждён
  const list = (await (await as(old.token, '/sessions')).json()) as SessionInfo[];
  const added = list.find((s) => !s.current)!;
  expect(added.unconfirmed).toBe(true);
  expect(list.find((s) => s.current)!.unconfirmed).toBe(false);

  const [notice] = await sql`select m.id from messages m join service_chats s on s.chat_id = m.chat_id where s.user_id = ${old.userId} and m.service_type = 'new_login'`;
  expect(notice).toBeDefined();
  const after = (await sql`select count(*)::int as n from updates where user_id = ${old.userId} and type = 'sessionsChanged'`)[0].n as number;
  expect(after).toBeGreaterThan(before);

  // свежий сеанс не может завершить остальные
  const kick = await as(fresh, '/sessions?others=1', 'DELETE');
  expect(kick.status).toBe(403);
  expect(await kick.json()).toEqual({ code: 'fresh_session' });

  // старый подтверждает — новый становится обычным
  const ok = await as(old.token, `/sessions/${added.id}/confirm`, 'POST');
  expect(ok.status).toBe(200);
  const again = (await (await as(fresh, '/sessions')).json()) as SessionInfo[];
  expect(again.find((s) => s.current)!.unconfirmed).toBe(false);
});

test('bad bodies → 400 bad_frame; sixth code request in an hour → 429 flood', async () => {
  await existing('Борис', 'boris_h');
  for (const body of [{}, { login: '' }, { login: 5 }, { login: 'x'.repeat(65) }]) {
    const r = await post('/auth/code', body);
    expect([JSON.stringify(body), r.status, await r.json()]).toEqual([JSON.stringify(body), 400, { code: 'bad_frame' }]);
  }
  for (const body of [{}, { attemptId: 1, code: '12345' }, { attemptId: crypto.randomUUID() }]) {
    const r = await post('/auth/signin', body);
    expect([JSON.stringify(body), r.status, await r.json()]).toEqual([JSON.stringify(body), 400, { code: 'bad_frame' }]);
  }
  for (let i = 0; i < 5; i++) expect((await post('/auth/code', { login: '@boris_h' })).status).toBe(200);
  const sixth = await post('/auth/code', { login: '@boris_h' });
  expect(sixth.status).toBe(429);
  expect(await sixth.json()).toEqual({ code: 'flood' });
});

test('login CSRF: non-JSON content type and a foreign Origin are refused', async () => {
  await existing('Вера', 'vera_h');
  // простые типы кросс-сайтовой формы — без preflight; их не принимаем
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
    const headers: Record<string, string> = type ? { 'content-type': type } : {};
    for (const path of ['/auth/code', '/auth/signin']) {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers, body: type ? JSON.stringify({ login: '@vera_h' }) : undefined });
      expect([path, type, r.status, await r.json()]).toEqual([path, type, 400, { code: 'bad_frame' }]);
    }
  }
  // чужой Origin — отказ, даже с JSON; set-cookie не ставится
  for (const path of ['/auth/code', '/auth/signin']) {
    const r = await post(path, { login: '@vera_h' }, { ...JSON_TYPE, origin: 'https://evil.example' });
    expect([path, r.status, r.headers.get('set-cookie')]).toEqual([path, 400, null]);
  }
  expect((await post('/auth/code', { login: '@vera_h' }, { ...JSON_TYPE, origin: 'null' })).status).toBe(400);
  // свой Origin и charset в типе — можно
  const ok = await post('/auth/code', { login: '@vera_h' }, { 'content-type': 'application/json; charset=utf-8', origin: base });
  expect(ok.status).toBe(200);
  // ни одной попытки от отклонённых запросов
  expect((await sql`select count(*)::int as n from login_attempts`)[0].n).toBe(1);
});
