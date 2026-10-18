import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { normalizeSettings, SettingsCache, settingsView } from '../src/settings';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const api = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${srv.base}${path}`, { method, headers: { cookie: `relay_session=${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const op = (key: string, body: unknown) => ({ id: 1, key, method: 'PUT' as const, path: '/x', body, at: 0 });
const DEF = { notify: { direct: { muted: false, preview: true }, group: { muted: false, preview: true } }, sessionsTtlDays: 180 };

test('settingsView replays pending ops over the server base; no ops → same object', () => {
  expect(settingsView(DEF, [])).toBe(DEF);
  const v = settingsView(DEF, [op('notify:group', { muted: true, preview: true }), op('notify:group', { muted: true, preview: false }), op('profile', { x: 1 })]);
  expect(v.notify.group).toEqual({ muted: true, preview: false });
  expect(v.notify.direct).toBe(DEF.notify.direct);
});

test('offline toggle is visible at once, survives a restart, is sent after connect and does not flicker on confirmation', async () => {
  const a = await srv.login('Анна');
  const cfg = srv.config(a);
  const e = await open(cfg);
  e.connect();
  await e.whenIdle();
  const w = watchInto(e, { kind: 'settings' });
  await w.until((l) => l[0]?.loaded === true);

  e.disconnect();
  await e.call({ type: 'setNotify', notifyType: 'group', muted: true });
  await e.call({ type: 'setNotify', notifyType: 'group', preview: false });   // схлопывается в одну операцию, muted не теряется
  const s = await w.until((l) => (l[0]?.notify as { group: { muted: boolean } }).group.muted === true);
  expect(s[0]).toMatchObject({ notify: { group: { muted: true, preview: false }, direct: { muted: false, preview: true } }, pending: true });
  expect((await (await api(a.token, 'GET', '/settings')).json()).notify.group.muted).toBe(false);   // сервер ещё не знает

  await e.close(); engines.splice(engines.indexOf(e), 1);
  const cold = await open(cfg);   // без сети: операция и база в IDB
  const w2 = watchInto(cold, { kind: 'settings' });
  await w2.until((l) => (l[0]?.notify as { group: { muted: boolean } })?.group.muted === true);
  cold.connect();
  await cold.whenIdle();
  expect((await (await api(a.token, 'GET', '/settings')).json()).notify.group).toEqual({ muted: true, preview: false });
  const done = await w2.until((l) => l[0]?.pending === false);
  // после подтверждения значение ни разу не откатывалось к старому
  const seen = w2.patches.flatMap((p) => (p.op === 'snapshot' ? p.items : p.upsert)).map((it) => (it.notify as { group: { muted: boolean } }).group.muted);
  expect(seen.slice(seen.indexOf(true))).not.toContain(false);
  expect(done[0].notify).toMatchObject({ group: { muted: true, preview: false } });
});

test('a change from the second session arrives through the journal; stale server answers do not roll it back', async () => {
  const a = await srv.login('Анна');
  const e1 = await open(srv.config(a)), e2 = await open(srv.config(a));
  e1.connect(); e2.connect();
  await e1.whenIdle(); await e2.whenIdle();
  const w2 = watchInto(e2, { kind: 'settings' });
  await w2.until((l) => l[0]?.loaded === true);
  await e1.call({ type: 'setNotify', notifyType: 'direct', muted: true });
  await w2.until((l) => (l[0]?.notify as { direct: { muted: boolean } }).direct.muted === true);
  await e2.call({ type: 'setNotify', notifyType: 'direct', muted: false });
  await w2.until((l) => (l[0]?.notify as { direct: { muted: boolean } }).direct.muted === false && l[0]?.pending === false);
  expect((await (await api(a.token, 'GET', '/settings')).json()).notify.direct.muted).toBe(false);
});

test('a rejected change rolls back and reports opFailed', async () => {
  const a = await srv.login('Анна');
  const e = await open(srv.config(a));
  e.connect(); await e.whenIdle();
  const w = watchInto(e, { kind: 'settings' });
  await w.until((l) => l[0]?.loaded === true);
  await e.ops.enqueue({ key: 'notify:direct', method: 'PUT', path: '/settings/notify/direct', body: { muted: 'bad' } });
  const ops = watchInto(e, { kind: 'ops' });
  await ops.until((l) => ((l[0]?.failures as unknown[]) ?? []).length === 1);
  await w.until((l) => (l[0]?.notify as { direct: { muted: boolean } }).direct.muted === false && l[0]?.pending === false);
});

test('partial settings from an old cache are completed per kind and never crash the view', () => {
  const old = { notify: { group: { muted: true } } } as never;
  const c = SettingsCache.load([{ k: 'settings', v: { base: old, seq: 3 } }]);
  expect(c.base.notify).toEqual({ direct: { muted: false, preview: true }, group: { muted: true, preview: true } });
  expect(() => settingsView(c.base, [op('notify:direct', { preview: false })])).not.toThrow();
  expect(settingsView(c.base, [op('notify:direct', { preview: false })]).notify.direct).toEqual({ muted: false, preview: false });
  expect(normalizeSettings({} as never).sessionsTtlDays).toBe(180);
  expect(normalizeSettings({ notify: { direct: null } } as never).notify.direct.muted).toBe(false);
});

const FOLDER = { title: 'Работа', emoji: '💼', include: [10], exclude: [], contacts: false, nonContacts: false, groups: true, excludeMuted: false, excludeRead: false };
type F = { id: number; title: string };
const ids = (l: Record<string, unknown>[]) => ((l[0]?.folders ?? []) as F[]).map((f) => f.id);

test('settingsView: folder upsert, delete and order replay over the base in queue order', () => {
  const baseF = { ...DEF, folders: [{ id: 2, ...FOLDER }, { id: 3, ...FOLDER, title: 'Семья' }] };
  const del = { id: 3, key: 'folder:3', method: 'DELETE' as const, path: '/x', at: 0 };
  const v = settingsView(baseF, [op('folder:4', { ...FOLDER, title: 'Новая' }), op('folders:order', { ids: [4, 2] }), op('folder:2', { ...FOLDER, title: 'Офис' }), del]);
  expect(v.folders.map((f) => [f.id, f.title])).toEqual([[4, 'Новая'], [2, 'Офис']]);
  expect(baseF.folders.length).toBe(2);   // база не тронута
});

test('folders: offline edits show at once, survive a restart, reach the server and the second device without flicker', async () => {
  const a = await srv.login('Анна');
  const cfg = srv.config(a);
  const e = await open(cfg);
  e.connect();
  await e.whenIdle();
  const w = watchInto(e, { kind: 'settings' });
  await w.until((l) => l[0]?.loaded === true);

  e.disconnect();
  await e.call({ type: 'saveFolder', folder: { id: 2, ...FOLDER } });
  await e.call({ type: 'saveFolder', folder: { id: 3, ...FOLDER, title: 'Семья' } });
  await e.call({ type: 'reorderFolders', ids: [3, 2] });
  await e.call({ type: 'saveFolder', folder: { id: 2, ...FOLDER, title: 'Офис' } });
  const s = await w.until((l) => ids(l).join() === '3,2' && (l[0].folders as F[])[1].title === 'Офис');
  expect(s[0].pending).toBe(true);

  await e.close(); engines.splice(engines.indexOf(e), 1);
  const cold = await open(cfg);
  const w2 = watchInto(cold, { kind: 'settings' });
  await w2.until((l) => ids(l).join() === '3,2');
  cold.connect();
  await cold.whenIdle();
  const server = await (await api(a.token, 'GET', '/settings')).json();
  expect(server.folders.map((f: F) => [f.id, f.title])).toEqual([[3, 'Семья'], [2, 'Офис']]);
  await w2.until((l) => l[0]?.pending === false);
  // порядок ни разу не откатывался после того, как стал 3,2
  const orders = w2.patches.flatMap((p) => (p.op === 'snapshot' ? p.items : p.upsert)).map((it) => ((it.folders ?? []) as F[]).map((f) => f.id).join());
  expect(orders.slice(orders.indexOf('3,2')).every((o) => o === '3,2')).toBe(true);

  // второе устройство: удаление приходит журналом
  const other = await open(srv.config(a));
  other.connect();
  await other.whenIdle();
  const w3 = watchInto(other, { kind: 'settings' });
  await w3.until((l) => ids(l).join() === '3,2');
  await cold.call({ type: 'deleteFolder', id: 3 });
  await w3.until((l) => ids(l).join() === '2');
});
