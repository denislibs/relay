import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { sendMessage } from '../src/domain/messages';
import { searchMessages } from '../src/domain/search';
import '../src/jobs/kinds';
import { drainJobs } from '../src/jobs/worker';
import { deleteMessage, editMessage } from '../src/domain/messageOps';
import { indexName, meili, MeiliError, waitTask } from '../src/search/meili';
import { ensureIndex, liveIndex, reindexAll, reindexStep, searchIds, searchReady, syncMessage, syncMessages } from '../src/search/messagesIndex';
import { enqueue } from '../src/jobs/queue';
import { makeChat, makeUser, resetDb } from './helpers';

const say = (u: number, chatId: number, body: string) => sendMessage(u, { chatId, clientId: crypto.randomUUID(), body }).then((r) => r.message);

async function freshIndex() {
  // удаление несуществующего индекса — 202 и задача, которая падает с index_not_found: глушим и то, и другое
  await meili<{ taskUid: number }>(`/indexes/${liveIndex()}`, { method: 'DELETE' }).then((t) => waitTask(t.taskUid)).catch(() => {});
  await ensureIndex(liveIndex());
}

beforeEach(async () => { await resetDb(); await freshIndex(); });

test('client talks to Meilisearch with the master key; errors carry status and code', async () => {
  expect((await meili<{ status: string }>('/health')).status).toBe('available');
  const name = indexName('probe');
  expect(name).toBe('relay_test_probe');
  const t = await meili<{ taskUid: number }>('/indexes', { method: 'POST', body: { uid: name, primaryKey: 'id' } });
  await waitTask(t.taskUid);
  const err = await meili('/indexes/does_not_exist').catch((e) => e);
  expect(err).toBeInstanceOf(MeiliError);
  expect(err).toMatchObject({ status: 404, code: 'index_not_found' });
  await waitTask((await meili<{ taskUid: number }>(`/indexes/${name}`, { method: 'DELETE' })).taskUid);
});

test('sync indexes the current state: edit replaces, delete removes; word prefix matches, typos do not (tokens); newest first; chat filter', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  const m1 = await say(a, ab, 'Встреча в пятницу');
  const m2 = await say(b, ab, 'перенесли встречу');
  const m3 = await say(b, bc, 'встреча без a');
  for (const m of [m1, m2, m3]) await syncMessage(m.id);

  expect(await searchIds('встр', [ab], { limit: 10 })).toEqual([m2.id, m1.id]);
  // в индексе HMAC-токены: у токена нет «соседей», поэтому опечатка не прощается (цена того, что текста в индексе нет)
  expect(await searchIds('встерча', [ab, bc], { limit: 10 })).toEqual([]);
  expect(await searchIds('встреч', [ab], { limit: 1 })).toEqual([m2.id, m1.id]);               // limit + 1 — признак «есть ещё»
  expect(await searchIds('встреч', [ab], { beforeId: m2.id, limit: 10 })).toEqual([m1.id]);
  expect(await searchIds('встреч', [], { limit: 10 })).toEqual([]);

  await editMessage(a, ab, m1.id, 'совещание в пятницу');
  await syncMessage(m1.id);
  expect(await searchIds('встреч', [ab], { limit: 10 })).toEqual([m2.id]);
  expect(await searchIds('совещ', [ab], { limit: 10 })).toEqual([m1.id]);

  await deleteMessage(b, ab, m2.id);
  await syncMessage(m2.id);
  expect(await searchIds('встреч', [ab], { limit: 10 })).toEqual([]);
});

test('login codes are never indexed; file names are', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const [code] = await sql`insert into messages (chat_id, sender_id, client_id, kind, body, service_type) values (${ab}, ${a}, ${crypto.randomUUID()}, 'text', 'Код входа 482913', 'login_code') returning id`;
  const [file] = await sql`insert into messages (chat_id, sender_id, client_id, kind, body, attachment) values (${ab}, ${a}, ${crypto.randomUUID()}, 'file', '', ${sql.json({ id: 'x', kind: 'file', name: 'отчёт за май.pdf', mime: 'application/pdf', size: 1 } as never)}) returning id`;
  await syncMessage(Number(code.id));
  await syncMessage(Number(file.id));
  expect(await searchIds('482913', [ab], { limit: 10 })).toEqual([]);
  expect(await searchIds('отчёт', [ab], { limit: 10 })).toEqual([Number(file.id)]);
});

test('attachments: track title and performer are indexed beside the file name; reindex and searchMessages find them', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const file = async (meta: { name: string; mime: string; kind: string; title?: string; performer?: string }) => {
    const [att] = await sql`insert into attachments (owner_id, mime, name, size, kind, title, performer, status)
      values (${b}, ${meta.mime}, ${meta.name}, 1, ${meta.kind}, ${meta.title ?? null}, ${meta.performer ?? null}, 'ready') returning id`;
    return (await sendMessage(b, { chatId: ab, clientId: crypto.randomUUID(), body: '', attachment: { id: att.id as string } })).message;
  };
  const song = await file({ name: 'track01.mp3', mime: 'audio/mpeg', kind: 'audio', title: 'Офисный планктон', performer: 'Ария' });
  const pdf = await file({ name: 'договор аренды.pdf', mime: 'application/pdf', kind: 'file' });
  await syncMessage(song.id);
  await syncMessage(pdf.id);
  expect(await searchIds('планктон', [ab], { limit: 10 })).toEqual([song.id]);
  expect(await searchIds('ария', [ab], { limit: 10 })).toEqual([song.id]);
  expect(await searchIds('track01', [ab], { limit: 10 })).toEqual([song.id]);
  expect(await searchIds('договор', [ab], { limit: 10 })).toEqual([pdf.id]);

  await reindexAll();                                       // перестройка тоже переносит теги
  expect(await searchReady()).toBe(true);
  expect((await searchMessages(a, 'планктон')).hits.map((h) => h.message.id)).toEqual([song.id]);
  expect((await searchMessages(a, 'планктон', { chatId: ab })).hits.map((h) => h.message.id)).toEqual([song.id]);
  expect((await searchMessages(a, 'аренды', { chatId: ab })).hits.map((h) => h.message.id)).toEqual([pdf.id]);
});

test('reindex builds a fresh index beside the live one, swaps it in and marks the index ready', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const m1 = await say(a, ab, 'старая встреча');
  const gone = await say(a, ab, 'встреча удалена');
  await deleteMessage(a, ab, gone.id);
  expect(await searchReady()).toBe(false);
  expect(await reindexAll(1)).toBe(1);                 // батч из одного — проверяем постраничное копирование
  expect(await searchReady()).toBe(true);
  expect(await searchIds('встреч', [ab], { limit: 10 })).toEqual([m1.id]);
  const indexes = await meili<{ results: { uid: string }[] }>('/indexes?limit=100');
  expect(indexes.results.map((i) => i.uid).filter((u) => u.startsWith('relay_test_messages'))).toEqual(['relay_test_messages']);
  expect((await sql`select count(*)::int as n from server_meta where k = 'search_building'`)[0].n).toBe(0);
});

test('end to end: send/edit/delete enqueue sync jobs; search goes to Meilisearch once ready, rechecks access in Postgres', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  await reindexAll();                                        // пустой индекс, готов
  const m1 = await say(a, ab, 'встреча в пятницу');
  await say(b, bc, 'встреча без a');
  const m3 = await say(b, ab, 'перенесли встречу');
  expect((await sql`select count(*)::int as n from jobs where kind = 'search.sync'`)[0].n).toBe(3);
  await drainJobs();

  const res = await searchMessages(a, 'встреч');
  expect(res.hits.map((h) => h.message.id)).toEqual([m3.id, m1.id]);   // чужой чат не виден
  expect(res.hits[0].chatTitle).toBe('b');

  await editMessage(a, ab, m1.id, 'совещание в пятницу');
  await drainJobs();
  expect((await searchMessages(a, 'совещ')).hits.map((h) => h.message.id)).toEqual([m1.id]);

  await deleteMessage(b, ab, m3.id);
  await drainJobs();
  expect((await searchMessages(a, 'встреч')).hits.map((h) => h.message.id)).toEqual([]);
  expect((await searchMessages(a, 'пятниц')).hits.map((h) => h.message.id)).toEqual([m1.id]);

  // вышла из чата — даже если индекс отстал, перепроверка в Postgres не отдаст чужое
  await sql`delete from chat_members where chat_id = ${ab} and user_id = ${a}`;
  expect((await searchMessages(a, 'пятниц')).hits).toEqual([]);
});

test('Meilisearch down or index not ready: search falls back to Postgres substring search', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const m = await say(a, ab, 'перенесли');
  expect((await searchMessages(a, 'ес')).hits.map((h) => h.message.id)).toEqual([m.id]);   // не готов — подстрока
  await reindexAll();
  expect((await searchMessages(a, 'ес')).hits).toEqual([]);                                 // готов — только слова и их начало
  const url = process.env.MEILI_URL;
  process.env.MEILI_URL = 'http://127.0.0.1:1';            // «упал»
  try {
    expect((await searchMessages(a, 'ес')).hits.map((h) => h.message.id)).toEqual([m.id]);
  } finally {
    process.env.MEILI_URL = url;
  }
});

test('sync before the index exists: removal is a no-op, an upsert creates the index with id as the key', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const m = await say(a, ab, 'встреча');
  await deleteMessage(a, ab, m.id);
  await waitTask((await meili<{ taskUid: number }>(`/indexes/${liveIndex()}`, { method: 'DELETE' })).taskUid);
  await syncMessage(m.id);
  await syncMessage(999_999);                                // строки нет вовсе
  const m2 = await say(a, ab, 'встреча снова');
  await syncMessage(m2.id);                                  // индекс создаётся сам, первичный ключ — id
  // настроек у него нет, искать по нему нельзя — до перестройки поиск всё равно идёт по Postgres
  const doc = await meili<Record<string, unknown>>(`/indexes/${liveIndex()}/documents/${m2.id}`);
  expect(doc).toMatchObject({ id: m2.id, chatId: ab });
  // в индексе — только токены: ни слова текста
  expect(JSON.stringify(doc)).not.toContain('встреча');
  expect(String(doc.b)).toMatch(/^[a-p]{18}( [a-p]{18})*$/);
});

const meta = async (k: string) => (await sql`select v from server_meta where k = ${k}`)[0]?.v as string | undefined;
const docIds = async (uid: string) =>
  (await meili<{ results: { id: number }[] }>(`/indexes/${uid}/documents?limit=1000&fields=id`)).results.map((d) => Number(d.id)).sort((x, y) => x - y);
const docCount = async (uid: string) => (await meili<{ numberOfDocuments: number }>(`/indexes/${uid}/stats`)).numberOfDocuments;

test('reindex is resumable: a run cut off after a few batches continues from the cursor, nothing lost or duplicated', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const ms = [];
  for (let i = 0; i < 7; i++) ms.push(await say(a, ab, `встреча номер ${i}`));
  const next = liveIndex() + '_next';

  // первая порция: две пачки по одному — индекс строится рядом, курсор сохранён, готовности нет
  expect(await reindexStep({ batch: 1, maxBatches: 2 })).toEqual({ done: false, copied: 2 });
  expect(await meta('search_building')).toBe(next);
  expect(await meta('search_reindex_after')).toBe(String(ms[1].id));
  expect(await searchReady()).toBe(false);

  // повторный запуск не стирает построенное: продолжает с курсора
  expect(await reindexStep({ batch: 1, maxBatches: 1 })).toEqual({ done: false, copied: 1 });
  expect(await docIds(next)).toEqual(ms.slice(0, 3).map((m) => m.id));

  // пока идёт перестройка — изменения пишутся в оба индекса (и в уже скопированную часть)
  await editMessage(a, ab, ms[0].id, 'совещание номер 0');
  await deleteMessage(a, ab, ms[1].id);
  const late = await say(a, ab, 'встреча поздняя');
  for (const id of [ms[0].id, ms[1].id, late.id]) await syncMessage(id);

  // «обрыв» после записи пачки, но до сохранения курсора: курсор позади — пачка запишется ещё раз, без дублей
  await sql`update server_meta set v = ${String(ms[0].id)} where k = 'search_reindex_after'`;
  await reindexAll(2);

  const expected = [ms[0], ...ms.slice(2), late].map((m) => m.id).sort((x, y) => x - y);
  expect(await searchReady()).toBe(true);
  expect(await docIds(liveIndex())).toEqual(expected);
  expect(await docCount(liveIndex())).toBe(expected.length);
  expect(await searchIds('совещ', [ab], { limit: 10 })).toEqual([ms[0].id]);
  expect(await meta('search_building')).toBeUndefined();
  expect(await meta('search_reindex_after')).toBeUndefined();
  const indexes = await meili<{ results: { uid: string }[] }>('/indexes?limit=100');
  expect(indexes.results.map((i) => i.uid).filter((u) => u.startsWith('relay_test_messages'))).toEqual(['relay_test_messages']);
});

test('a build left by an older run without a cursor, or a cursor without its index, starts over cleanly', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const m = await say(a, ab, 'встреча');
  const next = liveIndex() + '_next';
  await ensureIndex(next);
  await meili(`/indexes/${next}/documents?primaryKey=id`, { method: 'POST', body: [{ id: 999_999, chatId: ab, b: 'мусор', a: '' }] }).then((t: any) => waitTask(t.taskUid));
  await sql`insert into server_meta (k, v) values ('search_building', ${next})`;   // курсора нет — прежняя версия оборвалась
  expect(await reindexAll()).toBe(1);
  expect(await docIds(liveIndex())).toEqual([m.id]);

  await sql`insert into server_meta (k, v) values ('search_building', ${next}), ('search_reindex_after', '0')`;   // индекса _next нет
  expect(await reindexAll()).toBe(1);
  expect(await docIds(liveIndex())).toEqual([m.id]);
});

test('search.reindex job runs in short steps and requeues itself until the swap', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  for (let i = 0; i < 5; i++) await say(a, ab, `встреча ${i}`);
  await sql`delete from jobs`;
  await enqueue(sql, 'search.reindex', { batch: 1, maxBatches: 2 }, { dedupeKey: 'search.reindex' });
  expect(await drainJobs()).toBeGreaterThanOrEqual(3);      // 5 пачек по 2 за шаг + финальный swap
  expect(await searchReady()).toBe(true);
  expect(await docCount(liveIndex())).toBe(5);
  expect((await sql`select count(*)::int as n from jobs`)[0].n).toBe(0);
});

test('the index holds HMAC tokens, not text: words and their beginnings are found, the text is nowhere in Meilisearch', async () => {
  const { indexTokens, queryTokens, words } = await import('../src/search/tokens');
  expect(words('Привет, Ёжик! Встреча в 10:30')).toEqual(['привет', 'ежик', 'встреча', 'в', '10', '30']);
  const doc = await indexTokens('Встреча завтра');
  // начало слова и слово целиком дают токены, которые есть в документе; чужое слово — нет
  for (const q of ['встр', 'встреча', 'ЗАВТРА']) expect(doc.split(' ')).toContain(await queryTokens(q));
  expect(doc.split(' ')).not.toContain(await queryTokens('вечер'));
  expect(doc).not.toMatch(/встр|завт/);
});

test('syncMessages: one batch upserts the live rows and removes deleted, missing and duplicate ids', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const keep = await say(a, ab, 'встреча в пятницу');
  const gone = await say(a, ab, 'встреча отменена');
  await syncMessage(gone.id);
  await deleteMessage(a, ab, gone.id);
  const late = await say(b, ab, 'встреча перенесена');
  await syncMessages([keep.id, gone.id, late.id, keep.id, 999_999]);
  const docs = await meili<{ results: { id: number }[] }>(`/indexes/${liveIndex()}/documents?limit=100`);
  expect(docs.results.map((d) => d.id).sort((x, y) => x - y)).toEqual([keep.id, late.id]);
  await syncMessages([]);
});

test('syncMessages during a rebuild writes both indexes; removal from a not yet created index is a no-op', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const ab = await makeChat([a, b]);
  const m = await say(a, ab, 'встреча');
  const gone = await say(a, ab, 'удалю');
  await deleteMessage(a, ab, gone.id);
  const next = liveIndex() + '_building_test';
  await sql`insert into server_meta (k, v) values ('search_building', ${next})`;
  try {
    await syncMessages([gone.id]);                           // next ещё нет: удаление ничего не ломает
    await syncMessages([m.id, gone.id]);
    for (const uid of [liveIndex(), next]) {
      const doc = await meili<{ id: number }>(`/indexes/${uid}/documents/${m.id}`);
      expect(doc.id).toBe(m.id);
    }
  } finally {
    await sql`delete from server_meta where k = 'search_building'`;
    await meili<{ taskUid: number }>(`/indexes/${next}`, { method: 'DELETE' }).then((t) => waitTask(t.taskUid)).catch(() => {});
  }
});
