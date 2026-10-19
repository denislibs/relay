import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sql } from '../../../apps/server/src/db';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { Engine } from '../src/engine';
import { getAll, openDb } from '../src/idb';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const closeOne = async (e: Engine) => { await e.close(); engines.splice(engines.indexOf(e), 1); };
const api = async (token: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${srv.base}${path}`, { method, headers: { cookie: `relay_session=${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

/** Трек в чате: файл и сообщение-музыка от sender. */
async function song(chatId: number, sender: number, name: string) {
  const [att] = await sql`insert into attachments (owner_id, mime, name, size, kind, duration, status) values (${sender}, 'audio/mpeg', ${name}, 1000, 'audio', 170, 'ready') returning id`;
  const m = await sendMessage(sender, { chatId, clientId: crypto.randomUUID(), body: '', attachment: { id: att.id as string } });
  return { msg: m.message.id, att: att.id as string };
}

/** Считает запросы движка к GET /users/:id/music и /photos. */
function countRequests() {
  const orig = globalThis.fetch;
  const box = { music: 0, photos: 0, restore: () => { globalThis.fetch = orig; } };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    if (/\/users\/\d+\/music$/.test(u)) box.music++;
    if (/\/users\/\d+\/photos\?/.test(u)) box.photos++;
    return orig(input, init);
  }) as typeof fetch;
  return box;
}

test('profileMusic: a summary change in the journal refetches an open list; closed — on the next subscribe', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const t1 = await song(chatId, b.userId, 'Мы Сверхновая.mp3'), t2 = await song(chatId, b.userId, 'Плачу в код.mp3'), t3 = await song(chatId, b.userId, 'Третья.mp3');
  await api(a.token, 'POST', '/me/music', { chatId, messageId: t1.msg });
  const reqs = countRequests();
  try {
    const eb = await open(srv.config(b));
    eb.connect();
    await eb.whenIdle();
    const w = watchInto(eb, { kind: 'profileMusic', userId: a.userId });
    const l = await w.until((x) => x.length === 1);
    expect(l[0]).toMatchObject({ key: t1.att, attId: t1.att, title: 'Мы Сверхновая', duration: 170, mime: 'audio/mpeg' });
    await eb.whenIdle();
    expect(reqs.music).toBe(1);

    // Анна добавила трек: userUpdated со сводкой → список перечитан, новый сверху
    await api(a.token, 'POST', '/me/music', { chatId, messageId: t2.msg });
    const l2 = await w.until((x) => x.length === 2);
    expect(l2.map((x) => x.attId)).toEqual([t2.att, t1.att]);
    await eb.whenIdle();
    expect(reqs.music).toBe(2);

    // подписки нет — не спрашиваем; следующая подписка перечитает
    w.handle.close();
    await api(a.token, 'POST', '/me/music', { chatId, messageId: t3.msg });
    await Bun.sleep(100);
    await eb.whenIdle();
    expect(reqs.music).toBe(2);
    const w2 = watchInto(eb, { kind: 'profileMusic', userId: a.userId });
    expect((await w2.until((x) => x.length >= 2)).length).toBeGreaterThanOrEqual(2);   // сначала — то, что лежит
    await w2.until((x) => x.length === 3 && x[0].attId === t3.att);
    await eb.whenIdle();
    expect(reqs.music).toBe(3);
    // та же сводка — без запроса
    watchInto(eb, { kind: 'profileMusic', userId: a.userId });
    await Bun.sleep(50);
    await eb.whenIdle();
    expect(reqs.music).toBe(3);
  } finally { reqs.restore(); }
});

test('profileMusic: own track added offline shows at once, goes out after connect; the list survives a restart', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const t1 = await song(chatId, b.userId, 'Мы Сверхновая.mp3');
  const cfg = srv.config(a);
  const ea = await open(cfg);
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });   // сообщение с треком — в кэше
  await feed.until((l) => l.length === 1);
  const w = watchInto(ea, { kind: 'profileMusic', userId: a.userId });
  await ea.whenIdle();
  expect(w.list()).toEqual([]);
  ea.disconnect();

  await ea.call({ type: 'addProfileMusic', chatId, messageId: t1.msg });
  const l = await w.until((x) => x.length === 1);
  expect(l[0]).toMatchObject({ key: t1.att, attId: t1.att, title: 'Мы Сверхновая', duration: 170, mime: 'audio/mpeg', pending: true });
  const [{ n }] = await sql`select count(*)::int as n from profile_music where user_id = ${a.userId}`;
  expect(n).toBe(0);

  ea.connect();
  await ea.whenIdle();
  await w.until((x) => x.length === 1 && x[0].pending === false);
  const [{ n: n2 }] = await sql`select count(*)::int as n from profile_music where user_id = ${a.userId}`;
  expect(n2).toBe(1);
  // без отката: строка не пропадала между уходом операции и ответом
  expect(w.patches.some((p) => p.op === 'diff' && p.remove.includes(t1.att))).toBe(false);
  await ea.whenIdle();
  await closeOne(ea);

  const db = await openDb(cfg.dbName);
  const rows = await getAll<Record<string, unknown>>(db, 'profileMusic');
  db.close();
  expect(rows).toMatchObject([{ userId: a.userId, attId: t1.att, title: 'Мы Сверхновая' }]);

  // перезапуск без сети: список сразу, «загружено»
  const cold = await open(cfg);
  const w2 = watchInto(cold, { kind: 'profileMusic', userId: a.userId });
  const l2 = await w2.until((x) => x.length === 1, 500);
  expect(l2[0]).toMatchObject({ attId: t1.att, pending: false });
  expect(w2.patches[0].op).toBe('snapshot');
  const meta = w2.patches[0].op === 'snapshot' ? w2.patches[0].items.find((i) => i.key === '~profileMusic') : null;
  expect(meta).toMatchObject({ loaded: true });

  // убрать — сразу, через очередь
  await cold.call({ type: 'removeProfileMusic', attId: t1.att });
  await w2.until((x) => x.length === 0);
});

test('profileMusic: a rejected add rolls back', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const t1 = await song(chatId, b.userId, 'Мы Сверхновая.mp3');
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  await feed.until((l) => l.length === 1);
  const w = watchInto(ea, { kind: 'profileMusic', userId: a.userId });
  await ea.whenIdle();
  ea.disconnect();
  await sql`update messages set deleted = true where id = ${t1.msg}`;   // сервер ответит not_found

  await ea.call({ type: 'addProfileMusic', chatId, messageId: t1.msg });
  await w.until((x) => x.length === 1 && x[0].pending === true);
  ea.connect();
  await ea.whenIdle();
  await w.until((x) => x.length === 0);
  const ops = watchInto(ea, { kind: 'ops' });
  const [o] = await ops.until((x) => x[0]?.pending === 0);
  expect((o.failures as { key: string }[]).some((f) => f.key === 'music:' + t1.att)).toBe(true);
});

test('profilePhotos: main first then newest, survives a restart; a new main photo refetches the open list', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  await srv.chat(a.token, [a.userId, b.userId]);
  const photo = async () => {
    const [r] = await sql`insert into user_photos (user_id, big, small, thumb) values (${a.userId}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 'data:image/jpeg;base64,AAAA') returning id`;
    return Number(r.id);
  };
  const p1 = await photo(), p2 = await photo();
  await api(a.token, 'PUT', `/me/photos/${p2}/main`);
  const cfg = srv.config(b);
  const reqs = countRequests();
  try {
    const eb = await open(cfg);
    eb.connect();
    await eb.whenIdle();
    const w = watchInto(eb, { kind: 'profilePhotos', userId: a.userId });
    const l = await w.until((x) => x.length === 2);
    expect(l.map((x) => x.pid)).toEqual([p2, p1]);
    expect(l[0]).toMatchObject({ key: String(p2), pid: p2, thumb: 'data:image/jpeg;base64,AAAA' });
    await eb.whenIdle();
    expect(reqs.photos).toBe(1);

    // главным стало старое: сводка (фото профиля) сменилась → список перечитан
    await api(a.token, 'PUT', `/me/photos/${p1}/main`);
    await w.until((x) => x[0]?.pid === p1);
    await eb.whenIdle();
    expect(reqs.photos).toBe(2);
    await closeOne(eb);

    const cold = await open(cfg);
    const w2 = watchInto(cold, { kind: 'profilePhotos', userId: a.userId });
    const l2 = await w2.until((x) => x.length === 2, 500);
    expect(l2.map((x) => x.pid)).toEqual([p1, p2]);
    const meta = w2.patches[0].op === 'snapshot' ? w2.patches[0].items.find((i) => i.key === '~profilePhotos') : null;
    expect(meta).toMatchObject({ loaded: true, total: 2 });
    expect(reqs.photos).toBe(2);
  } finally { reqs.restore(); }
});

test('profilePhotos: deleting a non-main own photo + refreshProfilePhotos drops it from the open list', async () => {
  const a = await srv.login('Анна');
  const photo = async () => {
    const [r] = await sql`insert into user_photos (user_id, big, small, thumb) values (${a.userId}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, 'data:image/jpeg;base64,AAAA') returning id`;
    return Number(r.id);
  };
  const p1 = await photo(), p2 = await photo();
  await api(a.token, 'PUT', `/me/photos/${p2}/main`);
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const w = watchInto(ea, { kind: 'profilePhotos', userId: a.userId });
  await w.until((x) => x.length === 2);
  await api(a.token, 'DELETE', `/me/photos/${p1}`);
  await ea.call({ type: 'refreshProfilePhotos' });
  const l = await w.until((x) => x.length === 1);
  expect(l.map((x) => x.pid)).toEqual([p2]);
});
