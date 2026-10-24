import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { getChatMedia, getChatMediaCounts, getHistory, getMessagesByIds, listChats, messageAtDate } from '../src/domain/chats';
import { getUpdates } from '../src/domain/journal';
import { deleteMessage } from '../src/domain/messageOps';
import { sendMessage } from '../src/domain/messages';
import { pinMessage } from '../src/domain/pins';
import { searchPostgres } from '../src/domain/search';
import { chatEventsOf, makeChat, makeUser, resetDb } from './helpers';

// Удаление как в Telegram: удалённое исчезает из всего, что читает ленту, — без заглушки «Сообщение удалено».
// Пересланные копии в других чатах — свои строки и живут дальше.

beforeEach(resetDb);
const cid = () => crypto.randomUUID();
const send = (user: number, chatId: number, body: string, extra: Record<string, unknown> = {}) =>
  sendMessage(user, { chatId, clientId: cid(), body, ...extra }).then((r) => r.message);

async function photo(owner: number): Promise<string> {
  const [r] = await sql`insert into attachments (owner_id, mime, name, size, status, kind, width, height)
    values (${owner}, 'image/jpeg', 'cat.jpg', 10, 'ready', 'photo', 800, 600) returning id`;
  return r.id as string;
}

test('a deleted message is gone from history (both directions), by-ids, jump-to-date, search and media tabs', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const m1 = await send(a, chat, 'первое слово');
  const gone = await send(a, chat, 'удалённое слово', { attachment: { id: await photo(a) } });
  const m3 = await send(b, chat, 'третье слово');
  await deleteMessage(a, chat, gone.id);

  expect((await getHistory(b, chat, null, 50)).messages.map((m) => m.id)).toEqual([m1.id, m3.id]);
  expect((await getHistory(b, chat, null, 50, m1.id)).messages.map((m) => m.id)).toEqual([m3.id]);   // ?after
  expect((await getHistory(b, chat, m3.id, 50)).messages.map((m) => m.id)).toEqual([m1.id]);          // ?before
  // исходник цитаты: ничего — клиент покажет «Удалённое сообщение»
  expect((await getMessagesByIds(b, chat, [m1.id, gone.id])).map((m) => m.id)).toEqual([m1.id]);
  expect((await searchPostgres(b, 'слово', { chatId: chat })).hits.map((h) => h.message.id)).toEqual([m3.id, m1.id]);
  expect((await getChatMedia(b, chat, 'media', null)).messages).toEqual([]);
  expect((await getChatMediaCounts(b, chat)).media).toBe(0);
  // «Перейти к дате» за последним — последнее не удалённое
  await deleteMessage(b, chat, m3.id);
  expect(await messageAtDate(b, chat, new Date(Date.now() + 86_400_000).toISOString())).toEqual({ id: m1.id });
  // скрытая история (history_from) — и в запасном «последнем» тоже не видна
  await sql`update chat_members set history_from = ${m1.id + 1} where chat_id = ${chat} and user_id = ${b}`;
  expect(await messageAtDate(b, chat, new Date(Date.now() + 86_400_000).toISOString())).toEqual({ id: null });
});

test('pins: a deleted message is unpinned and cannot be pinned', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const m = await send(a, chat, 'закреп');
  expect((await pinMessage(a, chat, m.id)).ids).toEqual([m.id]);
  await deleteMessage(a, chat, m.id);
  expect((await listChats(b, { ids: [chat] }))[0].pinned).toEqual([]);
  await expect(pinMessage(a, chat, m.id)).rejects.toMatchObject({ code: 'not_found' });
});

test('chat list: last is the newest not-deleted message, unread and «@» skip deleted ones; the journal still says messageDeleted', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  await sql`update users set username = 'boris_b' where id = ${b}`;
  const g = await makeChat([a, b, c], 'group');
  const before = await send(a, g, 'было раньше');
  const mention = await send(a, g, 'привет @boris_b');
  const last = await send(c, g, 'последнее');
  let [row] = await listChats(b, { ids: [g] });
  expect(row.last?.id).toBe(last.id);
  expect(row.unread).toBe(3);
  expect(row.unreadMentions).toBe(1);

  await deleteMessage(c, g, last.id);
  await deleteMessage(a, g, mention.id);
  [row] = await listChats(b, { ids: [g] });
  expect(row.last).toMatchObject({ id: before.id, body: 'было раньше', deleted: false });
  expect(row.sortAt).toBe(new Date(before.createdAt).toISOString());   // чат опускается к дате предыдущего
  expect(row.unread).toBe(1);
  expect(row.unreadMentions).toBe(0);
  expect((await listChats(b, { ids: [g], unreadOnly: true })).map((x) => x.id)).toEqual([g]);
  await deleteMessage(a, g, before.id);
  expect(await listChats(b, { ids: [g], unreadOnly: true })).toEqual([]);   // осталось только удалённое — не «непрочитанный»
  [row] = await listChats(b, { ids: [g] });
  expect(row.unread).toBe(0);

  // журнал группы: messageDeleted остаётся (клиенты убирают у себя), а «новое» удалённого читается удалением
  const events = await chatEventsOf(g);
  expect(events.filter((u) => u.type === 'messageDeleted').map((u) => (u as { id: number }).id)).toEqual(expect.arrayContaining([before.id, mention.id, last.id]));
  expect(events.some((u) => u.type === 'newMessage')).toBe(false);
  // упоминание удалённого в личном журнале — тоже удаление
  expect((await getUpdates(b, 0)).items.map((i) => i.update.type)).not.toContain('mention');
});

test('forwarded copies of a deleted message stay readable, keep fwdFrom and can be forwarded on; a reply to the deleted is refused', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]), ac = await makeChat([a, c]);
  const src = await send(a, ab, 'исходное');
  const copy = await send(b, bc, '', { forward: { chatId: ab, id: src.id } });
  await deleteMessage(a, ab, src.id);

  const [h] = (await getHistory(c, bc, null, 10)).messages;
  expect(h).toMatchObject({ id: copy.id, body: 'исходное', deleted: false, fwdFrom: { userId: a, name: 'Анна', chatId: ab, messageId: src.id } });
  const again = await send(c, ac, '', { forward: { chatId: bc, id: copy.id } });
  expect(again).toMatchObject({ body: 'исходное', fwdFrom: { userId: a, chatId: ab, messageId: src.id } });   // первый автор — тот же
  await expect(send(b, ab, '', { forward: { chatId: ab, id: src.id } })).rejects.toMatchObject({ code: 'not_found' });   // удалённое — не переслать
  await expect(send(b, ab, 'ответ', { replyToId: src.id })).rejects.toMatchObject({ code: 'not_found' });
});
