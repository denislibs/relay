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
