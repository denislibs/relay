import { afterAll, beforeEach, expect, test } from 'bun:test';
import { EngineClient } from '../src/client';
import { Engine } from '../src/engine';
import { fromMessagePort, HostCore, type FromHost, type ToHost } from '../src/host-core';
import { getAll, openDb, write } from '../src/idb';
import { STORES } from '../src/schema';
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

test('schema v4: every store and index exists', async () => {
  const db = await openDb('schema-fresh-' + crypto.randomUUID());
  for (const s of STORES) expect(db.objectStoreNames.contains(s)).toBe(true);
  const tx = db.transaction(['messages', 'members'], 'readonly');
  expect([...tx.objectStore('messages').indexNames].sort()).toEqual(['byChat', 'byExpiry', 'byTab']);
  expect([...tx.objectStore('members').indexNames]).toEqual(['byChat']);
  db.close();
});

test('upgrade 7 → 8 adds the expiry index and keeps the cache; rows without a term are not in it', async () => {
  const name = 'schema-exp-' + crypto.randomUUID();
  const old = await new Promise<IDBDatabase>((res, rej) => {
    const q = indexedDB.open(name, 7);
    q.onupgradeneeded = () => { const m = q.result.createObjectStore('messages', { keyPath: 'key' }); m.createIndex('byChat', ['chatId', 'sort']); m.createIndex('byTab', ['chatId', 'tab', 'sort']); };
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  await new Promise<void>((res) => { const t = old.transaction('messages', 'readwrite'); t.objectStore('messages').put({ key: 'k1', chatId: 1, sort: 1 }); t.oncomplete = () => res(); });
  old.close();
  const db = await openDb(name);
  const os = db.transaction('messages', 'readwrite').objectStore('messages');
  expect([...os.indexNames]).toContain('byExpiry');
  os.put({ key: 'k2', chatId: 1, sort: 2, expiresAt: 123 });
  await new Promise<void>((res) => { os.transaction.oncomplete = () => res(); });
  const read = db.transaction('messages').objectStore('messages');
  const [all, due] = await Promise.all([new Promise<unknown[]>((r) => { const q = read.getAll(); q.onsuccess = () => r(q.result); }), new Promise<{ key: string }[]>((r) => { const q = read.index('byExpiry').getAll(); q.onsuccess = () => r(q.result); })]);
  expect(all).toHaveLength(2);   // кэш на месте
  expect(due.map((x) => x.key)).toEqual(['k2']);
  db.close();
});

test('upgrade 3 → 4 keeps unsent work and drops the cache', async () => {
  const name = 'schema-up-' + crypto.randomUUID();
  const v3 = await openDb(name, { version: 3 });
  await write(v3, { put: { outbox: [{ clientId: 'c1', chatId: 1, body: 'hi', createdAt: 1 }], blobs: [{ clientId: 'c1' }], ops: [{ id: 'o1' }], pendingReads: [{ chatId: 1 }], chats: [{ id: 1 }], meta: [{ k: 'lastSeq', v: 7 }] }, del: {} });
  v3.close();
  const v4 = await openDb(name);
  expect(await getAll(v4, 'outbox')).toHaveLength(1);
  expect(await getAll(v4, 'blobs')).toHaveLength(1);
  expect(await getAll(v4, 'ops')).toHaveLength(1);
  expect(await getAll(v4, 'pendingReads')).toHaveLength(1);
  expect(await getAll(v4, 'chats')).toHaveLength(0);
  expect(await getAll(v4, 'meta')).toHaveLength(0);
  v4.close();
});
