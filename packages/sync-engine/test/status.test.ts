import { sql } from '../../../apps/server/src/db';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };

test('status query follows the connection and counts unsent messages', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  const st = watchInto(ea, { kind: 'status' });
  await st.until((l) => l[0]?.online === false);
  await ea.call({ type: 'sendMessage', chatId, body: 'офлайн' });
  await st.until((l) => l[0].outbox === 1);
  ea.connect();
  await st.until((l) => l[0].online === true && l[0].synced === true && l[0].outbox === 0);
  ea.disconnect();
  await st.until((l) => l[0].online === false && l[0].synced === false);
});

test('a chat first seen through a message gets its name from the server', async () => {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const eb = await open(srv.config(b));
  eb.connect();
  await eb.whenIdle();
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);   // чат создан после снимка
  await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'привет' });
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  const l = await list.until((x) => x.length === 1 && x[0].title === 'Анна');
  expect(l[0]).toMatchObject({ unread: 1, peerId: a.userId });
});

test('snapshot brings the peer read pointer, so my old messages show as read', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const { message } = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'давно' });
  const { markRead } = await import('../../../apps/server/src/domain/reads');
  await markRead(b.userId, chatId, message.id);
  const ea = await open(srv.config(a));          // первый вход A — через снимок
  ea.connect();
  const list = watchInto(ea, { kind: 'chatList', limit: 50 });
  await list.until((l) => (l[0]?.last as { status: string } | null)?.status === 'read');
});

test('status phase: connecting right after connect, ready when synced; the cache stays hydrated across restarts', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  await srv.chat(a.token, [a.userId, b.userId]);
  const cfg = srv.config(a);
  const ea = await open(cfg);
  expect(ea.status()).toMatchObject({ phase: 'offline', hydrated: false }); // подключаться ещё не просили
  ea.connect();
  expect(ea.status().phase).toBe('connecting');
  const st = watchInto(ea, { kind: 'status' });
  await st.until((l) => l[0]?.phase === 'ready' && l[0].hydrated === true);
  await ea.close();
  const again = await open(cfg);                  // перезагрузка страницы: тот же IndexedDB
  expect(again.status()).toMatchObject({ phase: 'offline', hydrated: true });
  again.connect();
  await watchInto(again, { kind: 'status' }).until((l) => l[0]?.phase === 'ready');
});

test('status phase turns offline once connection attempts keep failing', async () => {
  const a = await srv.login('a');
  const ea = await open({ ...srv.config(a), wsUrl: 'ws://127.0.0.1:1/ws', backoffMs: [10, 20] });
  const st = watchInto(ea, { kind: 'status' });
  ea.connect();
  await st.until((l) => l[0]?.phase === 'offline' && l[0].online === false);
});

test('catch-up after reconnect reaches the UI as one batch, not page by page', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chats = [];
  for (let i = 0; i < 3; i++) chats.push(await srv.chat(a.token, [a.userId, b.userId]));
  const ea = await open({ ...srv.config(a), frameMs: 1 });   // кадр 1 мс: без удержания каждая страница ушла бы отдельно
  ea.connect();
  const list = watchInto(ea, { kind: 'chatList', limit: 50 });
  await list.until((l) => l.length === 3);
  await ea.whenIdle();
  ea.disconnect();
  for (let i = 0; i < 300; i++) await sendMessage(b.userId, { chatId: chats[i % 3], clientId: crypto.randomUUID(), body: 'm' + i });
  process.env.RELAY_SYNC_BATCH = '20';               // 15 страниц журнала
  const before = list.patches.length;
  const st = watchInto(ea, { kind: 'status' });
  await st.until((l) => l[0]?.phase === 'offline');
  ea.connect();
  await list.until((l) => l.reduce((s, c) => s + (c.unread as number), 0) === 300, 8000).finally(() => { delete process.env.RELAY_SYNC_BATCH; });
  await Bun.sleep(50);
  expect(list.patches.length - before).toBe(1);
  const phases = st.patches.flatMap((p) => (p.op === 'snapshot' ? p.items : p.upsert)).map((i) => i.phase);
  expect(phases).toEqual(expect.arrayContaining(['offline', 'updating', 'ready']));   // стадия догонки видна, даже если она короче кадра
}, 30000);

test('opening a chat: the first feed patch is already complete (no empty or partial frames)', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  for (let i = 0; i < 80; i++) await sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body: 'h' + i });
  const ea = await open({ ...srv.config(a), frameMs: 1, historyPage: 30 });
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 60 });
  await feed.until((l) => l.length === 60);
  expect(feed.patches[0].op).toBe('snapshot');
  expect((feed.patches[0] as { items: { key: string }[] }).items.filter((i) => !i.key.startsWith('~')).length).toBe(60);
});

test('presence: the peer goes online and offline; unknown while disconnected', async () => {
  process.env.RELAY_PRESENCE_GRACE_MS = '40';
  const a = await srv.login('a'), b = await srv.login('b');
  await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  const p = watchInto(ea, { kind: 'presence', userId: b.userId });
  await p.until((l) => l[0]?.known === false);
  ea.connect();
  await p.until((l) => l[0].known === true && l[0].online === false);       // снимок: b ещё не заходил
  const eb = await open(srv.config(b));
  eb.connect();
  await p.until((l) => l[0].online === true);                                 // живой кадр
  await eb.close();
  await p.until((l) => l[0].online === false && typeof l[0].lastSeen === 'string');
  ea.disconnect();
  await p.until((l) => l[0].known === false);
  delete process.env.RELAY_PRESENCE_GRACE_MS;
});

test('dialogs load in pages: first page + every unread chat, then more on demand until complete', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const ids: number[] = [];
  for (let i = 0; i < 7; i++) {
    const id = await srv.chat(a.token, [a.userId, b.userId]);
    ids.push(id);
    // самый старый чат — непрочитанный (пишет b), остальные — мои сообщения
    await sendMessage(i === 0 ? b.userId : a.userId, { chatId: id, clientId: crypto.randomUUID(), body: 'm' + i });
  }
  const ea = await open({ ...srv.config(a), dialogsPage: 3 });
  const list = watchInto(ea, { kind: 'chatList', limit: 100 });
  const st = watchInto(ea, { kind: 'status' });
  ea.connect();
  await list.until((l) => l.length === 4);                      // страница (6,5,4) + непрочитанный 0
  expect(list.list().map((c) => c.id)).toEqual([ids[6], ids[5], ids[4], ids[0]]);
  expect(st.list()[0].chatsComplete).toBe(false);
  await ea.call({ type: 'loadMoreChats' });
  await list.until((l) => l.length === 7);
  await ea.call({ type: 'loadMoreChats' });                      // последняя страница: только 0, он уже есть
  await st.until((l) => l[0].chatsComplete === true);
  expect(list.list().map((c) => c.id)).toEqual([...ids].reverse());
});

test('drafts: saved per chat, lift the chat in the list, survive a restart, cleared on send', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const older = await srv.chat(a.token, [a.userId, b.userId]);
  await sendMessage(b.userId, { chatId: older, clientId: crypto.randomUUID(), body: 'старое' });
  const newer = await srv.chat(a.token, [a.userId, b.userId]);
  await sendMessage(b.userId, { chatId: newer, clientId: crypto.randomUUID(), body: 'новое' });
  const cfg = srv.config(a);
  const ea = await open(cfg);
  ea.connect();
  const list = watchInto(ea, { kind: 'chatList', limit: 10 });
  await list.until((l) => l.length === 2 && l[0].id === newer);

  await ea.call({ type: 'setDraft', chatId: older, text: 'недописанное' });
  await list.until((l) => l[0].id === older && l[0].draft === 'недописанное');   // черновик поднял чат

  await ea.close();
  const again = await open(cfg);                                            // перезагрузка: тот же IndexedDB
  const list2 = watchInto(again, { kind: 'chatList', limit: 10 });
  await list2.until((l) => l.find((c) => c.id === older)?.draft === 'недописанное');

  await again.call({ type: 'sendMessage', chatId: older, body: 'недописанное' });
  await list2.until((l) => l.find((c) => c.id === older)?.draft === null);
  await again.call({ type: 'setDraft', chatId: newer, text: '   ' });         // пробелы — не черновик
  expect(list2.list().find((c) => c.id === newer)?.draft).toBeNull();
});

test('feed window: anchored by sort (end/start/center), loads history under it, reports edges', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ids: number[] = [];
  for (let i = 0; i < 120; i++) ids.push((await sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body: 'm' + i })).message.id);
  const ea = await open({ ...srv.config(a), historyPage: 20 });
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 30 });
  await feed.until((l) => l.length === 30);
  expect(feed.list().at(-1)!.id).toBe(ids[119]);
  const meta = () => feed.patches.flatMap((p) => (p.op === 'snapshot' ? p.items : p.upsert)).filter((i) => i.key === '~window').at(-1)!;
  expect(meta()).toMatchObject({ hasOlder: true, hasNewer: false, live: true });

  feed.handle.update({ kind: 'messages', chatId, limit: 30, anchor: { sort: ids[10], side: 'center' } });   // далеко в истории
  await feed.until((l) => l.length === 30 && l.some((m) => m.id === ids[10]), 5000);
  expect(meta()).toMatchObject({ hasNewer: true, live: false });

  feed.handle.update({ kind: 'messages', chatId, limit: 30, anchor: { sort: ids[29], side: 'end' } });
  await feed.until((l) => l.at(-1)?.id === ids[29] && l[0].id === ids[0]);
  feed.handle.update({ kind: 'messages', chatId, limit: 30, anchor: { sort: ids[100], side: 'start' } });
  await feed.until((l) => l[0]?.id === ids[100] && l.length === 20);           // до хвоста осталось 20
  expect(meta()).toMatchObject({ hasNewer: false, live: true });
}, 20000);

test('epoch: the server database was recreated — the client drops its stale cache and starts over', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const stale = await srv.chat(a.token, [a.userId, b.userId]);
  const cfg = srv.config(a);
  const ea = await open(cfg);
  ea.connect();
  const list = watchInto(ea, { kind: 'chatList', limit: 10 });
  await list.until((l) => l.length === 1 && l[0].id === stale);
  await ea.close();
  // «пересоздали базу»: чата больше нет, поколение другое
  await sql`delete from chats where id = ${stale}`;
  const { bumpEpoch } = await import('../../../apps/server/src/domain/epoch');
  await bumpEpoch();
  const again = await open(cfg);
  const list2 = watchInto(again, { kind: 'chatList', limit: 10 });
  await list2.until((l) => l.length === 1);      // из кэша — старый чат
  again.connect();
  await list2.until((l) => l.length === 0);      // поколение сменилось — кэш выброшен
});

test('typing: shows on the peer side, fades after typingMs, clears when the message arrives', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a));
  const eb = await open({ ...srv.config(b), typingMs: 150 });
  ea.connect(); eb.connect();
  await ea.whenIdle(); await eb.whenIdle();
  const list = watchInto(eb, { kind: 'chatList', limit: 10 });
  await list.until((l) => l.length === 1);
  await ea.call({ type: 'typing', chatId });
  await list.until((l) => l[0].typing === true);
  await list.until((l) => l[0].typing === false, 2000);            // погасло само
  await ea.call({ type: 'typing', chatId });
  await list.until((l) => l[0].typing === true);
  await ea.call({ type: 'sendMessage', chatId, body: 'готово' });
  await list.until((l) => l[0].typing === false && (l[0].last as { body: string } | null)?.body === 'готово');
});

test('drafts sync between devices of the same user through the journal', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const phone = await open(srv.config(a)), laptop = await open(srv.config(a));
  phone.connect(); laptop.connect();
  await phone.whenIdle(); await laptop.whenIdle();
  const onLaptop = watchInto(laptop, { kind: 'chatList', limit: 10 });
  await onLaptop.until((l) => l.length === 1);
  await phone.call({ type: 'setDraft', chatId, text: 'начал на телефоне' });
  await onLaptop.until((l) => l[0].draft === 'начал на телефоне');
  await laptop.call({ type: 'sendMessage', chatId, body: 'дописал на ноутбуке' });
  const onPhone = watchInto(phone, { kind: 'chatList', limit: 10 });
  await onPhone.until((l) => l[0]?.draft === null && (l[0].last as { body: string } | null)?.body === 'дописал на ноутбуке');
});

test('edit, delete and reactions reach the other side through the journal', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a)), eb = await open(srv.config(b));
  ea.connect(); eb.connect();
  await ea.call({ type: 'sendMessage', chatId, body: 'опечатка' });
  await ea.whenIdle(); await eb.whenIdle();
  const feedB = watchInto(eb, { kind: 'messages', chatId, limit: 20 });
  const m = (await feedB.until((l) => l.length === 1 && l[0].id != null))[0];
  await ea.call({ type: 'editMessage', chatId, id: m.id as number, body: 'исправлено' });
  await feedB.until((l) => l[0].body === 'исправлено' && !!l[0].editedAt);
  await eb.call({ type: 'react', chatId, id: m.id as number, emoji: '👍' });
  await feedB.until((l) => (l[0].reactions as { emoji: string }[]).length === 1);   // у себя — сразу
  const feedA = watchInto(ea, { kind: 'messages', chatId, limit: 20 });
  await feedA.until((l) => (l[0]?.reactions as { emoji: string }[] | undefined)?.[0]?.emoji === '👍');
  await ea.call({ type: 'deleteMessage', chatId, id: m.id as number });
  await feedB.until((l) => l[0].deleted === true && l[0].body === '');
  const listB = watchInto(eb, { kind: 'chatList', limit: 5 });
  await listB.until((l) => (l[0]?.last as { deleted: boolean } | null)?.deleted === true);
});

test('search: server when online, cached messages when offline', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  for (const body of ['обсудим отпуск', 'про отпуск позже', 'ничего']) await sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body });
  const ea = await open(srv.config(a));
  ea.connect();
  await ea.whenIdle();
  const online = (await ea.call({ type: 'search', q: 'ОТПУСК' })) as { hits: { body: string; chatTitle: string }[]; source: string };
  expect(online.source).toBe('server');
  expect(online.hits.map((h) => h.body)).toEqual(['про отпуск позже', 'обсудим отпуск']);
  expect(online.hits[0].chatTitle).toBe('b');
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 10 });   // сообщения попадают в кэш
  await feed.until((l) => l.length === 3);
  await ea.whenIdle();
  ea.disconnect();
  const offline = (await ea.call({ type: 'search', q: 'отпуск', chatId })) as { hits: { body: string }[]; source: string };
  expect(offline.source).toBe('local');
  expect(offline.hits.map((h) => h.body)).toEqual(['про отпуск позже', 'обсудим отпуск']);
});

test('sendFile: the blob waits in IndexedDB, uploads when online, the message carries the attachment', async () => {
  process.env.FILES_DIR = '/tmp/relay-test-files';
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const ea = await open(srv.config(a)), eb = await open(srv.config(b));
  eb.connect();
  // офлайн: сообщение уже в ленте с вложением без id
  await ea.call({ type: 'sendFile', chatId, body: 'смотри', file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }), name: 'p.png', mime: 'image/png', w: 40, h: 30, thumb: null });
  const feedA = watchInto(ea, { kind: 'messages', chatId, limit: 10 });
  const pending = (await feedA.until((l) => l.length === 1))[0];
  expect(pending).toMatchObject({ status: 'pending', kind: 'photo', attachment: { id: '', w: 40, h: 30, name: 'p.png' } });
  ea.connect();
  await feedA.until((l) => l[0].status === 'sent' && !!(l[0].attachment as { id: string }).id);
  const feedB = watchInto(eb, { kind: 'messages', chatId, limit: 10 });
  const got = (await feedB.until((l) => l.length === 1))[0];
  expect(got).toMatchObject({ kind: 'photo', body: 'смотри', attachment: { w: 40, h: 30, mime: 'image/png', size: 4 } });
});
