import { expect, test } from 'bun:test';
import { call, errorText } from './api';

const html = (status: number) => new Response('<html>502 Bad Gateway</html>', { status, headers: { 'content-type': 'text/html' } });
const json = (status: number, body: unknown) => Response.json(body, { status });

/** Подставной fetch: отвечает по очереди из списка, считает вызовы. */
function fake(...answers: (Response | Error)[]) {
  const f = Object.assign(async () => {
    f.calls++;
    const a = answers.shift()!;
    if (a instanceof Error) throw a;
    return a;
  }, { calls: 0 });
  return f as unknown as typeof fetch & { calls: number };
}

test('API restarting behind the proxy (502 html): retried, then the answer comes through', async () => {
  const f = fake(html(502), html(502), json(200, { attemptId: 'a' }));
  expect(await call('/auth/code', { login: '+77078627513' }, { fetch: f, delays: [0, 0, 0] })).toEqual({ ok: true, data: { attemptId: 'a' } });
  expect(f.calls).toBe(3);
});

test('API stays down: «сервер недоступен», not the generic error', async () => {
  const f = fake(html(502), html(503), html(502));
  const r = await call('/auth/code', { login: '+7' }, { fetch: f, delays: [0, 0] });
  expect(r).toEqual({ ok: false, code: 'unavailable' });
  expect(errorText('unavailable')).toBe('Сервер недоступен — попробуйте через минуту');
});

test('504 is not retried (the request may have reached the server)', async () => {
  const f = fake(html(504), json(200, {}));
  expect(await call('/auth/code', { login: '+7' }, { fetch: f, delays: [0] })).toEqual({ ok: false, code: 'unavailable' });
  expect(f.calls).toBe(1);
});

test('server error codes pass through untouched and are not retried', async () => {
  const f = fake(json(429, { code: 'flood' }), json(500, { code: 'internal' }));
  expect(await call('/auth/code', { login: '+7' }, { fetch: f, delays: [0] })).toEqual({ ok: false, code: 'flood' });
  expect(await call('/auth/code', { login: '+7' }, { fetch: f, delays: [0] })).toEqual({ ok: false, code: 'internal' });
  expect(f.calls).toBe(2);
  expect(errorText('flood')).toBe('Слишком много попыток. Попробуйте позже');
});

test('no network: offline', async () => {
  expect(await call('/auth/code', {}, { fetch: fake(new TypeError('Failed to fetch')) })).toEqual({ ok: false, code: 'offline' });
});
