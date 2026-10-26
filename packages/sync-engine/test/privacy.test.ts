import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { defaultPrivacy, type PrivacyRules } from '@relay/protocol';
import { blocksView } from '../src/blocks';
import { ProfileCache } from '../src/profile';
import { Engine } from '../src/engine';
import { SettingsCache, settingsView } from '../src/settings';
import { sql } from '../../../apps/server/src/db';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const api = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${srv.base}${path}`, { method, headers: { cookie: `relay_session=${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const privacyOf = (l: { privacy?: unknown }[]) => l[0]?.privacy as PrivacyRules | undefined;

test('settingsView replays privacy ops; settingsChanged without privacy keeps the rules; seq orders sources', () => {
  const c = new SettingsCache();
  const rules = defaultPrivacy();
  rules.lastSeen = { mode: 'nobody', allow: [5], deny: [] };
  c.applyPrivacy(rules, 3);
  // settingsChanged (только уведомления) правила не стирает
  c.apply({ notify: c.base.notify, sessionsTtlDays: 180 }, 4);
  expect(c.base.privacy.lastSeen).toEqual({ mode: 'nobody', allow: [5], deny: [] });
  // запись старее уже применённого — не откатывает
  expect(c.applyPrivacy(defaultPrivacy(), 2)).toBe(false);
  expect(c.base.privacy.lastSeen.mode).toBe('nobody');
  const v = settingsView(c.base, [{ id: 1, key: 'privacy:bio', method: 'PUT', path: '/privacy/bio', body: { mode: 'contacts', allow: [], deny: [7] }, at: 0 }]);
  expect(v.privacy.bio).toEqual({ mode: 'contacts', allow: [], deny: [7] });
  expect(v.privacy.lastSeen).toBe(c.base.privacy.lastSeen);
  expect(settingsView(c.base, [])).toBe(c.base);
  // мусор из старого IDB — умолчания
  expect(SettingsCache.load([{ k: 'settings', v: { base: { notify: {}, privacy: { bio: { mode: 'x' } } }, seq: 1 } }]).base.privacy.bio).toEqual({ mode: 'everyone', allow: [], deny: [] });
});

test('setPrivacy offline is visible at once, survives a restart, is sent on connect; a second session gets privacyChanged', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  await srv.chat(a.token, [a.userId, b.userId]);   // в исключения берутся только знакомые
  const cfg = srv.config(a);
  const e = await open(cfg);
  e.connect(); await e.whenIdle();
  const w = watchInto(e, { kind: 'settings' });
  await w.until((l) => l[0]?.loaded === true);
  expect(privacyOf(w.list())).toEqual(defaultPrivacy());

  e.disconnect();
  await e.call({ type: 'setPrivacy', key: 'lastSeen', mode: 'contacts', deny: [b.userId] });
  await e.call({ type: 'setPrivacy', key: 'lastSeen', mode: 'nobody', allow: [b.userId] });   // схлопывается: уйдёт последнее
  const s = await w.until((l) => privacyOf(l)?.lastSeen.mode === 'nobody');
  expect(s[0]).toMatchObject({ pending: true, privacy: { lastSeen: { mode: 'nobody', allow: [b.userId], deny: [] } } });
  expect((await (await api(a.token, 'GET', '/settings')).json()).privacy.lastSeen.mode).toBe('everyone');

  await e.close(); engines.splice(engines.indexOf(e), 1);
  const cold = await open(cfg);
  const w2 = watchInto(cold, { kind: 'settings' });
  await w2.until((l) => privacyOf(l)?.lastSeen.mode === 'nobody');
  const other = await open(srv.config(a));   // вторая вкладка/устройство
  other.connect(); await other.whenIdle();
  const wo = watchInto(other, { kind: 'settings' });
  await wo.until((l) => l[0]?.loaded === true);

  cold.connect(); await cold.whenIdle();
  expect((await (await api(a.token, 'GET', '/settings')).json()).privacy.lastSeen).toEqual({ mode: 'nobody', allow: [b.userId], deny: [] });
  await w2.until((l) => l[0]?.pending === false);
  const seen = w2.patches.flatMap((p) => (p.op === 'snapshot' ? p.items : p.upsert)).map((it) => (it.privacy as PrivacyRules).lastSeen.mode);
  expect(seen.slice(seen.indexOf('nobody'))).not.toContain('everyone');   // при подтверждении не мигнуло
  await wo.until((l) => privacyOf(l)?.lastSeen.mode === 'nobody');
  // уведомления, изменённые после, правила не откатывают
  await other.call({ type: 'setNotify', notifyType: 'group', muted: true });
  await w2.until((l) => (l[0]?.notify as { group: { muted: boolean } }).group.muted === true);
  expect(privacyOf(w2.list())!.lastSeen.mode).toBe('nobody');
});

test('blocksView: queue over base, newest first; pending flag', () => {
  const u = (id: number) => ({ id, name: 'U' + id, firstName: 'U' + id, lastName: '', username: null, bio: null, birthday: null, phone: null });
  const base = new Map([[1, { userId: 1, user: u(1), at: '2026-01-01T00:00:00.000Z' }], [2, { userId: 2, user: u(2), at: '2026-02-01T00:00:00.000Z' }]]);
  const v = blocksView(base, [
    { id: 1, key: 'block:1', method: 'DELETE', path: '/blocks/1', at: 0 },
    { id: 2, key: 'block:3', method: 'PUT', path: '/blocks/3', at: Date.parse('2026-03-01') },
  ], new Map([[3, u(3)]]));
  expect(v.map((b) => [b.userId, b.pending, b.user.name])).toEqual([[3, true, 'U3'], [2, false, 'U2']]);
});

test('block/unblock: optimistic list, server state, blocksChanged to the second session; blocked viewer sees blocksMe, a send fails with a reason; unblock clears it', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a)), ea2 = await open(srv.config(a)), eb = await open(srv.config(b));
  for (const e of [ea, ea2, eb]) { e.connect(); await e.whenIdle(); }
  const wl = watchInto(ea, { kind: 'blocked' }), wl2 = watchInto(ea2, { kind: 'blocked' });
  await wl.until(() => wl.patches.length > 0);

  ea.disconnect();
  await ea.call({ type: 'block', userId: b.userId });
  const l = await wl.until((x) => x.length === 1);
  expect(l[0]).toMatchObject({ userId: b.userId, name: 'Борис', pending: true });
  ea.connect(); await ea.whenIdle();
  await wl.until((x) => x[0]?.pending === false);
  expect((await (await api(a.token, 'GET', '/blocks')).json()).blocked.map((x: { userId: number }) => x.userId)).toEqual([b.userId]);
  await wl2.until((x) => x.length === 1 && x[0].userId === b.userId);

  // у Бориса профиль Анны — blocksMe: true (сразу, без попытки написать); отправка — отказ с причиной
  const annaB = watchInto(eb, { kind: 'user', userId: a.userId });
  await annaB.until((x) => x[0]?.blocksMe === true);
  const msgs = watchInto(eb, { kind: 'messages', chatId, limit: 50 });
  await eb.call({ type: 'sendMessage', chatId, body: 'привет' });
  const failed = await msgs.until((x) => x.some((m) => m.status === 'failed'));
  expect(failed.find((m) => m.status === 'failed')).toMatchObject({ error: 'blocked', body: 'привет' });
  // правка профиля Анной флаг не снимает
  await api(a.token, 'PATCH', '/me', { bio: 'новое' });
  await eb.whenIdle(); await Bun.sleep(50);
  expect(annaB.list()[0]?.blocksMe).toBe(true);

  // разблокировали: blocksMe снимается, писать снова можно
  await ea.call({ type: 'unblock', userId: b.userId });
  await ea.whenIdle();
  await wl.until((x) => x.length === 0);
  await wl2.until((x) => x.length === 0);
  await annaB.until((x) => x[0]?.blocksMe === false && x[0]?.bio === 'новое');
  await eb.call({ type: 'sendMessage', chatId, body: 'снова' });
  await msgs.until((x) => x.some((m) => m.body === 'снова' && m.status === 'sent'));
});

test('unblock re-reads the person: a profile cached without the photo (old servers sent blocked users without it) gets it back', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  await srv.chat(a.token, [a.userId, b.userId]);
  const photo = { id: 'p-big', small: 'p-small', thumb: '', at: 1, pid: 1 };
  await sql`update users set photo = ${sql.json(photo as never)} where id = ${b.userId}`;
  const ea = await open(srv.config(a));
  ea.connect(); await ea.whenIdle();
  const people = watchInto(ea, { kind: 'people', ids: [b.userId] });
  await people.until((x) => (x[0]?.photo as { small?: string } | null)?.small === 'p-small');
  await ea.call({ type: 'block', userId: b.userId });
  await ea.whenIdle();
  // кэш, испорченный прежним сервером: blocksChanged нёс профиль без фото — с номером записи блокировки
  const store = (ea as unknown as { store: { profile: ProfileCache } }).store;
  const cached = store.profile.users.get(b.userId)!;
  store.profile.applyUser({ ...cached, photo: null }, cached.seq);
  await ea.call({ type: 'unblock', userId: b.userId });
  await ea.whenIdle();
  await people.until((x) => (x[0]?.photo as { small?: string } | null)?.small === 'p-small');
});

test('profile cache: a snapshot or response older than an applied userUpdated does not overwrite it', () => {
  const p = new ProfileCache(1);
  const u = (bio: string) => ({ id: 2, name: 'Б', firstName: 'Б', lastName: '', username: null, bio, birthday: null, phone: null });
  p.applyUser(u('свежее'), 10);
  p.applyUser(u('старое'), 7);
  expect(p.users.get(2)?.bio).toBe('свежее');
  p.applyUser(u('новее'), 12);
  expect(p.users.get(2)?.bio).toBe('новее');
  p.applyUser(u('без seq'));   // GET /users/:id — как раньше
  expect(p.users.get(2)?.bio).toBe('без seq');
});
