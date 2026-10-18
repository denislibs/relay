import { afterAll, beforeEach, expect, test } from 'bun:test';
import { defaultPrivacy, type ServerFrame } from '@relay/protocol';
import { sql } from '../src/db';
import '../src/jobs/kinds';
import { drainJobs } from '../src/jobs/worker';
import { getUpdates } from '../src/domain/journal';
import { sendMessage } from '../src/domain/messages';
import { resetPresence } from '../src/domain/presence';
import { createServer } from '../src/http';
import { startRealtime } from '../src/realtime';
import { makeChat, makeUser, nextFrame, pushBrowser, resetDb } from './helpers';

const server = createServer({ port: 0 });
const stopRealtime = await startRealtime(server);
const base = `http://localhost:${server.port}`;
afterAll(async () => { await stopRealtime(); server.stop(true); push.stop(true); });
beforeEach(async () => { await resetDb(); resetPresence(); got.length = 0; });

type U = { userId: number; token: string };
const login = async (name: string): Promise<U> => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const call = (u: U, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { cookie: `relay_session=${u.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });

const DEFAULTS = { direct: { muted: false, preview: true }, group: { muted: false, preview: true } };

test('defaults without a row; PUT upserts, keeps the other fields and writes settingsChanged', async () => {
  const a = await login('Анна');
  expect(await (await call(a, 'GET', '/settings')).json()).toEqual({ notify: DEFAULTS, sessionsTtlDays: 180, folders: [], privacy: defaultPrivacy(), seq: 0 });
  expect((await sql`select count(*)::int as n from user_settings`)[0].n).toBe(0);

  const r = await call(a, 'PUT', '/settings/notify/group', { muted: true });
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.notify).toEqual({ direct: DEFAULTS.direct, group: { muted: true, preview: true } });
  expect(j.seq).toBe(1);
  await call(a, 'PUT', '/settings/notify/group', { preview: false });
  expect((await (await call(a, 'GET', '/settings')).json()).notify.group).toEqual({ muted: true, preview: false });

  // повтор того же значения журнал не трогает
  const same = await (await call(a, 'PUT', '/settings/notify/group', { preview: false })).json();
  expect(same.seq).toBe(2);
  const items = (await getUpdates(a.userId, 0)).items;
  expect(items.map((i) => i.update.type)).toEqual(['settingsChanged', 'settingsChanged']);
  expect(items[1].update).toEqual({ type: 'settingsChanged', settings: { notify: { direct: DEFAULTS.direct, group: { muted: true, preview: false } }, sessionsTtlDays: 180, folders: [] } });
});

test('settingsChanged reaches a second session of the same user, not another user', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const open = async (u: U) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws?token=${u.token}`);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    return ws;
  };
  const w1 = await open(a), w2 = await open(a), wb = await open(b);
  const seen: ServerFrame[] = [];
  wb.addEventListener('message', (e) => seen.push(JSON.parse(String(e.data))));
  const poke = nextFrame(w2, (f) => f.op === 'poke');
  await call(a, 'PUT', '/settings/notify/direct', { muted: true });
  await poke;
  w2.send(JSON.stringify({ op: 'sync', since: 0 }));
  const f = await nextFrame(w2, (f) => f.op === 'updates') as Extract<ServerFrame, { op: 'updates' }>;
  expect(f.items.map((i) => i.update)).toEqual([{ type: 'settingsChanged', settings: { notify: { direct: { muted: true, preview: true }, group: DEFAULTS.group }, sessionsTtlDays: 180, folders: [] } }]);
  await Bun.sleep(100);
  expect(seen.some((x) => x.op === 'poke')).toBe(false);
  w1.close(); w2.close(); wb.close();
});

test('invalid type, body or field type → 400; needs a session', async () => {
  const a = await login('Анна');
  for (const [path, body] of [['/settings/notify/channel', { muted: true }], ['/settings/notify/direct', { muted: 'yes' }], ['/settings/notify/direct', [1]], ['/settings/notify/direct', null]] as const) {
    const r = await call(a, 'PUT', path, body);
    expect([path, r.status]).toEqual([path, 400]);
  }
  expect((await sql`select count(*)::int as n from user_settings`)[0].n).toBe(0);
  expect((await fetch(`${base}/settings`)).status).toBe(401);
});

// ---- push учитывает умолчания получателя ----
const got: Uint8Array[] = [];
const push = Bun.serve({ port: 0, async fetch(req) { got.push(new Uint8Array(await req.arrayBuffer())); return new Response(null, { status: 201 }); } });
const endpoint = (n: number) => `http://localhost:${push.port}/ep/${n}`;

test('push respects the recipient defaults: muted kind sends nothing, no preview hides the text', async () => {
  const a = await makeUser('Анна');
  const b = await login('Борис');
  const direct = await makeChat([a, b.userId]), group = await makeChat([a, b.userId, await makeUser('Вера')]);
  const br = await pushBrowser();
  expect((await call(b, 'POST', '/push/subscription', { endpoint: endpoint(1), keys: br.keys })).status).toBe(200);

  await call(b, 'PUT', '/settings/notify/group', { muted: true });
  await sendMessage(a, { chatId: group, clientId: crypto.randomUUID(), body: 'в группу' });
  await drainJobs();
  expect(got.length).toBe(0);                       // группы выключены
  await sendMessage(a, { chatId: direct, clientId: crypto.randomUUID(), body: 'лично' });
  await drainJobs();
  expect(got.length).toBe(1);                       // личные — как раньше

  await call(b, 'PUT', '/settings/notify/direct', { preview: false });
  await call(b, 'PUT', '/settings/notify/group', { muted: false, preview: false });
  await sendMessage(a, { chatId: direct, clientId: crypto.randomUUID(), body: 'секрет' });
  await sendMessage(a, { chatId: group, clientId: crypto.randomUUID(), body: 'тоже секрет' });
  await drainJobs();
  expect(got.length).toBe(3);
  expect(await br.decrypt(got[0])).toMatchObject({ title: 'Анна', body: 'лично' });
  // две задачи из одного drainJobs выполняются параллельно — порядок доставки не задан
  const rest = (await Promise.all(got.slice(1).map((g) => br.decrypt(g)))).sort((x, y) => x.title.localeCompare(y.title));
  expect(rest[0]).toMatchObject({ title: 'Анна', body: 'Новое сообщение' });   // заголовок — отправитель, текст скрыт
  expect(rest[1]).toMatchObject({ title: 'Группа', body: 'Новое сообщение' });
});
