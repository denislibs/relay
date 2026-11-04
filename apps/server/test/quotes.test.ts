import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { expireStep, setAutoDelete } from '../src/domain/autoDelete';
import { getHistory, listChats } from '../src/domain/chats';
import { getUpdates } from '../src/domain/journal';
import { deleteMessage, editMessage } from '../src/domain/messageOps';
import { sendMessage } from '../src/domain/messages';
import { planPush, subscribe } from '../src/domain/push';
import { deleteScheduled, editScheduled, listScheduled, publishScheduled, scheduleMessage } from '../src/domain/scheduled';
import { searchPostgres } from '../src/domain/search';
import { docOf } from '../src/search/messagesIndex';
import { openRows } from '../src/domain/messageContent';
import { drainJobs } from '../src/jobs/worker';
import '../src/jobs/kinds';
import { makeChat, makeUser, pushBrowser, resetDb } from './helpers';

beforeEach(resetDb);

const SECRET = 'секретный-кусок';
const cid = () => crypto.randomUUID();
const send = (user: number, chatId: number, body: string, extra: Record<string, unknown> = {}) => sendMessage(user, { chatId, clientId: cid(), body, ...extra }).then((r) => r.message);
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const pair = async () => { const a = await makeUser('Анна'), b = await makeUser('Борис'); return { a, b, chat: await makeChat([a, b]) }; };
const quoteOf = async (user: number, chat: number, id: number) => (await getHistory(user, chat, null, 100)).messages.find((m) => m.id === id)?.replyQuote;

test('a reply carries the fragment: offset and formatting come from the source, the recipient reads it', async () => {
  const { a, b, chat } = await pair();
  const src = await send(a, chat, `начало ${SECRET} конец`, { entities: [{ type: 'bold', offset: 0, length: 12 }, { type: 'italic', offset: 7, length: 8 }] });
  const m = await send(b, chat, 'ответ', { replyToId: src.id, replyQuote: { text: SECRET, offset: 7 } });
  expect(m.replyQuote).toEqual({ text: SECRET, offset: 7, entities: [{ type: 'italic', offset: 0, length: 8 }, { type: 'bold', offset: 0, length: 5 }] });
  expect(await quoteOf(a, chat, m.id)).toEqual(m.replyQuote!);
  // ответ без выделения — как раньше
  const plain = await send(b, chat, 'просто', { replyToId: src.id });
  expect(plain.replyQuote).toBeUndefined();
  expect(plain.replyToId).toBe(src.id);
});

test('forgery: words the person did not write are refused; client entities are not taken', async () => {
  const { a, b, chat } = await pair();
  const src = await send(a, chat, 'я этого не говорил');
  expect(await code(send(b, chat, 'ответ', { replyToId: src.id, replyQuote: { text: 'я всё украл', offset: 0 } }))).toBe('quote_gone');
  expect((await getHistory(a, chat, null, 10)).messages.map((m) => m.body)).toEqual(['я этого не говорил']);
  // смещение от клиента — лишь подсказка: фрагмент найдётся там, где он есть на самом деле
  const m = await send(b, chat, 'ответ', { replyToId: src.id, replyQuote: { text: 'не говорил', offset: 0, entities: [{ type: 'link', offset: 0, length: 2, url: 'https://evil.example' }, { type: 'bold', offset: 0, length: 2 }] } });
  expect(m.replyQuote).toEqual({ text: 'не говорил', offset: 8 });
  // без цели — отказ по цели; мусор — отказ кадра
  expect(await code(send(b, chat, 'x', { replyToId: 999999, replyQuote: { text: 'я', offset: 0 } }))).toBe('not_found');
  expect(await code(send(b, chat, 'x', { replyToId: src.id, replyQuote: { text: '   ', offset: 0 } }))).toBe('bad_frame');
  expect(await code(send(b, chat, 'x', { replyToId: src.id, replyQuote: { text: 'я', offset: -1 } }))).toBe('bad_frame');
  expect(await code(send(b, chat, 'x', { replyToId: src.id, replyQuote: { text: 7, offset: 0 } }))).toBe('bad_frame');
});

test('length: 1024 fits, 1025 does not', async () => {
  const { a, b, chat } = await pair();
  const src = await send(a, chat, 'х'.repeat(2000));
  expect((await send(b, chat, 'ok', { replyToId: src.id, replyQuote: { text: 'х'.repeat(1024), offset: 0 } })).replyQuote!.text.length).toBe(1024);
  expect(await code(send(b, chat, 'no', { replyToId: src.id, replyQuote: { text: 'х'.repeat(1025), offset: 0 } }))).toBe('too_long');
});

test('someone else\'s chat: the source must be in this chat; no access — no reply; hidden history is not an oracle', async () => {
  const { a, b, chat } = await pair();
  const c = await makeUser('Чужой'), other = await makeChat([a, c]);
  const hidden = await send(a, other, SECRET);
  // цитата сообщения другого чата: цели здесь нет
  expect(await code(send(b, chat, 'x', { replyToId: hidden.id, replyQuote: { text: SECRET, offset: 0 } }))).toBe('not_found');
  // в чужой чат не написать вовсе
  expect(await code(send(b, other, 'x', { replyToId: hidden.id, replyQuote: { text: SECRET, offset: 0 } }))).toBe('not_member');
  // скрытая от участника часть истории: и верная, и неверная догадка дают один отказ
  const group = await makeChat([a, b, c], 'group');
  const old = await send(a, group, SECRET);
  await send(a, group, 'новое');
  await sql`update chat_members set history_from = ${old.id + 1} where chat_id = ${group} and user_id = ${b}`;
  expect(await code(send(b, group, 'x', { replyToId: old.id, replyQuote: { text: SECRET, offset: 0 } }))).toBe('quote_gone');
  expect(await code(send(b, group, 'x', { replyToId: old.id, replyQuote: { text: 'неверно', offset: 0 } }))).toBe('quote_gone');
});

test('encryption: the fragment is nowhere in the open — row, journal, jobs, search, push; the sealed text does not contain it', async () => {
  const { a, b, chat } = await pair();
  const src = await send(a, chat, `раз ${SECRET} два`);
  const [s] = await sql`insert into sessions (token_hash, user_id, expires_at) values (${cid()}, ${a}, now() + interval '1 day') returning id`;
  await subscribe(a, { endpoint: `https://push.test/${a}`, keys: (await pushBrowser()).keys }, Number(s.id));
  // ответ своими словами: фрагмент не должен всплыть нигде, кроме самого сообщения
  const m = await send(b, chat, 'ответ', { replyToId: src.id, replyQuote: { text: SECRET, offset: 4 } });
  const [row] = await sql`select * from messages where id = ${m.id}`;
  expect(row.has_quote).toBe(true);
  const { content, ...open } = row;
  expect(JSON.stringify(open)).not.toContain(SECRET);
  expect(Buffer.from(content as Uint8Array).includes(Buffer.from(SECRET))).toBe(false);
  for (const table of ['updates', 'jobs']) expect(JSON.stringify(await sql`select * from ${sql(table)}`)).not.toContain(SECRET);
  // журнал получателю отдаёт открытое по ссылке — вместе с цитатой
  const seen = (await getUpdates(a, 0)).items.map((i) => i.update).find((u) => u.type === 'newMessage' && u.message.id === m.id) as { message: { replyQuote?: { text: string } } };
  expect(seen.message.replyQuote?.text).toBe(SECRET);
  // поиск по цитате ответа не находит, индекс получает только текст самого сообщения
  expect((await searchPostgres(a, SECRET, { chatId: chat })).hits.map((h) => h.message.id)).toEqual([src.id]);
  const [opened] = await sql`select * from messages where id = ${m.id}`;
  const doc = await docOf((await openRows([opened]))[0]);
  expect(JSON.stringify(doc)).not.toContain(SECRET);
  // push — текст ответа; строка списка чатов — тоже
  const push = await planPush({ ...m, entities: [] } as never);
  expect(push.length).toBeGreaterThan(0);
  expect(JSON.stringify(push)).not.toContain(SECRET);
  const last = (await listChats(a)).find((c) => c.id === chat)!.last!;
  expect(last.body).toBe('ответ');
  expect(last.replyQuote?.text).toBe(SECRET);   // сообщение целиком, для устройства, узнавшего его из списка
  await drainJobs();
});

test('an edit of the reply keeps the fragment; an edit of the source does not touch it', async () => {
  const { a, b, chat } = await pair();
  const src = await send(a, chat, 'было так');
  const m = await send(b, chat, 'ответ', { replyToId: src.id, replyQuote: { text: 'было', offset: 0 } });
  await editMessage(b, chat, m.id, 'ответ изменён');
  expect(await quoteOf(a, chat, m.id)).toEqual({ text: 'было', offset: 0 });
  await editMessage(a, chat, src.id, 'стало иначе');
  expect(await quoteOf(a, chat, m.id)).toEqual({ text: 'было', offset: 0 });
  // после правки исходного то, чего в нём больше нет, новой цитатой не приписать
  expect(await code(send(b, chat, 'x', { replyToId: src.id, replyQuote: { text: 'было', offset: 0 } }))).toBe('quote_gone');
});

test('spoiler: the fragment keeps it from the source, whatever the client sends', async () => {
  const { a, b, chat } = await pair();
  const src = await send(a, chat, 'пароль 12345 тут', { entities: [{ type: 'spoiler', offset: 7, length: 5 }] });
  const m = await send(b, chat, 'ответ', { replyToId: src.id, replyQuote: { text: 'пароль 12345', offset: 0, entities: [] } });
  expect(m.replyQuote!.entities).toEqual([{ type: 'spoiler', offset: 7, length: 5 }]);
});

test('protected group: a quote inside is allowed, forwarding out is still not', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const group = await makeChat([a, b], 'group');
  await sql`update chats set protected = true where id = ${group}`;
  const src = await send(a, group, SECRET);
  expect((await send(b, group, 'ответ', { replyToId: src.id, replyQuote: { text: SECRET, offset: 0 } })).replyQuote?.text).toBe(SECRET);
  const out = await makeChat([b, c]);
  expect(await code(sendMessage(b, { chatId: out, clientId: cid(), body: '', forward: { chatId: group, id: src.id } }))).toBe('forbidden');
});

test('forward: a reply forwarded on does not carry someone\'s fragment along', async () => {
  const { a, b, chat } = await pair();
  const c = await makeUser('Вера'), out = await makeChat([b, c]);
  const src = await send(a, chat, SECRET);
  const m = await send(b, chat, 'ответ', { replyToId: src.id, replyQuote: { text: SECRET, offset: 0 } });
  const f = await sendMessage(b, { chatId: out, clientId: cid(), body: '', forward: { chatId: chat, id: m.id } });
  expect(f.message.replyQuote).toBeUndefined();
  expect(f.message.replyToId).toBeNull();
});

test('deleted source: its piece does not outlive it — scrubbed from replies; the reply itself stays', async () => {
  const { a, b, chat } = await pair();
  const src = await send(a, chat, `раз ${SECRET}`);
  const m = await send(b, chat, 'ответ', { replyToId: src.id, replyQuote: { text: SECRET, offset: 4 } });
  await deleteMessage(a, chat, src.id);
  const h = (await getHistory(b, chat, null, 10)).messages.find((x) => x.id === m.id)!;
  expect(h).toMatchObject({ body: 'ответ', replyToId: src.id });
  expect(h.replyQuote).toBeUndefined();
  const [row] = await sql`select has_quote from messages where id = ${m.id}`;
  expect(row.has_quote).toBe(false);
  // удаляется сам ответ: цитаты нет вовсе
  const src2 = await send(a, chat, SECRET), m2 = await send(b, chat, 'ещё', { replyToId: src2.id, replyQuote: { text: SECRET, offset: 0 } });
  await deleteMessage(b, chat, m2.id);
  const [gone] = await sql`select content, deleted from messages where id = ${m2.id}`;
  expect(gone).toMatchObject({ content: null, deleted: true });
});

test('auto-delete: an expired source scrubs the fragment even from a reply without a term', async () => {
  const { a, b, chat } = await pair();
  await setAutoDelete(a, chat, 86400);
  const src = await send(a, chat, SECRET);
  expect(src.expiresAt).toBeGreaterThan(Date.now());
  await setAutoDelete(a, chat, null);
  const m = await send(b, chat, 'без срока', { replyToId: src.id, replyQuote: { text: SECRET, offset: 0 } });
  expect(m.expiresAt).toBeUndefined();
  await sql`update messages set expires_at = now() - interval '1 second' where id = ${src.id}`;
  await expireStep();
  const h = (await getHistory(b, chat, null, 10)).messages.find((x) => x.id === m.id)!;
  expect(h.body).toBe('без срока');
  expect(h.replyQuote).toBeUndefined();
});

test('scheduled: checked when planning and again at publishing; sealed; edit keeps it', async () => {
  const { a, b, chat } = await pair();
  const src = await send(b, chat, `вот ${SECRET} тут`);
  expect(await code(scheduleMessage(a, { chatId: chat, clientId: cid(), body: 'x', scheduleAt: Date.now() + 60_000, replyToId: src.id, replyQuote: { text: 'неправда', offset: 0 } }))).toBe('quote_gone');
  const clientId = cid();
  const r = await scheduleMessage(a, { chatId: chat, clientId, body: 'отложено', scheduleAt: Date.now() + 60_000, replyToId: src.id, replyQuote: { text: SECRET, offset: 4 } }) as { item: { replyQuote?: { text: string } } };
  expect(r.item.replyQuote?.text).toBe(SECRET);
  const [row] = await sql`select * from scheduled_messages where client_id = ${clientId}`;
  expect(Buffer.from(row.content as Uint8Array).includes(Buffer.from(SECRET))).toBe(false);
  await editScheduled(a, chat, clientId, { body: 'отложено ещё' });
  expect((await listScheduled(a)).items[0].replyQuote?.text).toBe(SECRET);
  await sql`update scheduled_messages set send_at = now() - interval '1 second' where client_id = ${clientId}`;
  await publishScheduled(a, clientId);
  const pub = (await getHistory(b, chat, null, 10)).messages.find((x) => x.body === 'отложено ещё')!;
  expect(pub.replyQuote?.text).toBe(SECRET);
  expect(pub.replyToId).toBe(src.id);
});

test('scheduled: fragment edited away — goes as a plain reply; source deleted — goes without the reply; no failure either way', async () => {
  const { a, b, chat } = await pair();
  const due = async (id: string) => { await sql`update scheduled_messages set send_at = now() - interval '1 second' where client_id = ${id}`; await publishScheduled(a, id); };
  const src = await send(b, chat, `вот ${SECRET}`);
  const c1 = cid(), c2 = cid();
  await scheduleMessage(a, { chatId: chat, clientId: c1, body: 'первое', scheduleAt: Date.now() + 60_000, replyToId: src.id, replyQuote: { text: SECRET, offset: 4 } });
  await scheduleMessage(a, { chatId: chat, clientId: c2, body: 'второе', scheduleAt: Date.now() + 60_000, replyToId: src.id, replyQuote: { text: SECRET, offset: 4 } });
  await editMessage(b, chat, src.id, 'всё переписано');
  await due(c1);
  let h = (await getHistory(b, chat, null, 10)).messages.find((x) => x.body === 'первое')!;
  expect(h.replyToId).toBe(src.id);
  expect(h.replyQuote).toBeUndefined();
  await deleteMessage(b, chat, src.id);
  await due(c2);
  h = (await getHistory(b, chat, null, 10)).messages.find((x) => x.body === 'второе')!;
  expect(h.replyToId).toBeNull();
  expect(h.replyQuote).toBeUndefined();
  await deleteScheduled(a, chat, c2);
  expect((await listScheduled(a)).items).toEqual([]);
});

test('blockquote: stored through normalizeEntities, combinations, nesting, forward and edit keep it; old-style messages untouched', async () => {
  const { a, b, chat } = await pair();
  const m = await send(a, chat, 'до\nцитата\nпосле', { entities: [{ type: 'blockquote', offset: 3, length: 6, collapsed: true }, { type: 'bold', offset: 3, length: 3 }, { type: 'blockquote', offset: 5, length: 2 }] });
  expect(m.entities).toEqual([{ type: 'blockquote', offset: 3, length: 6 }, { type: 'bold', offset: 3, length: 3 }]);
  const c = await send(a, chat, 'цитата', { entities: [{ type: 'blockquote', offset: 0, length: 6, collapsed: true }, { type: 'pre', offset: 0, length: 2 }] });
  expect(c.entities).toEqual([{ type: 'pre', offset: 0, length: 2 }]);
  const d = await send(a, chat, 'цитата', { entities: [{ type: 'blockquote', offset: 0, length: 6, collapsed: true }] });
  expect((await getHistory(b, chat, null, 10)).messages.find((x) => x.id === d.id)!.entities).toEqual([{ type: 'blockquote', offset: 0, length: 6, collapsed: true }]);
  await editMessage(a, chat, d.id, 'цитата новая', [{ type: 'blockquote', offset: 0, length: 6, collapsed: true }]);
  const f = await sendMessage(b, { chatId: chat, clientId: cid(), body: '', forward: { chatId: chat, id: d.id } });
  expect(f.message.entities).toEqual([{ type: 'blockquote', offset: 0, length: 6, collapsed: true }]);
  expect((await send(a, chat, 'без оформления')).entities).toBeUndefined();
});
