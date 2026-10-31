// Аудит 2026-10-25, UPL-1: после подтверждения загрузки объект нельзя подменить по ещё живой подписанной ссылке.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { resetDb, uploadIntent } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

test('UPL-1: a PUT to the old upload link after confirm does not touch the confirmed file', async () => {
  const u = (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name: 'Анна' }) })).json()) as { token: string };
  const original = new TextEncoder().encode('original-bytes');
  const { id, url, mime } = (await (await uploadIntent(base, u.token, { name: 'a.txt', mime: 'text/plain', size: original.length })).json()) as { id: string; url: string; mime: string };
  expect(new URL(url).pathname).toContain('/pending/');   // браузер пишет только во временный ключ
  expect((await fetch(url, { method: 'PUT', body: original, headers: { 'content-type': mime } })).ok).toBe(true);
  expect((await fetch(`${base}/uploads/${id}/confirm`, { method: 'POST', headers: { cookie: `relay_session=${u.token}` } })).ok).toBe(true);
  // ссылка ещё жива — подменяем содержимое и размер
  await fetch(url, { method: 'PUT', body: 'x'.repeat(10_000), headers: { 'content-type': mime } });
  const loc = (await fetch(`${base}/files/${id}`, { redirect: 'manual', headers: { cookie: `relay_session=${u.token}` } })).headers.get('location')!;
  expect(await (await fetch(loc)).text()).toBe('original-bytes');
});
