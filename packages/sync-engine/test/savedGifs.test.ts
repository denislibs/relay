import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import type { SavedGif } from '@relay/protocol';
import { sql } from '../../../apps/server/src/db';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
type List = { list: SavedGif[]; loaded: boolean };
const THUMB = 'data:image/jpeg;base64,QUJDRA==';

/** Вложение-GIF в сообщении a → чат с b. */
async function gifMessage(from: number, chatId: number) {
  const [{ id }] = await sql`insert into attachments (owner_id, mime, name, size, status, kind, width, height) values (${from}, 'image/gif', 'a.gif', 10, 'ready', 'photo', 64, 48) returning id`;
  const { message } = await sendMessage(from, { chatId, clientId: crypto.randomUUID(), body: '', attachment: { id: id as string, thumb: THUMB } });
  const gif = { ...message.attachment!, savedAt: 0 } as SavedGif;
  return { id: id as string, messageId: message.id, gif };
}
const list = (e: Engine) => e.call({ type: 'savedGifs' }) as Promise<List>;
const ids = (l: List) => l.list.map((g) => g.id);
/** Дождаться, пока список станет таким: чтение отвечает из кэша, сервер — в фоне. */
async function until(e: Engine, want: string[]) {
  for (let i = 0; i < 100; i++) {
    const l = await list(e);
    if (JSON.stringify(ids(l)) === JSON.stringify(want)) return l;
    await Bun.sleep(30);
  }
  throw new Error(`gifs: want ${want}, got ${ids(await list(e))}`);
}

test('offline: saving and removing apply at once, survive a restart, and reach the server when the network is back', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const g1 = await gifMessage(a.userId, chatId), g2 = await gifMessage(a.userId, chatId);
  const cfg = srv.config(b);
  const e1 = await open(cfg);
  e1.connect(); await e1.whenIdle();
  await e1.call({ type: 'saveGif', chatId, messageId: g1.messageId, gif: g1.gif });
  await e1.whenIdle();
  expect(await sql`select attachment_id from saved_gifs`).toHaveLength(1);
  e1.disconnect();
  await e1.call({ type: 'saveGif', chatId, messageId: g2.messageId, gif: g2.gif });
  await e1.call({ type: 'removeGif', id: g1.id });
  const off = await list(e1);
  expect(ids(off)).toEqual([g2.id]);
  expect(off.list[0].thumb).toBe(THUMB);   // миниатюра есть до ответа сервера
  await e1.close(); engines.length = 0;

  // перезапуск без сети: правки в кэше, операции в очереди
  const e2 = await open(cfg);
  expect(ids(await list(e2))).toEqual([g2.id]);
  expect((await list(e2)).loaded).toBe(true);
  e2.connect(); await e2.whenIdle();
  await until(e2, [g2.id]);
  const rows = await sql`select attachment_id from saved_gifs where user_id = ${b.userId}`;
  expect(rows.map((r) => r.attachment_id)).toEqual([g2.id]);
});

test('second device: learns from the journal, gets the file key once, and keeps showing the list offline', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const g = await gifMessage(a.userId, chatId);
  const e1 = await open(srv.config(b));
  const e2 = await open({ ...srv.config(b), dbName: srv.config(b).dbName + '-2' });
  e1.connect(); e2.connect();
  await e1.whenIdle(); await e2.whenIdle();
  expect(ids(await until(e2, []))).toEqual([]);
  const st = watchInto(e2, { kind: 'status' });
  const before = (st.list[0]?.gifsRev as number) ?? 0;
  await e1.call({ type: 'saveGif', chatId, messageId: g.messageId, gif: g.gif });
  await st.until((l) => (l[0]?.gifsRev as number) > before);
  const l2 = await until(e2, [g.id]);
  expect(l2.list[0]).toMatchObject({ id: g.id, mime: 'image/gif', w: 64, h: 48 });
  e2.disconnect();
  expect(ids(await list(e2))).toEqual([g.id]);
  e2.connect(); await e2.whenIdle();
  await e1.call({ type: 'removeGif', id: g.id });
  await until(e2, []);
});

test('the server refuses (protected chat): the optimistic tile goes away, the failure is reported', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const g = await gifMessage(a.userId, chatId);
  await sql`update chats set protected = true where id = ${chatId}`;
  const e = await open(srv.config(b));
  e.connect(); await e.whenIdle();
  await until(e, []);
  e.disconnect();
  await e.call({ type: 'saveGif', chatId, messageId: g.messageId, gif: g.gif });
  expect(ids(await list(e))).toEqual([g.id]);
  e.connect(); await e.whenIdle();
  await until(e, []);
  expect(await sql`select 1 from saved_gifs`).toHaveLength(0);
});

test('a saved GIF is sent like any attachment: pending at once, no upload, with the reply', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const g = await gifMessage(a.userId, chatId);
  const e = await open(srv.config(b));
  e.connect(); await e.whenIdle();
  await e.call({ type: 'saveGif', chatId, messageId: g.messageId, gif: g.gif });
  await e.whenIdle();
  const [saved] = (await until(e, [g.id])).list;
  e.disconnect();
  const feed = watchInto(e, { kind: 'messages', chatId, limit: 50 });
  await e.call({ type: 'sendMessage', chatId, body: '', attachment: saved, replyToId: g.messageId, keepDraft: true });
  const l = await feed.until((x) => x.some((m) => m.status === 'pending'));
  expect(l.find((m) => m.status === 'pending')).toMatchObject({ kind: 'photo', attachment: { id: g.id, mime: 'image/gif' }, replyToId: g.messageId });
  e.connect(); await e.whenIdle();
  await feed.until((x) => x.every((m) => m.status !== 'pending'));
  const rows = await sql`select attachment->>'id' as aid, reply_to_id from messages where chat_id = ${chatId} and sender_id = ${b.userId}`;
  expect(rows).toEqual([{ aid: g.id, reply_to_id: g.messageId }]);
});

test('an expired message does not take the file of a saved GIF off the device', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const g = await gifMessage(a.userId, chatId);
  const e = await open(srv.config(b));
  e.connect(); await e.whenIdle();
  await e.call({ type: 'saveGif', chatId, messageId: g.messageId, gif: g.gif });
  await e.whenIdle();
  const internal = e as unknown as { store: { expiredFiles: Set<string> }; statusItem(): { expiredFiles: string[] } };
  internal.store.expiredFiles.add(g.id);
  internal.store.expiredFiles.add('other');
  expect(internal.statusItem().expiredFiles).toEqual(['other']);
});
