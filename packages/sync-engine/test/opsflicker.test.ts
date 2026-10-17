import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Engine } from '../src/engine';
import { SettingsCache } from '../src/settings';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });

/** Задержать запись удаления операции из IDB (ops: del), пока не откроем ворота. */
function gateOpsDelete(e: Engine) {
  const ops = e.ops as unknown as { db: IDBDatabase };
  const real = ops.db;
  let release: (() => void) | null = null;
  let held = false;
  ops.db = new Proxy(real, {
    get(t, p) {
      if (p !== 'transaction') { const v = Reflect.get(t, p); return typeof v === 'function' ? v.bind(t) : v; }
      return (names: string[] | string, mode: IDBTransactionMode) => {
        const list = Array.isArray(names) ? names : [names];
        if (held || list.length !== 1 || list[0] !== 'ops') return t.transaction(names, mode);
        held = true;
        const keys: IDBValidKey[] = [];
        const fake = {
          oncomplete: null as null | (() => void), onerror: null, onabort: null, error: null,
          objectStore: () => ({ put: () => {}, delete: (k: IDBValidKey) => { keys.push(k); } }),
        };
        release = () => {
          const tx = t.transaction('ops', 'readwrite');
          for (const k of keys) tx.objectStore('ops').delete(k);
          tx.oncomplete = () => fake.oncomplete?.();
        };
        return fake as unknown as IDBTransaction;
      };
    },
  });
  return { held: () => held && !!release, open: () => release?.() };
}

test('ops: a 2xx becomes the new base in the same step the op leaves the queue (no flicker while IDB writes)', async () => {
  const a = await srv.login('Анна');
  const e = await Engine.open(srv.config(a)); engines.push(e);
  e.connect();
  await e.whenIdle();
  const w = watchInto(e, { kind: 'settings' });
  await w.until((l) => l[0]?.loaded === true);
  e.disconnect();
  await e.call({ type: 'setNotify', notifyType: 'group', muted: true });
  await w.until((l) => (l[0]?.notify as { group: { muted: boolean } }).group.muted === true);

  const gate = gateOpsDelete(e);
  // журнал не догоняем после готовности: в окне записи база может прийти только из ответа операции
  const tr = (e as unknown as { transport: { send(f: { op: string }): boolean } }).transport;
  const send = tr.send.bind(tr);
  let journal = false;
  const later: { op: string }[] = [];
  tr.send = (f) => { if (f.op === 'sync' && e.status().synced && !journal) { later.push(f); return true; } return send(f); };
  e.connect();
  const end = Date.now() + 3000;
  while (!gate.held() && Date.now() < end) await Bun.sleep(2);
  expect(gate.held()).toBe(true);   // сервер ответил, удаление операции из IDB висит
  // окно записи: любой другой источник помечает настройки (снимок GET /settings, journal) — интерфейс пересчитывает вид
  e.store.settings.dirty = true;
  (e as unknown as { changed(): void }).changed();
  await Bun.sleep(60);
  const muted = w.patches.flatMap((p) => (p.op === 'snapshot' ? p.items : p.upsert)).map((it) => (it.notify as { group: { muted: boolean } }).group.muted);
  expect(muted.slice(muted.indexOf(true))).not.toContain(false);
  journal = true;
  for (const f of later.splice(0)) send(f);
  gate.open();
  await e.whenIdle();
  expect(e.ops.list.length).toBe(0);
  expect((w.list()[0].notify as { group: { muted: boolean } }).group.muted).toBe(true);
});

test('caches do not mark dirty when seq and data are unchanged', () => {
  const c = new SettingsCache();
  const s = { notify: { direct: { muted: false, preview: true }, group: { muted: true, preview: true } }, sessionsTtlDays: 180 };
  expect(c.apply(s, 3)).toBe(true);
  c.dirty = false;
  expect(c.apply(s, 3)).toBe(false);
  expect(c.dirty).toBe(false);
  expect(c.apply(s, 4)).toBe(false);   // новее, но то же самое: seq запоминается, подписки не трогаем
  expect(c.dirty).toBe(false);
  expect(c.seq).toBe(4);
  expect(c.apply({ ...s, sessionsTtlDays: 30 }, 5)).toBe(true);
  expect(c.dirty).toBe(true);
});
