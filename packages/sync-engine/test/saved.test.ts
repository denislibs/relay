import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { Engine } from '../src/engine';
import { Store } from '../src/store';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); e.connect(); await e.whenIdle(); return e; };

test('savedChat: created on demand, the row is ready at once, the same id on the next call, no refresh loop', async () => {
  const a = await srv.login('Анна');
  const e = await open(srv.config(a));
  const list = watchInto(e, { kind: 'chatList', limit: 50 });
  const id = await e.call({ type: 'savedChat' }) as number;
  const rows = await list.until((l) => l.some((c) => c.id === id));
  expect(rows.find((c) => c.id === id)).toMatchObject({ title: 'Избранное', saved: true, peerId: null, peer: null, unread: 0 });
  expect(await e.call({ type: 'savedChat' })).toBe(id);
  expect(e.store.unnamed()).toEqual([]);   // не «чат без имени»: иначе список перечитывался бы при каждом событии
  expect(Store.unnamed({ kind: 'direct', peerId: null, saved: true } as never)).toBe(false);
});

test('a note syncs to the second device through the journal: no unread, no notification, read mark stays out of it', async () => {
  const a = await srv.login('Анна');
  const d1 = await open(srv.config(a)), d2 = await open(srv.config(a));
  const id = await d1.call({ type: 'savedChat' }) as number;
  const list2 = watchInto(d2, { kind: 'chatList', limit: 50 });
  const alerts = watchInto(d2, { kind: 'notifications' });

  await d1.call({ type: 'sendMessage', chatId: id, body: 'с первого' });
  await d1.whenIdle();
  const rows = await list2.until((l) => l.some((c) => c.id === id && (c.last as { body?: string } | null)?.body === 'с первого' && c.saved === true));
  const row = rows.find((c) => c.id === id)!;
  expect(row).toMatchObject({ title: 'Избранное', unread: 0, peerId: null });
  await d2.whenIdle();
  expect(alerts.list()).toEqual([]);
  // и с сервера напрямую (другой клиент): тоже без непрочитанных
  await sendMessage(a.userId, { chatId: id, clientId: crypto.randomUUID(), body: 'с третьего' });
  const again = await list2.until((l) => (l.find((c) => c.id === id)?.last as { body?: string } | null)?.body === 'с третьего');
  expect(again.find((c) => c.id === id)!.unread).toBe(0);
});

test('typing in saved messages is not even sent', async () => {
  const a = await srv.login('Анна');
  const e = await open(srv.config(a));
  const id = await e.call({ type: 'savedChat' }) as number;
  const frames: unknown[] = [];
  const t = (e as unknown as { transport: { send: (f: unknown) => void } }).transport;
  const send = t.send.bind(t);
  t.send = (f) => { frames.push(f); send(f); };
  await e.call({ type: 'typing', chatId: id });
  expect(frames.filter((f) => (f as { op: string }).op === 'typing')).toEqual([]);
});

test('offline: a known chat is returned without the network, an unknown one fails instead of hanging', async () => {
  const a = await srv.login('Анна');
  const cfg = srv.config(a);
  const e = await open(cfg);
  const id = await e.call({ type: 'savedChat' }) as number;
  await e.close(); engines.length = 0;
  // тот же IndexedDB, сервера нет: известный чат — из локальной копии
  const off = await Engine.open({ ...cfg, httpBase: 'http://127.0.0.1:1' });
  engines.push(off);
  expect(await off.call({ type: 'savedChat' })).toBe(id);
  // новый профиль без сети: чата не узнать — ошибка, а не вечное ожидание
  const fresh = await Engine.open({ ...srv.config(a), httpBase: 'http://127.0.0.1:1' });
  engines.push(fresh);
  await expect(fresh.call({ type: 'savedChat' })).rejects.toBeDefined();
});
