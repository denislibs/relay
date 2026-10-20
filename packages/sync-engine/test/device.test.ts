import { expect, test } from 'bun:test';
import { deviceFetch, forgetDeviceKey, refreshAccess } from '../src/device';

/** Сервер-заглушка: /session/* проверяет подпись ключом, присланным при первой привязке; /api — 401 «обнови», пока нет доступа. */
function fakeServer() {
  let bound: CryptoKey | null = null;
  let access = false;
  const calls: string[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    if (url.endsWith('/session/challenge')) return Response.json({ nonce: 'n1' });
    if (url.endsWith('/session/refresh')) {
      const b = JSON.parse(String(init?.body)) as { nonce: string; sig: string; key: string };
      const key = bound ?? await crypto.subtle.importKey('spki', Uint8Array.from(atob(b.key), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Uint8Array.from(atob(b.sig), (c) => c.charCodeAt(0)), new TextEncoder().encode(`relay-device|refresh|${b.nonce}`));
      if (!ok) return new Response('', { status: 401 });
      bound = key; access = true;
      return Response.json({ ok: true });
    }
    return access ? Response.json({ ok: 1 }) : new Response('{"code":"access_expired"}', { status: 401, headers: { 'x-relay-auth': 'refresh' } });
  };
  return { f, calls, expire: () => { access = false; }, rebind: () => { bound = null; } };
}

test('401 «refresh»: the device signs a challenge, gets access and the request is retried once', async () => {
  await forgetDeviceKey();
  const s = fakeServer();
  const fetch = deviceFetch(s.f);
  const r = await fetch('/me');
  expect(r.status).toBe(200);
  expect(s.calls).toEqual(['/me', '/session/challenge', '/session/refresh', '/me']);
  s.expire();
  expect((await fetch('/me')).status).toBe(200);   // тот же ключ из базы — подпись проходит
});

test('a plain 401 (session gone) is passed through; a refused refresh returns the original 401', async () => {
  const plain = deviceFetch(async () => new Response('', { status: 401 }));
  expect((await plain('/me')).status).toBe(401);
  const s = fakeServer();
  await refreshAccess('', s.f);   // привязали ключ
  s.expire();
  await forgetDeviceKey();        // ключ потерян — новый ключ сервер не примет
  expect((await deviceFetch(s.f)('/me')).headers.get('x-relay-auth')).toBe('refresh');
});

test('concurrent refreshes in one context share one request', async () => {
  await forgetDeviceKey();
  const s = fakeServer();
  await Promise.all([refreshAccess('', s.f), refreshAccess('', s.f), refreshAccess('', s.f)]);
  expect(s.calls.filter((c) => c.endsWith('/session/refresh')).length).toBe(1);
});
