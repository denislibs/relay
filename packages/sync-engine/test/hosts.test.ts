import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { EngineClient, Mirror } from '../src/client';
import { Engine } from '../src/engine';
import { fromMessagePort, HostCore, type FromHost, type ToHost } from '../src/host-core';
import { createDedicatedHost, type LocksLike } from '../src/hosts/dedicated';
import type { Patch, Query } from '../src/types';
import { resetDb, startTestServer } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
beforeEach(resetDb);

/** Вкладка: клиент ↔ хост через MessageChannel. */
function tab() {
  const ch = new MessageChannel();
  return { client: fromMessagePort<FromHost, ToHost>(ch.port1), host: fromMessagePort<ToHost, FromHost>(ch.port2) };
}
function mirrorOf(c: EngineClient, q: Query) {
  const m = new Mirror();
  const patches: Patch[] = [];
  const h = c.watch(q, (p) => { patches.push(p); m.apply(p); });
  return {
    m, patches, h,
    async until(pred: (l: ReturnType<Mirror['list']>) => boolean, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (pred(m.list())) return m.list(); await Bun.sleep(5); }
      throw new Error('timeout: ' + JSON.stringify(m.list()));
    },
  };
}

class FakeLocks implements LocksLike {
  private held = false;
  private queue: (() => void)[] = [];
  request(_name: string, cb: () => Promise<void>) {
    return new Promise<void>((resolve) => {
      const run = async () => {
        this.held = true;
        await cb();
        this.held = false;
        resolve();
        this.queue.shift()?.();
      };
      if (this.held) this.queue.push(run); else run();
    });
  }
}

test('HostCore: two tabs, one engine, each gets only its own subscriptions', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const c1 = await srv.chat(a.token, [a.userId, b.userId]), c2 = await srv.chat(a.token, [a.userId, b.userId]);
  let opened = 0;
  const core = new HostCore({ build: 'v1', open: (cfg) => { opened++; return Engine.open(cfg); } });
  const cfg = srv.config(b);
  const t1 = tab(), t2 = tab();
  core.attach(t1.host); core.attach(t2.host);
  const tab1 = new EngineClient(t1.client, 'v1', cfg), tab2 = new EngineClient(t2.client, 'v1', cfg);
  await Promise.all([tab1.ready, tab2.ready]);
  expect(opened).toBe(1);

  const f1 = mirrorOf(tab1, { kind: 'messages', chatId: c1, limit: 50 });
  const f2 = mirrorOf(tab2, { kind: 'messages', chatId: c2, limit: 50 });
  await f1.until(() => f1.patches.length > 0);
  await f2.until(() => f2.patches.length > 0);
  // данные второй ленты: служебный ~window не в счёт — после синхронизации открытая пустая c2 дочитывает свою историю
  // (loadOpenChats), и её окно узнаёт начало истории; это её собственная подписка, а не сообщение из c1
  const dataPatches = () => f2.patches.filter((p) => p.op === 'snapshot' || p.remove.length || p.upsert.some((i) => !i.key.startsWith('~'))).length;
  const before2 = dataPatches();

  await sendMessage(a.userId, { chatId: c1, clientId: crypto.randomUUID(), body: 'в первый' });
  await f1.until((l) => l.length === 1 && l[0].body === 'в первый');
  await Bun.sleep(50);
  expect(dataPatches()).toBe(before2);

  const res = await tab2.call<{ clientId: string }>({ type: 'sendMessage', chatId: c2, body: 'из второй вкладки' });
  expect(res.clientId).toMatch(/[0-9a-f-]{36}/);
  await f2.until((l) => l.length === 1 && l[0].status === 'sent');

  tab1.close();
  await Bun.sleep(20);
  expect(core.size).toBe(1);
  tab2.close();
  await core.close();
});

test('HostCore: a tab swept as idle (background timers throttled) comes back on its next message', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const core = new HostCore({ build: 'v1', open: (cfg) => Engine.open(cfg) });
  const t = tab();
  core.attach(t.host);
  const c = new EngineClient(t.client, 'v1', srv.config(b), { pingMs: 60_000 });
  await c.ready;
  const feed = mirrorOf(c, { kind: 'messages', chatId, limit: 50 });
  await feed.until(() => feed.patches.length > 0);

  core.sweep(30_000, Date.now() + 60_000);                 // пульса не было: вкладку сочли закрытой
  expect(core.size).toBe(0);

  // вкладка жива: ответ на вызов приходит (раньше — никогда, «Проверяем…» навсегда), подписка снова живая
  const r = await Promise.race([c.call({ type: 'checkUsername', username: 'swept_tab' }), Bun.sleep(2000).then(() => 'hung')]);
  expect(r).not.toBe('hung');
  expect(core.size).toBe(1);
  await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'после сна' });
  await feed.until((l) => l.some((m) => m.body === 'после сна'));
  c.close();
  await core.close();
});

test('HostCore: a different build is told to reload', async () => {
  const b = await srv.login('b');
  const core = new HostCore({ build: 'v2', open: (cfg) => Engine.open(cfg) });
  const t = tab();
  core.attach(t.host);
  const c = new EngineClient(t.client, 'v1', srv.config(b));
  const reloaded = new Promise<void>((r) => c.onReload(r));
  await reloaded;
  c.close();
  await core.close();
});

test('Dedicated: follower works through the leader and takes over when the leader closes', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const cfg = srv.config(b);
  const locks = new FakeLocks();
  const name = 'relay-test-' + crypto.randomUUID();
  const mk = () => {
    const t = tab();
    const host = createDedicatedHost({ self: t.host, channel: new BroadcastChannel(name), locks, tabId: crypto.randomUUID(), build: 'v1', open: (c) => Engine.open(c) });
    const client = new EngineClient(t.client, 'v1', cfg);
    return { host, client };
  };
  const one = mk();
  await one.client.ready;
  const two = mk();
  await two.client.ready;
  expect(one.host.role).toBe('leader');
  expect(two.host.role).toBe('follower');

  const list = mirrorOf(two.client, { kind: 'chatList', limit: 50 });
  await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'через лидера' });
  await list.until((l) => l.length === 1 && (l[0].last as { body: string })?.body === 'через лидера');

  await one.host.close();                       // лидер закрыл вкладку
  await list.until(() => two.host.role === 'leader');
  await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'после смены лидера' });
  await list.until((l) => (l[0].last as { body: string })?.body === 'после смены лидера');
  two.client.close();
  await two.host.close();
});

test('Mirror rebuilds exactly what the engine computes', async () => {
  const b = await srv.login('b'), a = await srv.login('a');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const e = await Engine.open(srv.config(b));
  e.connect();
  const m = new Mirror();
  e.watch({ kind: 'messages', chatId, limit: 3 }, (p) => m.apply(p));
  for (let i = 1; i <= 5; i++) await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: String(i) });
  const end = Date.now() + 3000;
  while (m.list().map((x) => x.body).join() !== '3,4,5' && Date.now() < end) await Bun.sleep(5);
  expect(m.list().map((x) => x.body)).toEqual(['3', '4', '5']);
  await e.close();
});
