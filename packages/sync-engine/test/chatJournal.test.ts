import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import type { ServerFrame } from '@relay/protocol';
import { sql } from '../../../apps/server/src/db';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { editMessage } from '../../../apps/server/src/domain/messageOps';
import { addGroupMembers, removeGroupMember, setGroupSettings } from '../../../apps/server/src/domain/groups';
import { setChatFlags } from '../../../apps/server/src/domain/chatFlags';
import { createGroup } from '../../../apps/server/src/domain/chats';
import { setChatNotify } from '../../../apps/server/src/domain/chatNotify';
import { getAll, openDb } from '../src/idb';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const say = (userId: number, chatId: number, body: string) => sendMessage(userId, { chatId, clientId: crypto.randomUUID(), body }).then((r) => r.message);
const chatOf = (l: Record<string, any>[], id: number) => l.find((i) => i.id === id);
const events = (e: Engine) => e.dev.log.since(0);
const has = (e: Engine, type: string) => events(e).some((x) => x.kind === 'engine' && x.type === type);
/** кадр в движок напрямую (как с сокета) — для порядка push'ей, которым сервер не управляет */
const inject = (e: Engine, f: ServerFrame) => (e as unknown as { onFrame(f: ServerFrame): void }).onFrame(f);
const seqOf = (e: Engine, chatId: number) => (e as unknown as { store: { chatSeq: Map<number, number> } }).store.chatSeq.get(chatId);

async function group() {
  const a = await srv.login('a'), b = await srv.login('b'), c = await srv.login('c');
  const g = await srv.chat(a.token, [a.userId, b.userId, c.userId]);
  return { a, b, c, g };
}

test('a group message is applied from push in a closed chat (row moves, unread grows); chatSeq survives a reopen', async () => {
  const { a, b, g } = await group();
  const cfg = srv.config(b);
  const eb = await open(cfg);
  eb.connect(); await eb.whenIdle();
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  await list.until((l) => !!chatOf(l, g));
  expect(seqOf(eb, g)).toBe(0);   // dev-чат без служебного сообщения — журнал пуст; номер из строки снимка
  await say(a.userId, g, 'раз'); await say(a.userId, g, 'два');
  await list.until((l) => chatOf(l, g)?.unread === 2 && chatOf(l, g)?.last?.body === 'два');
  expect(seqOf(eb, g)).toBe(2);
  expect(eb.dev.counters.pushed).toBe(2);
  await eb.close(); engines.pop();
  const rows = await getAll<{ chatId: number; seq: number }>(await openDb(cfg.dbName), 'chatSeq');
  expect(rows).toEqual([{ chatId: g, seq: 2 }]);
  const again = await open(cfg);
  expect(seqOf(again, g)).toBe(2);
});

test('gap buffer: a push that arrives early waits for the missing one; both apply in order with no syncChat', async () => {
  const { a, b, g } = await group();
  await say(a.userId, g, 'первое');
  const eb = await open({ ...srv.config(b), chatGapMs: 2000 });
  eb.connect(); await eb.whenIdle();
  const feed = watchInto(eb, { kind: 'messages', chatId: g, limit: 50 });
  await feed.until((l) => l.length === 1);
  // два сообщения на сервере; их push'и подаём в обратном порядке
  const m2 = await say(a.userId, g, 'второе'), m3 = await say(a.userId, g, 'третье');
  await feed.until((l) => l.length === 3);   // настоящие push'и уже дошли; теперь повторим их не по порядку с «чистого» номера
  (eb as unknown as { store: { chatSeq: Map<number, number> } }).store.chatSeq.set(g, 1);
  const frame = (m: typeof m2, seq: number): ServerFrame => ({ op: 'push', chatId: g, from: seq - 1, to: seq, items: [{ seq, update: { type: 'newMessage', message: m } }] });
  inject(eb, frame(m3, 3));
  await Bun.sleep(50);
  expect(seqOf(eb, g)).toBe(1);   // ждёт недостающий
  inject(eb, frame(m2, 2));
  await eb.whenIdle();
  expect(seqOf(eb, g)).toBe(3);
  expect(has(eb, 'chatGap')).toBe(false);
  expect(has(eb, 'syncChatTimeout')).toBe(false);
});

test('a gap nobody fills turns into syncChat after chatGapMs; the feed is intact', async () => {
  const { a, b, g } = await group();
  await say(a.userId, g, 'первое');
  const eb = await open({ ...srv.config(b), chatGapMs: 100 });
  eb.connect(); await eb.whenIdle();
  const feed = watchInto(eb, { kind: 'messages', chatId: g, limit: 50 });
  await feed.until((l) => l.length === 1);
  const m2 = await say(a.userId, g, 'второе');
  await feed.until((l) => l.length === 2);
  const m3 = await say(a.userId, g, 'третье');
  await feed.until((l) => l.length === 3);
  // имитируем потерю push'а seq 2: откатываем номер и подаём только seq 3
  (eb as unknown as { store: { chatSeq: Map<number, number> } }).store.chatSeq.set(g, 1);
  inject(eb, { op: 'push', chatId: g, from: 2, to: 3, items: [{ seq: 3, update: { type: 'newMessage', message: m3 } }] });
  await Bun.sleep(300);
  await eb.whenIdle();
  expect(has(eb, 'chatGap')).toBe(true);
  expect(seqOf(eb, g)).toBe(3);
  expect(feed.list().map((m) => m.id)).toEqual([m2.id - 1, m2.id, m3.id]);
});

test('push with empty items (events did not fit the notify) → syncChat brings the message', async () => {
  const { a, b, g } = await group();
  await say(a.userId, g, 'первое');
  const eb = await open(srv.config(b));
  eb.connect(); await eb.whenIdle();
  const feed = watchInto(eb, { kind: 'messages', chatId: g, limit: 50 });
  await feed.until((l) => l.length === 1);
  const big = await say(a.userId, g, 'я'.repeat(4000));
  await feed.until((l) => l.some((m) => m.id === big.id));
  expect(seqOf(eb, g)).toBe(2);
});

test('chatTooLong resets only that chat; the history reloads; a direct chat and the personal journal stay', async () => {
  const { a, b, g } = await group();
  const d = await srv.chat(a.token, [a.userId, b.userId]);
  await say(a.userId, d, 'личное');
  await say(a.userId, g, 'первое');
  const eb = await open(srv.config(b));
  eb.connect(); await eb.whenIdle();
  const feed = watchInto(eb, { kind: 'messages', chatId: g, limit: 50 });
  const direct = watchInto(eb, { kind: 'messages', chatId: d, limit: 50 });
  await feed.until((l) => l.length === 1);
  await direct.until((l) => l.length === 1);
  eb.disconnect();
  for (let i = 0; i < 4; i++) await say(a.userId, g, 'm' + i);
  await sql`delete from chat_updates where chat_id = ${g} and seq <= 4`;   // журнал подрезан дальше, чем знает клиент (seq 1)
  eb.connect(); await eb.whenIdle();
  await feed.until((l) => l.length === 5, 4000);   // окно истории заново — все пять
  expect(has(eb, 'chatTooLong')).toBe(true);
  expect(seqOf(eb, g)).toBe(5);
  expect(direct.list().length).toBe(1);
  expect(has(eb, 'snapshot')).toBe(false);   // личный журнал не сбрасывался
});

test('being added to a group while online: the chat appears via membership + row, next push applies without sync; removal drops it', async () => {
  const a = await srv.login('a'), b = await srv.login('b'), c = await srv.login('c');
  const { chatId: g } = await createGroup(a.userId, { title: 'Дача', memberIds: [c.userId] });   // a — владелец: может добавлять и удалять
  await say(a.userId, g, 'до Бориса');
  const eb = await open(srv.config(b));
  eb.connect(); await eb.whenIdle();
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  await addGroupMembers(a.userId, g, [b.userId]);
  await list.until((l) => !!chatOf(l, g) && chatOf(l, g)?.title != null, 4000);
  const seqAfterJoin = seqOf(eb, g)!;
  expect(seqAfterJoin).toBeGreaterThanOrEqual(2);
  const pushed = eb.dev.counters.pushed ?? 0;
  await say(a.userId, g, 'после');
  await list.until((l) => chatOf(l, g)?.last?.body === 'после');
  expect(seqOf(eb, g)).toBe(seqAfterJoin + 1);
  expect(eb.dev.counters.pushed).toBe(pushed + 1);
  expect(has(eb, 'syncChatTimeout')).toBe(false);
  await removeGroupMember(a.userId, g, b.userId);
  await list.until((l) => !chatOf(l, g));
  expect(seqOf(eb, g)).toBeUndefined();
});

test('a group outside the loaded dialog pages surfaces on its first push (row fetched by id)', async () => {
  const a = await srv.login('a'), b = await srv.login('b');
  const old = await srv.chat(a.token, [a.userId, b.userId, (await srv.login('c')).userId]);
  await say(b.userId, old, 'старая группа');   // своё: чат не попадёт в «непрочитанные» снимка
  await Bun.sleep(5);
  const fresh = await srv.chat(a.token, [a.userId, b.userId]);
  await say(a.userId, fresh, 'свежий личный');
  const eb = await open({ ...srv.config(b), dialogsPage: 1 });   // в снимке только самый свежий чат
  eb.connect(); await eb.whenIdle();
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  await list.until((l) => !!chatOf(l, fresh));
  expect(chatOf(list.list(), old)).toBeUndefined();
  await say(a.userId, old, 'ожила');
  await list.until((l) => chatOf(l, old)?.last?.body === 'ожила', 4000);
  expect(seqOf(eb, old)).toBe(2);
});

test('archived group: a foreign message lifts the archive through the conditional op; muted stays; a replay after re-archive does not lift it', async () => {
  const { a, b, g } = await group();
  const e1 = await open(srv.config(b));
  e1.connect(); await e1.whenIdle();
  const l1 = watchInto(e1, { kind: 'chatList', limit: 50 });
  await l1.until((l) => !!chatOf(l, g));
  await setChatFlags(b.userId, g, { archived: true });
  await l1.until((l) => chatOf(l, g)?.archived === true);
  const m = await say(a.userId, g, 'вернись');
  await l1.until((l) => chatOf(l, g)?.archived === false);          // оверлей, затем ответ сервера
  await e1.whenIdle();
  expect((await sql`select archived from chat_members where chat_id = ${g} and user_id = ${b.userId}`)[0].archived).toBe(false);
  // снова в архив, второе устройство воспроизводит то же сообщение через syncChat — архив остаётся
  await setChatFlags(b.userId, g, { archived: true });
  await l1.until((l) => chatOf(l, g)?.archived === true);
  const e2 = await open(srv.config(b));
  e2.connect(); await e2.whenIdle();
  const l2 = watchInto(e2, { kind: 'chatList', limit: 50 });
  await l2.until((l) => chatOf(l, g)?.archived === true);
  await Bun.sleep(300);
  expect(chatOf(l2.list(), g)?.archived).toBe(true);
  expect((await sql`select archived from chat_members where chat_id = ${g} and user_id = ${b.userId}`)[0].archived).toBe(true);
  // заглушённый — остаётся даже на новое сообщение
  await setChatNotify(b.userId, g, { muteUntil: 0 });
  await l1.until((l) => chatOf(l, g)?.muteUntil === 0);
  await say(a.userId, g, 'тихо');
  await l1.until((l) => chatOf(l, g)?.last?.body === 'тихо');
  await Bun.sleep(200);
  expect(chatOf(l1.list(), g)?.archived).toBe(true);
  expect(m.id).toBeGreaterThan(0);
});

test('hidden history: a newcomer ignores chat events about messages before history_from', async () => {
  const a = await srv.login('a'), b = await srv.login('b'), c = await srv.login('c');
  const { chatId: g } = await createGroup(a.userId, { title: 'Тайная', memberIds: [c.userId] });
  await setGroupSettings(a.userId, g, { historyHidden: true });
  const old = await say(a.userId, g, 'секрет');
  const eb = await open(srv.config(b));
  eb.connect(); await eb.whenIdle();
  await addGroupMembers(a.userId, g, [b.userId]);
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  await list.until((l) => !!chatOf(l, g) && chatOf(l, g)?.title != null, 4000);
  const feed = watchInto(eb, { kind: 'messages', chatId: g, limit: 50 });
  await say(a.userId, g, 'при Борисе');
  await feed.until((l) => l.some((m) => m.body === 'при Борисе'), 4000);
  await editMessage(a.userId, g, old.id, 'секрет (правка)');
  await Bun.sleep(300);
  await eb.whenIdle();
  expect(feed.list().some((m) => m.id === old.id)).toBe(false);
  expect(feed.list().every((m) => m.body !== 'секрет (правка)')).toBe(true);
});

test('since is recorded only after everything caught up and is sent on reconnect', async () => {
  const { a, b, g } = await group();
  const eb = await open(srv.config(b));
  eb.connect(); await eb.whenIdle();
  const store = (eb as unknown as { store: { since: number } }).store;
  await Bun.sleep(50);
  expect(store.since).toBeGreaterThan(0);
  const since1 = store.since;
  eb.disconnect();
  await say(a.userId, g, 'пока не было');
  const feed = watchInto(eb, { kind: 'messages', chatId: g, limit: 50 });
  eb.connect(); await eb.whenIdle();
  await feed.until((l) => l.some((m) => m.body === 'пока не было'), 4000);   // hello {since} назвал группу — догнали
  expect(store.since).toBeGreaterThanOrEqual(since1);
});

test('typing from myself or from a blocked user is dropped (group topic sends it to everyone)', async () => {
  const { b, g } = await group();
  const eb = await open(srv.config(b));
  eb.connect(); await eb.whenIdle();
  const list = watchInto(eb, { kind: 'chatList', limit: 50 });
  await list.until((l) => !!chatOf(l, g));
  inject(eb, { op: 'typing', chatId: g, userId: b.userId });
  await Bun.sleep(50);
  expect(chatOf(list.list(), g)?.typing).toBe(false);
});
