import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sql } from '../../../apps/server/src/db';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { deleteMessage } from '../../../apps/server/src/domain/messageOps';
import { expireStep } from '../../../apps/server/src/domain/autoDelete';
import { Engine } from '../src/engine';
import { write } from '../src/idb';
import { SCHEMA, SCHEMA_VERSION, STORES } from '../src/schema';
import { PENDING_BASE } from '../src/types';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0], connect = true) => { const e = await Engine.open(cfg); engines.push(e); if (connect) { e.connect(); await e.whenIdle(); } return e; };
const send = (userId: number, chatId: number, body: string, extra: Record<string, unknown> = {}) => sendMessage(userId, { chatId, clientId: crypto.randomUUID(), body, ...extra });

async function world() {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const dm = await srv.chat(a.token, [a.userId, b.userId]);
  const e = await open(srv.config(a));
  const saved = await e.call({ type: 'savedChat' }) as number;
  const fwd = async (body: string) => (await send(a.userId, saved, '', { forward: { chatId: dm, id: (await send(b.userId, dm, body)).message.id } })).message;
  return { a, b, dm, e, saved, fwd };
}
const peers = (l: { peer?: unknown }[]) => l.map((d) => d.peer);

test('list, counters and last follow the journal: new dialog, deletion, empty dialog disappears; second device live', async () => {
  const { a, b, e, saved, fwd } = await world();
  const list = watchInto(e, { kind: 'savedDialogs' });
  const peer = 'u' + b.userId;
  await list.until((l) => l.length === 0);
  const f1 = await fwd('раз');
  await send(a.userId, saved, 'заметка');
  await list.until((l) => l.length === 2);
  expect(peers(list.list())).toEqual(['me', peer]);
  expect(list.item('~saved')).toMatchObject({ total: 2, messages: 2, chatId: saved });
  expect(list.item(peer)).toMatchObject({ count: 1, title: 'Борис', kind: 'user', access: true });
  expect((list.item(peer)!.last as { body: string }).body).toBe('раз');

  const e2 = await open(srv.config(a));
  const list2 = watchInto(e2, { kind: 'savedDialogs' });
  await list2.until((l) => l.length === 2);
  const f2 = await fwd('два');
  await list2.until((l) => (l.find((d) => d.peer === peer)?.count) === 2);
  expect((list2.item(peer)!.last as { body: string }).body).toBe('два');
  expect(list2.item('~saved')).toMatchObject({ messages: 3 });
  // удалили последнее — строка пересчитана; удалили всё — исчезла
  await deleteMessage(a.userId, saved, f2.id);
  await list.until((l) => (l.find((d) => d.peer === peer)?.count) === 1);
  expect((list.item(peer)!.last as { id: number }).id).toBe(f1.id);
  await sql`update messages set expires_at = now() - interval '1 second' where id = ${f1.id}`;
  await expireStep();
  await list2.until((l) => !l.some((d) => d.peer === peer));
  await list.until((l) => !l.some((d) => d.peer === peer));
  expect(list.item('~saved')).toMatchObject({ total: 1, messages: 1 });
});

test('subchat feed: filter of the same cache, own pages when the common feed is short; common feed sees everything', async () => {
  const { a, b, e, saved, fwd } = await world();
  e.disconnect();
  const notes: number[] = [], fwds: number[] = [];
  for (let i = 0; i < 70; i++) notes.push((await send(a.userId, saved, 'н' + i)).message.id);
  for (let i = 0; i < 3; i++) fwds.push((await fwd('п' + i)).id);
  for (let i = 0; i < 60; i++) notes.push((await send(a.userId, saved, 'х' + i)).message.id);
  e.connect(); await e.whenIdle();
  const peer = 'u' + b.userId;
  const sub = watchInto(e, { kind: 'savedFeed', chatId: saved, peer, limit: 50 });
  await sub.until((l) => l.length === 3);
  expect(sub.list().map((m) => m.id)).toEqual(fwds);
  expect(sub.item('~window')).toMatchObject({ hasOlder: false, hasNewer: false, live: true });
  const main = watchInto(e, { kind: 'messages', chatId: saved, limit: 50 });
  await main.until((l) => l.length === 50);
  expect(main.list().every((m) => m.savedPeer === 'me' || m.savedPeer === peer)).toBe(true);
  const my = watchInto(e, { kind: 'savedFeed', chatId: saved, peer: 'me', limit: 20 });
  await my.until((l) => l.length === 20);
  expect(my.list().every((m) => m.savedPeer === 'me')).toBe(true);
  expect(my.item('~window')).toMatchObject({ hasOlder: true });
  // своё сообщение: сразу в подчате заметок (неотправленное), после ответа — то же
  e.disconnect();
  await e.call({ type: 'sendMessage', chatId: saved, body: 'без сети' });
  await my.until((l) => l.some((m) => m.body === 'без сети' && m.id == null));
  const rows = watchInto(e, { kind: 'savedDialogs' });
  await rows.until((l) => (l[0]?.last as { body?: string } | null)?.body === 'без сети');
  e.connect(); await e.whenIdle();
  await my.until((l) => l.some((m) => m.body === 'без сети' && m.id != null));
  expect(sub.list().map((m) => m.id)).toEqual(fwds);
});

test('offline: list and subchat from IndexedDB after a restart', async () => {
  const { a, b, e, saved, fwd } = await world();
  const peer = 'u' + b.userId;
  const list = watchInto(e, { kind: 'savedDialogs' });
  await fwd('раз'); await send(a.userId, saved, 'заметка');
  await list.until((l) => l.length === 2);
  const sub = watchInto(e, { kind: 'savedFeed', chatId: saved, peer, limit: 50 });
  await sub.until((l) => l.length === 1);
  await e.whenIdle();
  const cfg = { ...e['cfg' as never] as Parameters<typeof Engine.open>[0] };
  list.handle.close(); sub.handle.close();
  await e.close(); engines.length = 0;
  const off = await open(cfg, false);
  const list2 = watchInto(off, { kind: 'savedDialogs' });
  await list2.until((l) => l.length === 2);
  expect(list2.item('~saved')).toMatchObject({ loaded: true, total: 2, messages: 2 });
  expect(list2.item(peer)).toMatchObject({ title: 'Борис' });
  const sub2 = watchInto(off, { kind: 'savedFeed', chatId: saved, peer, limit: 50 });
  await sub2.until((l) => l.length === 1);
  expect(sub2.list()[0].body).toBe('раз');
});

test('pin through the op queue: visible at once without network, reaches the server, stays; unpin; other device', async () => {
  const { a, b, e, saved, fwd } = await world();
  const peer = 'u' + b.userId;
  const list = watchInto(e, { kind: 'savedDialogs' });
  await send(a.userId, saved, 'заметка'); await fwd('раз');
  await list.until((l) => l.length === 2);
  e.disconnect();
  await e.call({ type: 'savedDialogPin', peer, pinned: true });
  await list.until((l) => l.find((d) => d.peer === peer)?.pinnedAt != null);
  expect((await sql`select 1 from saved_dialog_pins`).length).toBe(0);
  e.connect(); await e.whenIdle();
  await list.until((l) => l.find((d) => d.peer === peer)?.pinnedAt != null);
  expect((await sql`select peer from saved_dialog_pins where user_id = ${a.userId}`).map((r) => r.peer)).toEqual([peer]);
  const e2 = await open(srv.config(a));
  const list2 = watchInto(e2, { kind: 'savedDialogs' });
  await list2.until((l) => l.find((d) => d.peer === peer)?.pinnedAt != null);
  await e.call({ type: 'savedDialogPin', peer, pinned: false });
  await list2.until((l) => l.find((d) => d.peer === peer)?.pinnedAt == null);
});

test('delete a dialog: row and cache gone at once, works through the queue offline, other device follows', async () => {
  const { a, b, e, saved, fwd } = await world();
  const peer = 'u' + b.userId;
  const list = watchInto(e, { kind: 'savedDialogs' }), main = watchInto(e, { kind: 'messages', chatId: saved, limit: 50 });
  await send(a.userId, saved, 'заметка'); await fwd('раз'); await fwd('два');
  await list.until((l) => l.length === 2);
  await main.until((l) => l.length === 3);
  e.disconnect();
  await e.call({ type: 'savedDialogDelete', peer });
  await list.until((l) => l.length === 1);
  await main.until((l) => l.length === 1);
  expect(list.item('~saved')).toMatchObject({ total: 1, messages: 1 });
  const left = await sql`select count(*)::int as n from messages where chat_id = ${saved} and not deleted`;
  expect(left[0].n).toBe(3);
  const e2 = await open(srv.config(a));
  const list2 = watchInto(e2, { kind: 'savedDialogs' });
  await list2.until((l) => l.length === 2);
  e.connect(); await e.whenIdle();
  expect((await sql`select count(*)::int as n from messages where chat_id = ${saved} and not deleted`)[0].n).toBe(1);
  await list2.until((l) => l.length === 1);
  await list.until((l) => l.length === 1);
});

test('pages: more than one page of dialogs; editing the last message updates the row; a removed dialog does not come back with a stale page', async () => {
  const { a, e, saved, fwd, b } = await world();
  // данные: 105 подчатов прямо в базе (разметка та же, что у вставки)
  for (let i = 1; i <= 105; i++) await sql`insert into messages (chat_id, sender_id, client_id, kind, body, saved_peer) values (${saved}, ${a.userId}, ${crypto.randomUUID()}, 'text', ${'м' + i}, ${'u' + (1000 + i)})`;
  const list = watchInto(e, { kind: 'savedDialogs' });
  await e.call({ type: 'refreshChats' });
  const f = await fwd('свежий');   // событие заводит строку и просит страницу
  await list.until((l) => l.length >= 100 && l[0].peer === 'u' + b.userId && (list.item('~saved') as { total?: number } | undefined)?.total === 106);
  expect(list.item('~saved')).toMatchObject({ total: 106, messages: 106, done: false });
  expect(list.list()[0].peer).toBe('u' + b.userId);
  await e.call({ type: 'loadSavedDialogs' });
  await list.until((l) => l.length === 106);
  expect(list.item('~saved')).toMatchObject({ done: true });
  expect(list.list().at(-1)?.peer).toBe('u1001');
  await sql`select 1`;
  const { editMessage } = await import('../../../apps/server/src/domain/messageOps');
  const note = (await send(a.userId, saved, 'заметка')).message;
  await list.until((l) => l[0].peer === 'me');
  await editMessage(a.userId, saved, note.id, 'правка');
  await list.until((l) => (l[0].last as { body: string }).body === 'правка');
  await deleteMessage(a.userId, saved, f.id);
  await list.until((l) => !l.some((d) => d.peer === 'u' + b.userId));
});

test('schema upgrade from the current version keeps everything; old rows get their subchat by the same rule', async () => {
  const name = 'db-upgrade-' + crypto.randomUUID();
  expect(SCHEMA_VERSION).toBe(9);
  const a = await srv.login('Анна');
  // база версии 8 с чатом «Избранное», строками без savedPeer, очередью и позицией
  // (все хранилища и индексы текущей схемы, кроме нового: так выглядела база до этой версии)
  const v8 = await new Promise<IDBDatabase>((resolve, reject) => {
    const q = indexedDB.open(name, 8);
    q.onupgradeneeded = () => {
      for (const n of STORES) {
        if (n === 'savedDialogs') continue;
        const def = SCHEMA[n] as { keyPath: string | string[]; indexes?: { name: string; keyPath: string | string[] }[] };
        const os = q.result.createObjectStore(n, { keyPath: def.keyPath });
        for (const ix of def.indexes ?? []) os.createIndex(ix.name, ix.keyPath);
      }
    };
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
  const row = (id: number, fwdFrom: unknown) => ({ key: 'k' + id, clientId: 'k' + id, id, chatId: 5, senderId: a.userId, body: 'b' + id, replyToId: null, createdAt: new Date(id * 1000).toISOString(), status: 'sent', sort: id, kind: 'text', ...(fwdFrom ? { fwdFrom } : {}) });
  await write(v8, { put: {
    chats: [
      { id: 5, kind: 'direct', saved: true, lastReadId: 0, unread: 0, knownMaxId: 3, peerReadUpTo: 0, ranges: [[1, 3]], historyStart: true, peerId: null, last: null, lastAt: new Date(3000).toISOString() },
      { id: 6, kind: 'direct', lastReadId: 0, unread: 0, knownMaxId: 0, peerReadUpTo: 0, ranges: [], peerId: 77, last: null, lastAt: new Date(0).toISOString() },
      { id: 7, kind: 'group', group: { title: 'Г' }, lastReadId: 0, unread: 0, knownMaxId: 0, peerReadUpTo: 0, ranges: [], peerId: null, last: null, lastAt: new Date(0).toISOString() },
    ],
    messages: [row(1, null), row(2, { userId: 77, name: 'Б', chatId: 6, messageId: 1, at: '' }), row(3, { userId: 77, name: 'Б', chatId: 7, messageId: 1, at: '' }),
      { ...row(0, null), key: 'u1', clientId: 'u1', id: null, body: 'неотправленное', status: 'pending', sort: PENDING_BASE + 9000 }],
    outbox: [{ clientId: 'u1', chatId: 5, body: 'неотправленное', replyToId: null, createdAt: 9000, failed: false }],
    meta: [{ k: 'pos:5', v: { key: 'k1', sort: 1, offset: 0 } }],
  }, del: {} });
  expect(v8.objectStoreNames.contains('savedDialogs')).toBe(false);
  v8.close();
  const e = await open({ ...srv.config(a, name) }, false);
  expect(e.store.outbox.has('u1')).toBe(true);
  const sub = watchInto(e, { kind: 'savedFeed', chatId: 5, peer: 'u77', limit: 50 });
  await sub.until((l) => l.length === 1);
  expect(sub.list()[0].id).toBe(2);
  const g = watchInto(e, { kind: 'savedFeed', chatId: 5, peer: 'c7', limit: 50 });
  await g.until((l) => l.length === 1);
  const me = watchInto(e, { kind: 'savedFeed', chatId: 5, peer: 'me', limit: 50 });
  await me.until((l) => l.length === 2);   // своё и неотправленное
  const main = watchInto(e, { kind: 'messages', chatId: 5, limit: 50 });
  await main.until((l) => l.length === 4);
  expect(await e.call({ type: 'positions' })).toMatchObject({ 5: { key: 'k1' } });
});
