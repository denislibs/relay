import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { sendMessage } from '../src/domain/messages';
import { deleteMessage, editMessage } from '../src/domain/messageOps';
import { indexName, meili, MeiliError, waitTask } from '../src/search/meili';
import { ensureIndex, liveIndex, reindexAll, searchIds, searchReady, syncMessage } from '../src/search/messagesIndex';
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

test('sync indexes the current state: edit replaces, delete removes; word prefix and typos match; newest first; chat filter', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  const ab = await makeChat([a, b]), bc = await makeChat([b, c]);
  const m1 = await say(a, ab, 'Встреча в пятницу');
  const m2 = await say(b, ab, 'перенесли встречу');
  const m3 = await say(b, bc, 'встреча без a');
  for (const m of [m1, m2, m3]) await syncMessage(m.id);

  expect(await searchIds('встр', [ab], { limit: 10 })).toEqual([m2.id, m1.id]);
  // одна опечатка (перестановка) в слове из 7 букв прощается; «встречу» — уже две, не находится
  expect(await searchIds('встерча', [ab, bc], { limit: 10 })).toEqual([m3.id, m1.id]);
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
