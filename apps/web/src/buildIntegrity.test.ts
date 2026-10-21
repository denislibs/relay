import { expect, test } from 'bun:test';
import { verified } from './buildIntegrity';

const sha = async (s: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))));

test('a hashed build file passes only with the bytes of this build; others pass as is', async () => {
  const table = { '/main-abcdef12.js': await sha('console.log(1)') };
  const ok = await verified(new Response('console.log(1)', { headers: { 'content-type': 'text/javascript', 'content-encoding': 'br' } }), '/main-abcdef12.js', table);
  expect(await ok.text()).toBe('console.log(1)');
  expect(ok.headers.get('content-type')).toBe('text/javascript');
  expect(ok.headers.get('content-encoding')).toBeNull();
  await expect(verified(new Response('alert(document.cookie)'), '/main-abcdef12.js', table)).rejects.toThrow('integrity');
  const other = new Response('x');
  expect(await verified(other, '/sounds/sent.mp3', table)).toBe(other);
  const missing = new Response('nope', { status: 404 });
  expect(await verified(missing, '/main-abcdef12.js', table)).toBe(missing);   // 404 — как есть, проверять нечего
});
