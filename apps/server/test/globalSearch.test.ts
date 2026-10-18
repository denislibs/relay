import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { searchMedia, searchPeople, topPeers } from '../src/domain/globalSearch';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

async function put(chatId: number, sender: number, kind: string, body: string, attachment: object | null = null) {
  const [r] = await sql`insert into messages (chat_id, sender_id, client_id, kind, body, attachment)
    values (${chatId}, ${sender}, ${crypto.randomUUID()}, ${kind}, ${body}, ${attachment ? sql.json(attachment as never) : null}) returning id`;
  return Number(r.id);
}
const att = (kind: string, mime: string, extra: object = {}) => ({ id: crypto.randomUUID(), kind, mime, name: 'x.bin', size: 1, w: null, h: null, ...extra });

test('media tabs across all my chats: newest first, chat titles, paging, never other people\'s chats', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера'), x = await makeUser('Чужой');
  const ab = await makeChat([a, b]), ac = await makeChat([a, c]), bx = await makeChat([b, x]);
  await sql`update chats set title = 'Группа' where id = ${ac}`;
  await sql`update chats set kind = 'group' where id = ${ac}`;
  const p1 = await put(ab, b, 'photo', '', att('photo', 'image/png'));
  const p2 = await put(ac, c, 'photo', '', att('photo', 'image/png'));
  await put(bx, x, 'photo', '', att('photo', 'image/png'));                 // чужой чат
  const gone = await put(ab, a, 'photo', '', att('photo', 'image/png'));
  await sql`update messages set deleted = true where id = ${gone}`;
  const r = await searchMedia(a, 'media');
  expect(r.hits.map((h) => h.message.id)).toEqual([p2, p1]);
  expect(r.hits.map((h) => [h.chatTitle, h.chatKind])).toEqual([['Группа', 'group'], ['Борис', 'direct']]);
  const one = await searchMedia(a, 'media', { limit: 1 });
  expect([one.hits.length, one.hasMore]).toEqual([1, true]);
  const next = await searchMedia(a, 'media', { limit: 1, before: one.hits[0].message.id });
  expect(next.hits.map((h) => h.message.id)).toEqual([p1]);
});

test('a query narrows media tabs: file names, track titles and performers, link text', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const ab = await makeChat([a, b]);
  const pdf = await put(ab, a, 'file', '', att('file', 'application/pdf', { name: 'Отчёт.pdf' }));
  await put(ab, a, 'file', '', att('file', 'application/zip', { name: 'архив.zip' }));
  const song = await put(ab, b, 'audio', '', att('audio', 'audio/mpeg', { title: 'Купола', performer: 'Михаил Круг', duration: 300 }));
  const link = await put(ab, b, 'text', 'смотри https://relay.app/docs');
  await put(ab, b, 'text', 'и ещё https://example.com');
  expect((await searchMedia(a, 'file', { q: 'отчёт' })).hits.map((h) => h.message.id)).toEqual([pdf]);
  expect((await searchMedia(a, 'audio', { q: 'круг' })).hits.map((h) => h.message.id)).toEqual([song]);
  expect((await searchMedia(a, 'link', { q: 'relay' })).hits.map((h) => h.message.id)).toEqual([link]);
  expect((await searchMedia(a, 'file', { q: '100%_' })).hits).toEqual([]);   // спецсимволы LIKE — буквально
});

test('people: by name among contacts and shared chats, exact @username for anyone; my contact names win; blocked hide photo', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис Смирнов'), c = await makeUser('Вера Смирнова'), s = await makeUser('Смирнов Незнакомый');
  await makeChat([a, b]);
  await sql`insert into contacts (owner_id, user_id, first_name, last_name) values (${a}, ${c}, 'Верочка', '')`;
  await sql`update users set username = 'stranger_one', photo = ${sql.json({ id: 'x', small: 'y', thumb: 'z', at: 1 } as never)} where id = ${s}`;
  const r = await searchPeople(a, 'смирн');
  expect(r.people.map((p) => p.id).sort()).toEqual([b, c].sort());           // незнакомец по имени не находится
  expect((await searchPeople(a, 'верочка')).people.map((p) => p.name)).toEqual(['Верочка']);
  const exact = await searchPeople(a, '@stranger_one');
  expect(exact.people.map((p) => p.id)).toEqual([s]);
  expect(exact.people[0].photo).not.toBeNull();
  expect(r.people.find((p) => p.id === b)?.chatId).not.toBeNull();
  await sql`insert into blocks (owner_id, user_id) values (${s}, ${a})`;
  expect((await searchPeople(a, '@stranger_one')).people[0].photo).toBeNull();
});

test('top peers: direct chats by message count in the last 30 days', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const ab = await makeChat([a, b]), ac = await makeChat([a, c]);
  for (let i = 0; i < 3; i++) await put(ac, c, 'text', 'привет');
  await put(ab, b, 'text', 'старое');
  await sql`update messages set created_at = now() - interval '40 days' where chat_id = ${ab}`;
  await put(ab, b, 'text', 'новое');
  expect((await topPeers(a)).chatIds).toEqual([ac, ab]);
});
