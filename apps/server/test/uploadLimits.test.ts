import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { createServer, setDevStatsThrottleMs } from '../src/http';
import { sql } from '../src/db';
import { setUploadLimits } from '../src/domain/uploadLimits';
import { resetDb, uploadFile, uploadIntent } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(async () => { await resetDb(); setDevStatsThrottleMs(0); });
afterEach(() => setUploadLimits());
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const intent = (token: string, size = 10) => uploadIntent(base, token, { name: 'a.txt', mime: 'text/plain', size });
const refused = async (r: Response) => ({ status: r.status, retryAfter: Number(r.headers.get('retry-after')), body: await r.json() as { code: string; retryAfter?: number } });

test('concurrent pending uploads: the 3rd is refused with upload_limit; a confirmed or stale one frees a slot; per user', async () => {
  setUploadLimits({ maxPending: 2 });
  const a = await login('Анна'), b = await login('Борис');
  expect((await intent(a.token)).status).toBe(200);
  const second = await (await intent(a.token)).json() as { id: string };
  const r = await refused(await intent(a.token));
  expect(r).toMatchObject({ status: 429, body: { code: 'upload_limit' } });
  expect(r.retryAfter).toBeGreaterThan(0);
  expect(r.body.retryAfter).toBe(r.retryAfter);
  expect((await intent(b.token)).status).toBe(200);   // у другого пользователя — свой счёт

  // брошенная час назад загрузка — уже не «идёт» (ссылка истекла), место свободно
  await sql`update attachments set created_at = now() - interval '2 hours' where id = ${second.id}`;
  expect((await intent(a.token)).status).toBe(200);
  expect((await intent(a.token)).status).toBe(429);
});

test('refused for too many pending — its bytes go back to the quota', async () => {
  setUploadLimits({ maxPending: 1, bytesPerHour: 100 });
  const a = await login('Анна');
  expect((await intent(a.token, 40)).status).toBe(200);
  expect((await refused(await intent(a.token, 40))).body.code).toBe('upload_limit');
  await sql`update attachments set status = 'ready'`;
  expect((await intent(a.token, 60)).status).toBe(200);   // 40 + 60 = 100 — влезает, отказанные 40 не посчитаны
});

test('bytes per hour and per day: upload_quota with the time left in the window', async () => {
  setUploadLimits({ bytesPerHour: 100, bytesPerDay: 1000 });
  const a = await login('Анна');
  await uploadFile(base, a.token, { name: 'a.txt', mime: 'text/plain' }, 'x'.repeat(60));
  const r = await refused(await intent(a.token, 50));
  expect(r).toMatchObject({ status: 429, body: { code: 'upload_quota' } });
  expect(r.retryAfter).toBeGreaterThan(3500);
  expect(r.retryAfter).toBeLessThanOrEqual(3600);
  expect((await intent(a.token, 40)).status).toBe(200);   // ровно до предела — можно

  setUploadLimits({ bytesPerHour: 10_000, bytesPerDay: 150 });
  const d = await refused(await intent(a.token, 60));
  expect(d.body.code).toBe('upload_quota');
  expect(d.retryAfter).toBeGreaterThan(3600);   // упёрлись в суточное окно
});

test('flood: too many upload requests a minute — 429 flood', async () => {
  setUploadLimits({ perMinute: 3 });
  const a = await login('Анна');
  for (let i = 0; i < 3; i++) expect((await intent(a.token)).status).toBe(200);
  const r = await refused(await intent(a.token));
  expect(r).toMatchObject({ status: 429, body: { code: 'flood' } });
  expect(r.retryAfter).toBeGreaterThan(0);
  expect(r.retryAfter).toBeLessThanOrEqual(60);
});

test('a malformed request does not spend the quota', async () => {
  setUploadLimits({ perMinute: 1 });
  const a = await login('Анна');
  expect((await intent(a.token, 3 * 1024 ** 3)).status).toBe(413);   // больше 2 ГБ
  expect((await intent(a.token, -1)).status).toBe(400);
  expect((await intent(a.token)).status).toBe(200);
});

test('/dev/stats shows storage used and the quota spent', async () => {
  const a = await login('Анна');
  await uploadFile(base, a.token, { name: 'a.txt', mime: 'text/plain' }, 'hello');
  await intent(a.token, 7);
  const s = await (await fetch(`${base}/dev/stats`, { headers: { cookie: `relay_session=${a.token}` } })).json() as { storage: Record<string, unknown> };
  expect(s.storage).toMatchObject({ files: 1, bytes: 5, pending: 1, variantsBytes: 0, quota: { hourBytes: 12, dayBytes: 12, minuteUploads: 2, maxPending: 10 } });
});
