import { afterAll, beforeEach, expect, test } from 'bun:test';
import { EngineClient } from '../src/client';
import { Engine } from '../src/engine';
import { fromMessagePort, HostCore, type FromHost, type ToHost } from '../src/host-core';
import { openDb } from '../src/idb';
import { resetDb, startTestServer } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
beforeEach(resetDb);

const openRaw = (name: string, version: number) => new Promise<IDBDatabase>((resolve, reject) => {
  const r = indexedDB.open(name, version);
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

test('an upgrade by a newer build is not blocked: the old connection closes on versionchange', async () => {
  const name = 'idb-' + crypto.randomUUID();
  let changed = 0;
  await openDb(name, { onVersionChange: () => { changed++; } });
  const newer = await Promise.race([openRaw(name, 99), Bun.sleep(1000).then(() => null)]);
  expect(newer).not.toBeNull();
  expect(changed).toBe(1);
  newer!.close();
});

test('the host asks every tab to reload when its engine database is upgraded elsewhere', async () => {
  const a = await srv.login('a');
  const cfg = srv.config(a);
  const core = new HostCore({ build: 'v1', open: (c) => Engine.open(c) });
  const ch = new MessageChannel();
  core.attach(fromMessagePort<ToHost, FromHost>(ch.port2));
  const tab = new EngineClient(fromMessagePort<FromHost, ToHost>(ch.port1), 'v1', cfg, { pingMs: 60_000 });
  let reloads = 0;
  tab.onReload(() => { reloads++; });
  await tab.ready;
  const newer = await Promise.race([openRaw(cfg.dbName, 99), Bun.sleep(1000).then(() => null)]);
  expect(newer).not.toBeNull();
  for (let i = 0; i < 100 && !reloads; i++) await Bun.sleep(5);
  expect(reloads).toBe(1);
  newer!.close();
  tab.close();
  await core.close();
  ch.port1.close(); ch.port2.close();
});
