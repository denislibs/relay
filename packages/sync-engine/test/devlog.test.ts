import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sql } from '../../../apps/server/src/db';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { EngineClient, Mirror } from '../src/client';
import { measureRecording } from '../bench/devlog.bench';
import { BODY_MAX, cutUrl, DevLog, LOG_CAP, trimBodies, type DevEvent } from '../src/devlog';
import { Engine } from '../src/engine';
import { fromMessagePort, HostCore, type FromHost, type ToHost } from '../src/host-core';
import type { EngineConfig, Item } from '../src/types';
import { msg, resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: EngineConfig) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const dev = (e: Engine, cmd: string, args?: unknown) => e.call({ type: 'dev', cmd, args } as never);

async function pair() {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  return { a, b, chatId };
}
async function until(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await Bun.sleep(5); }
}
const events = (e: Engine) => e.dev.log.since(0);
const has = (e: Engine, kind: DevEvent['kind'], type: string) => events(e).some((x) => x.kind === kind && x.type === type);

// ---------- буфер ----------

test('ring buffer never exceeds 2000 and keeps order', () => {
  const log = new DevLog();
  for (let i = 0; i < 5000; i++) log.record('engine', 't', { i });
  expect(log.size).toBe(LOG_CAP);
  const all = log.since(0);
  expect(all.length).toBe(LOG_CAP);
  expect(all[0].id).toBe(5000 - LOG_CAP + 1);
  expect(all.every((e, k) => k === 0 || e.id === all[k - 1].id + 1)).toBe(true);
  expect((all.at(-1)!.data as { i: number }).i).toBe(4999);
  // курсор: только новее
  expect(log.since(4990).map((e) => e.id)).toEqual([4991, 4992, 4993, 4994, 4995, 4996, 4997, 4998, 4999, 5000]);
  log.clear();
  expect(log.size).toBe(0);
  log.record('engine', 'after', null);
  expect(log.since(0).map((e) => e.type)).toEqual(['after']);
});

test('message bodies are truncated to 40 chars, one level into items/message/result', () => {
  const long = 'х'.repeat(100);
  const log = new DevLog();
  log.frameOut({ op: 'send', reqId: 'r1', clientId: crypto.randomUUID(), chatId: 1, body: long }, 200);
  log.frameOut({ op: 'draft', reqId: 'r2', chatId: 1, text: long }, 200);
  const [send, draft] = log.since(0);
  expect((send.data as { body: string }).body.length).toBeLessThanOrEqual(BODY_MAX + 1);
  expect((draft.data as { text: string }).text.length).toBeLessThanOrEqual(BODY_MAX + 1);
  const nested = trimBodies({ items: [{ body: long }, { text: long, x: 1 }], message: { body: long }, result: { body: long } }) as Record<string, any>;
  expect(nested.items[0].body.length).toBe(BODY_MAX + 1);
  expect(nested.items[1]).toEqual({ text: 'х'.repeat(BODY_MAX) + '…', x: 1 });
  expect(nested.message.body.length).toBe(BODY_MAX + 1);
  expect(nested.result.body.length).toBe(BODY_MAX + 1);
  const short = { op: 'poke' };
  expect(trimBodies(short)).toBe(short);   // нечего резать — без копии
});

test('updates are summarized (from, to, count, types) and replies get request → response latency', async () => {
  const log = new DevLog();
  log.frameOut({ op: 'sync', since: 10 }, 20);
  log.frameOut({ op: 'send', reqId: 'r7', clientId: crypto.randomUUID(), chatId: 1, body: 'x' }, 50);
  await Bun.sleep(20);
  const items = [1, 2, 3].map((i) => ({ seq: 10 + i, update: { type: 'newMessage' as const, message: msg({ id: i, chatId: 1, senderId: 2 }) } }));
  log.frameIn({ op: 'updates', from: 10, to: 13, items, more: false }, 900);
  log.frameIn({ op: 'ack', reqId: 'r7', result: { id: 5 } }, 40);
  log.frameIn({ op: 'err', reqId: 'nope', code: 'internal', retry: true }, 40);
  const [, , upd, ack, err] = log.since(0);
  expect(upd.data).toEqual({ from: 10, to: 13, count: 3, more: false, types: { newMessage: 3 } });
  expect(upd.size).toBe(900);
  expect(upd.ms!).toBeGreaterThanOrEqual(15);
  expect(ack.ms!).toBeGreaterThanOrEqual(15);
  expect(err.ms).toBeUndefined();   // запроса с таким reqId не было
});

// ---------- подписки ----------

test('devLog: nothing is sent without a subscriber; snapshot after since, then only new events in 250 ms batches', async () => {
  const { a } = await pair();
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  // подписчика нет: журнал пишется, таймеров раздела нет
  expect(ea.dev.idle).toBe(true);
  expect(has(ea, 'ws-in', 'hello')).toBe(true);
  const cursor = ea.dev.log.lastId;
  await ea.call({ type: 'refreshChats' });
  await ea.whenIdle();

  const patches: { op: string; n: number; keys: string[] }[] = [];
  const h = ea.watch({ kind: 'devLog', since: cursor }, (p) => {
    const items = p.op === 'snapshot' ? p.items : p.upsert;
    patches.push({ op: p.op, n: items.length, keys: items.map((i) => i.key) });
  });
  expect(ea.dev.idle).toBe(false);
  await until(() => patches.length === 1);
  expect(patches[0].op).toBe('snapshot');
  const firstIds = patches[0].keys.map((k) => Number(k.slice(1)));
  expect(firstIds.every((id) => id > cursor)).toBe(true);
  expect(firstIds.length).toBeGreaterThan(0);

  const before = ea.dev.log.lastId;
  ea.dev.log.record('engine', 'marker', null);
  const t0 = Date.now();
  await until(() => patches.length >= 2);
  expect(Date.now() - t0).toBeLessThan(1500);   // такт 250 мс; запас на загруженный CI
  expect(patches[1].op).toBe('diff');
  expect(patches[1].keys.map((k) => Number(k.slice(1))).every((id) => id > before)).toBe(true);
  // без новых событий — тишина
  const n = patches.length;
  await Bun.sleep(600);
  expect(patches.length).toBe(n);

  // курсор вкладки сдвинули — снимок с нового места
  const mark = ea.dev.log.lastId;
  ea.dev.log.record('engine', 'after-cursor', null);
  h.update({ kind: 'devLog', since: mark });
  await until(() => patches.at(-1)!.op === 'snapshot' && patches.length > n);
  expect(patches.at(-1)!.keys).toEqual(['e' + (mark + 1)]);

  h.close();
  expect(ea.dev.idle).toBe(true);
  const after = patches.length;
  ea.dev.log.record('engine', 'unseen', null);
  await Bun.sleep(400);
  expect(patches.length).toBe(after);
});

test('devStats: one item with sync, socket, queues, subscriptions and IDB counts; ping RTT after a tick', async () => {
  const { a, chatId } = await pair();
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await feed.until(() => true);
  const stats = watchInto(ea, { kind: 'devStats' });
  const [s0] = await stats.until((l) => l.length === 1);
  expect(s0.userId).toBe(a.userId);
  expect((s0.sync as Item).phase).toBe('ready');
  expect((s0.sync as Item).lastSeq).toBe(ea.store.lastSeq);
  expect((s0.socket as Item).state).toBe('open');
  expect(s0.idbVersion).toBe(3);
  const subs = s0.subscriptions as { kind: string; key: string }[];
  expect(subs.some((s) => s.key === 'messages:' + chatId)).toBe(true);
  // через тик: IDB посчитана, ping → pong дал RTT
  const [s1] = await stats.until((l) => typeof l[0]?.pingMs === 'number' && !!l[0]?.idb, 3500);
  expect((s1.idb as Record<string, number>).chats).toBe(1);
  expect((s1.sim as Item).active).toBe(false);
  // не чаще раза в секунду
  const n = stats.patches.length;
  await Bun.sleep(500);
  expect(stats.patches.length - n).toBeLessThanOrEqual(1);
  stats.handle.close();
  expect(ea.dev.idle).toBe(true);
});

// ---------- имитатор сети ----------

test('dropNextUpdates: the lost updates frame is noticed and the engine catches up (message arrives)', async () => {
  const { a, b, chatId } = await pair();
  const ea = await open({ ...srv.config(a), syncTimeoutMs: 300 });
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await dev(ea, 'dropNextUpdates');
  expect(ea.dev.sim.dropNextUpdates).toBe(true);
  await sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body: 'дошло после дыры' });
  await feed.until((l) => l.some((m) => m.body === 'дошло после дыры'), 4000);
  expect(has(ea, 'ws-in', 'updates:dropped')).toBe(true);
  expect(has(ea, 'engine', 'syncTimeout')).toBe(true);
  expect(ea.dev.sim.dropNextUpdates).toBe(false);
});

test('offline: messages pile up in the outbox and HTTP fails like no network; turning it off sends them', async () => {
  const { a, chatId } = await pair();
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const status = watchInto(ea, { kind: 'status' });
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await dev(ea, 'offline', { on: true });
  await status.until((l) => l[0]?.phase === 'offline');
  for (const body of ['раз', 'два']) await ea.call({ type: 'sendMessage', chatId, body });
  await Bun.sleep(300);
  expect((await feed.until((l) => l.length === 2)).map((m) => m.status)).toEqual(['pending', 'pending']);
  expect(ea.status().outbox).toBe(2);
  expect((await sql`select count(*)::int as n from messages where chat_id = ${chatId}`)[0].n).toBe(0);
  await expect(ea.call({ type: 'chatMedia', chatId, kind: 'photo' })).rejects.toThrow(/Failed to fetch/);

  await dev(ea, 'offline', { on: false });
  await feed.until((l) => l.length === 2 && l.every((m) => m.status === 'sent'), 4000);
  const rows = await sql`select body from messages where chat_id = ${chatId} order by id`;
  expect(rows.map((r) => r.body)).toEqual(['раз', 'два']);
});

test('netProfile latency 300: an ack does not come back earlier than 300 ms', async () => {
  const { a, chatId } = await pair();
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await dev(ea, 'netProfile', { profile: { latency: 300, jitter: 0, lossPct: 0, kbps: 0 } });
  const t0 = Date.now();
  await ea.call({ type: 'sendMessage', chatId, body: 'медленно' });
  await feed.until((l) => l[0]?.status === 'sent', 4000);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  const ack = events(ea).find((e) => e.kind === 'ws-in' && e.type === 'ack')!;
  expect(ack.ms!).toBeGreaterThanOrEqual(300);
  // HTTP движка тоже задержан
  const h0 = Date.now();
  await ea.call({ type: 'chatMedia', chatId, kind: 'photo' });
  expect(Date.now() - h0).toBeGreaterThanOrEqual(300);
  await dev(ea, 'netProfile', { profile: null });
});

test('dropSocket: abnormal close (4000) → normal reconnect → hello → ready', async () => {
  const { a } = await pair();
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const hellos = () => events(ea).filter((e) => e.kind === 'ws-in' && e.type === 'hello').length;
  expect(hellos()).toBe(1);
  await dev(ea, 'dropSocket');
  await until(() => hellos() === 2, 3000);
  expect(events(ea).some((e) => e.type === 'close' && (e.data as { code: number }).code === 4000)).toBe(true);
  expect(has(ea, 'engine', 'backoff')).toBe(true);
  await ea.whenIdle();
  expect(ea.status().phase).toBe('ready');
});

test('forceTooLong: the next sync reply acts as tooLong → snapshot path', async () => {
  const { a, b, chatId } = await pair();
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body: 'до снимка' });
  await feed.until((l) => l.length === 1);
  const pages = () => events(ea).filter((e) => e.type === 'http' && String((e.data as { path: string }).path).startsWith('/chats/page')).length;
  const p0 = pages();
  await dev(ea, 'forceTooLong');
  await until(() => ea.dev.counters.tooLongCount === 1, 3000);
  await ea.whenIdle();
  expect(has(ea, 'ws-in', 'updates:asTooLong')).toBe(true);
  expect(events(ea).some((e) => e.type === 'snapshot' && (e.data as { reason: string }).reason === 'tooLong')).toBe(true);
  expect(pages()).toBeGreaterThan(p0);
  // после снимка история догружается заново
  await feed.until((l) => l.some((m) => m.body === 'до снимка'));
});

test('resync takes a snapshot without wiping; retryFailed / discardFailed act on failed outbox entries', async () => {
  const { a, chatId } = await pair();
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await ea.call({ type: 'sendMessage', chatId, body: 'осталось' });
  await feed.until((l) => l[0]?.status === 'sent');
  await dev(ea, 'resync');
  await ea.whenIdle();
  expect(feed.list().map((m) => m.body)).toEqual(['осталось']);

  await ea.call({ type: 'sendMessage', chatId, body: '   ' });   // пустое тело — сервер отказывает
  await feed.until((l) => l.some((m) => m.status === 'failed'));
  expect(await dev(ea, 'retryFailed')).toEqual({ count: 1 });
  expect(has(ea, 'engine', 'dev:retryFailed')).toBe(true);
  await until(() => ea.status().failed === 1 && ea.status().outbox === 0);   // и снова отказ
  expect(await dev(ea, 'discardFailed')).toEqual({ count: 1 });
  await feed.until((l) => l.length === 1 && l[0].body === 'осталось');
  expect(ea.status().failed).toBe(0);
});

test('persist: simulated offline survives an engine restart; without persist it resets', async () => {
  const { a } = await pair();
  const cfg = srv.config(a);
  let ea = await open(cfg);
  ea.connect();
  await ea.whenIdle();
  await dev(ea, 'offline', { on: true, persist: true });
  await ea.close(); engines.length = 0;
  ea = await open(cfg);
  expect(ea.dev.sim.offline).toBe(true);
  ea.connect();
  await Bun.sleep(200);
  expect(ea.status().phase).toBe('offline');
  await dev(ea, 'persist', { on: false });
  await dev(ea, 'offline', { on: false });
  await ea.whenIdle();
  expect(ea.status().phase).toBe('ready');
  await ea.close(); engines.length = 0;
  ea = await open(cfg);
  expect(ea.dev.sim.offline).toBe(false);
});

test('restartWorker through HostCore: engine re-opens, tabs keep their subscriptions without a reload', async () => {
  const { a, b, chatId } = await pair();
  const core = new HostCore({ build: 'v1', open: (cfg) => Engine.open(cfg) });
  const ch = new MessageChannel();
  core.attach(fromMessagePort<ToHost, FromHost>(ch.port2));
  const tab = new EngineClient(fromMessagePort<FromHost, ToHost>(ch.port1), 'v1', srv.config(a));
  let reloaded = false;
  tab.onReload(() => { reloaded = true; });
  await tab.ready;
  const m = new Mirror();
  tab.watch({ kind: 'messages', chatId, limit: 50 }, (p) => m.apply(p));
  const stats = new Mirror();
  tab.watch({ kind: 'devStats' }, (p) => stats.apply(p));
  await until(() => !!stats.meta('devStats'));
  expect((stats.meta('devStats')!.host as { kind: string; clients: number }).clients).toBe(1);
  const up0 = stats.meta('devStats')!.engineUptimeMs as number;
  expect(await tab.call({ type: 'dev', cmd: 'restartWorker' })).toEqual({ restarted: 'engine' });
  await sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body: 'после перезапуска' });
  await until(() => m.list().some((x) => x.body === 'после перезапуска'), 4000);
  await until(() => (stats.meta('devStats')?.engineUptimeMs as number) < up0 + 500, 3000);
  expect(reloaded).toBe(false);
  tab.close();
  await core.close();
});

// ---------- граница поведения: вне имитатора медленный ответ — не обрыв ----------

/** WebSocket, у которого ответы ack и updates приходят на delayMs позже (медленный сервер, не имитатор). */
function slowSocket(delayMs: number): typeof WebSocket {
  const Real = globalThis.WebSocket;
  return class Slow extends Real {
    constructor(url: string | URL, p?: string | string[]) {
      super(url, p);
      let h: ((e: MessageEvent) => void) | null = null;
      super.onmessage = (e: MessageEvent) => { /"op":"(ack|updates)"/.test(String(e.data)) ? setTimeout(() => h?.(e), delayMs) : h?.(e); };
      Object.defineProperty(this, 'onmessage', { get: () => h, set: (f) => { h = f; }, configurable: true });
    }
  } as typeof WebSocket;
}

test('no simulator: a slow ack / sync reply never drops the socket, re-asks or rolls back a reaction', async () => {
  const { a, b, chatId } = await pair();
  const Real = globalThis.WebSocket;
  globalThis.WebSocket = slowSocket(800);
  try {
    // таймауты меньше задержки ответа: вне имитатора они не должны сработать вовсе
    const ea = await open({ ...srv.config(a), syncTimeoutMs: 100, requestTimeoutMs: 100 });
    ea.connect();
    await ea.whenIdle(5000);
    const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
    const { message } = await sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body: 'реагируй' });
    await feed.until((l) => l.length === 1, 4000);
    const syncs0 = events(ea).filter((e) => e.kind === 'ws-out' && e.type === 'sync').length;
    await ea.call({ type: 'react', chatId, id: message.id, emoji: '👍' });
    await ea.whenIdle(5000);
    expect((feed.list()[0].reactions as { emoji: string }[]).map((r) => r.emoji)).toEqual(['👍']);
    expect(events(ea).filter((e) => e.type === 'close' || e.type === 'syncTimeout' || e.type === 'requestTimeout')).toEqual([]);
    expect(events(ea).filter((e) => e.kind === 'ws-in' && e.type === 'hello').length).toBe(1);
    // на каждый poke — один sync, без повторов
    const pokes = events(ea).filter((e) => e.kind === 'ws-in' && e.type === 'poke').length;
    expect(events(ea).filter((e) => e.kind === 'ws-out' && e.type === 'sync').length - syncs0).toBeLessThanOrEqual(pokes);
  } finally {
    globalThis.WebSocket = Real;
  }
});

test('a real «online» event while simulated offline is on keeps the phase offline', async () => {
  const g = globalThis as unknown as { dispatchEvent?: (e: Event) => boolean; addEventListener?: unknown };
  if (typeof g.dispatchEvent !== 'function' || typeof g.addEventListener !== 'function') return;   // в этой среде нет событий сети
  const { a } = await pair();
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  await dev(ea, 'offline', { on: true });
  await until(() => ea.status().phase === 'offline');
  g.dispatchEvent(new Event('online'));
  await Bun.sleep(100);
  expect(ea.status().phase).toBe('offline');
  await dev(ea, 'offline', { on: false });
  await ea.whenIdle();
  expect(ea.status().phase).toBe('ready');
});

test('offline turned on mid-request: the request that reached the server completes; new ones wait', async () => {
  const { a, chatId } = await pair();
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await dev(ea, 'netProfile', { profile: { latency: 400, jitter: 0, lossPct: 0, kbps: 0 } });
  await ea.call({ type: 'sendMessage', chatId, body: 'в полёте' });
  await until(() => events(ea).some((e) => e.kind === 'ws-out' && e.type === 'send'));
  await dev(ea, 'offline', { on: true });
  await ea.call({ type: 'sendMessage', chatId, body: 'после офлайна' });
  await feed.until((l) => l.find((m) => m.body === 'в полёте')?.status === 'sent', 3000);
  await until(() => ea.status().phase === 'offline', 3000);
  expect(feed.list().find((m) => m.body === 'после офлайна')?.status).toBe('pending');
  const rows = await sql`select body from messages where chat_id = ${chatId} order by id`;
  expect(rows.map((r) => r.body)).toEqual(['в полёте']);
  await dev(ea, 'netProfile', { profile: null });
  await dev(ea, 'offline', { on: false });
  await feed.until((l) => l.every((m) => m.status === 'sent'), 4000);
});

test('restartWorker failure: the call reports the error, tabs are told to reload, the next hello opens an engine', async () => {
  const { a } = await pair();
  let opens = 0;
  const core = new HostCore({ build: 'v1', open: (cfg) => (++opens === 2 ? Promise.reject(new Error('open_failed')) : Engine.open(cfg)) });
  const tabOf = () => {
    const ch = new MessageChannel();
    core.attach(fromMessagePort<ToHost, FromHost>(ch.port2));
    return new EngineClient(fromMessagePort<FromHost, ToHost>(ch.port1), 'v1', srv.config(a));
  };
  const t1 = tabOf();
  let reloaded = false;
  t1.onReload(() => { reloaded = true; });
  await t1.ready;
  const err = await t1.call({ type: 'dev', cmd: 'restartWorker' }).then(() => null, (e: Error) => e.message);
  expect(err).toBe('open_failed');
  await until(() => reloaded);
  const t2 = tabOf();
  await t2.ready;   // хост не застрял: движок открылся заново
  const st = new Mirror();
  t2.watch({ kind: 'status' }, (p) => st.apply(p));
  await until(() => st.meta('status')?.phase === 'ready', 4000);
  expect(opens).toBe(3);
  t1.close(); t2.close();
  await core.close();
});

test('devLog append patches keep a Mirror in order without sending the whole order', async () => {
  const { a } = await pair();
  const ea = await open(srv.config(a));
  const m = new Mirror();
  const diffs: { order?: string[]; append?: boolean }[] = [];
  let snap = false;
  ea.watch({ kind: 'devLog', since: 0 }, (p) => { m.apply(p); if (p.op === 'diff') diffs.push(p); else snap = true; });
  await until(() => snap);
  for (let i = 0; i < LOG_CAP + 50; i++) ea.dev.log.record('engine', 'x', { i });
  await until(() => diffs.length >= 1);
  expect(diffs.every((d) => d.append === true && d.order === undefined)).toBe(true);
  const ids = m.order.map((k) => Number(k.slice(1)));
  expect(ids.length).toBe(ea.dev.log.size);
  expect(ids[0]).toBe(ea.dev.log.firstId);
  expect(ids.every((id, k) => k === 0 || id === ids[k - 1] + 1)).toBe(true);
  expect(m.items.size).toBe(ids.length);
});

test('log hides thumbnails, query strings and long error texts', () => {
  const log = new DevLog();
  const thumb = 'data:image/jpeg;base64,' + 'A'.repeat(5000);
  log.frameOut({ op: 'send', reqId: 'r1', clientId: crypto.randomUUID(), chatId: 1, body: 'x', attachment: { id: 'f1', thumb } }, 5100);
  const att = (log.since(0)[0].data as { attachment: { thumb: string } }).attachment;
  expect(att.thumb.length).toBeLessThan(40);
  expect(att.thumb).toContain('data:…(');
  log.error('engine', new Error('HTTP 400 /search?q=секретный текст поиска'));
  const msg = (log.since(0)[1].data as { message: string }).message;
  expect(msg).not.toContain('секретный');
  expect(cutUrl('http://x/chats/page?limit=100&beforeAt=1')).toBe('http://x/chats/page?…');
});

// ---------- перф (подробные цифры — bun bench/devlog.bench.ts) ----------

test('perf: recording an updates frame of 500 items stays a small fraction of applying it', async () => {
  // цель ≤ 2 % (меряет bench); здесь — свободная граница и лучшая из трёх попыток, чтобы не мигать на загруженном CI
  let best = Infinity;
  for (let i = 0; i < 3 && best > 0.02; i++) best = Math.min(best, (await measureRecording()).ratio);
  expect(best).toBeLessThanOrEqual(0.05);
});

test('status carries simulator flags (devSim) only while a mode is on', async () => {
  const { a } = await pair();
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const status = watchInto(ea, { kind: 'status' });
  await status.until((l) => l.length === 1);
  expect(status.list()[0].devSim).toBeNull();
  await dev(ea, 'netProfile', { profile: { latency: 300, jitter: 0, lossPct: 0, kbps: 400 } });
  const on = await status.until((l) => !!l[0]?.devSim);
  expect(on[0].devSim).toMatchObject({ offline: false, profile: { latency: 300, kbps: 400 } });
  await dev(ea, 'netProfile', { profile: null });
  await status.until((l) => l[0]?.devSim === null);
});

test('idbRead: paged, read-only store viewer; messages of one chat by sort with key search; bodies trimmed', async () => {
  const { a, b, chatId } = await pair();
  const long = 'я'.repeat(100);
  for (let i = 0; i < 5; i++) await sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body: i === 0 ? long : 'm' + i });
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await feed.until((l) => l.length === 5);
  await ea.whenIdle();
  type R = { rows: { key: string; value: Record<string, unknown> }[]; offset: number; more: boolean };
  const chats = await dev(ea, 'idbRead', { store: 'chats' }) as R;
  expect(chats.rows.map((r) => r.key)).toEqual([String(chatId)]);
  const p1 = await dev(ea, 'idbRead', { store: 'messages', chatId, limit: 3 }) as R;
  expect(p1.rows.length).toBe(3);
  expect(p1.more).toBe(true);
  expect((p1.rows[0].value.body as string).length).toBe(41);   // обрезано, как в журнале
  const p2 = await dev(ea, 'idbRead', { store: 'messages', chatId, limit: 3, offset: 3 }) as R;
  expect(p2.rows.length).toBe(2);
  expect(p2.more).toBe(false);
  const sorts = [...p1.rows, ...p2.rows].map((r) => r.value.sort as number);
  expect(sorts).toEqual([...sorts].sort((x, y) => x - y));
  const k = p2.rows[1].key;
  const found = await dev(ea, 'idbRead', { store: 'messages', chatId, q: k }) as R;
  expect(found.rows.map((r) => r.key)).toEqual([k]);
  const meta = await dev(ea, 'idbRead', { store: 'meta' }) as R;
  expect(meta.rows.some((r) => r.key === 'lastSeq')).toBe(true);
  await expect(dev(ea, 'idbRead', { store: 'blobs' })).rejects.toThrow(/bad_store/);
});
