import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { Engine } from '../src/engine';
import { localMedia, localPeople, localTop } from '../src/globalSearch';
import { openDb } from '../src/idb';
import { Store } from '../src/store';
import { msg, resetDb, startTestServer, watchInto } from './helpers';

const ME = 1;
const open = async () => { const db = await openDb('gsearch-' + crypto.randomUUID()); return { db, s: await Store.open(db, ME) }; };
const user = (id: number, name: string, username: string | null = null, extra: Record<string, unknown> = {}) =>
  ({ id, name, firstName: name.split(' ')[0], lastName: name.split(' ')[1] ?? '', username, bio: null, birthday: null, phone: null, links: [], ...extra });
const contact = (id: number, firstName: string, lastName = '') => ({ userId: id, firstName, lastName, note: '', user: user(id, 'Профиль ' + id) });
const direct = (id: number, peer: number, peerName: string) => ({ id, kind: 'direct' as const, title: null, lastReadId: 0, unread: 0, last: null, peer: { id: peer, name: peerName } });

// ---------- люди ----------

test('local people: every word by prefix of a name word, username, contacts first; self and system excluded', async () => {
  const { s } = await open();
  s.applyChats([direct(10, 2, 'Анна Петрова')]);   // до профиля: краткий peer из списка чатов не несёт фото
  s.profile.applyUser(user(ME, 'Анна Я'));
  s.profile.applyUser(user(2, 'Анна Петрова', 'anya_p', { photo: { id: 'p2', small: 's2', thumb: '', at: 0 } }));
  s.profile.applyUser(user(3, 'Антон Смирнов', 'tony'));
  s.profile.applyUser(user(4, 'Relay', 'relay', { system: true }));
  s.profile.applyUser(user(5, 'Борис Ёлкин'));
  s.contacts.applySnapshot([{ ...contact(3, 'Антон', 'Работа'), user: user(3, 'Антон Смирнов', 'tony') }], 1);
  const view = s.contacts.table.rows;
  const find = (q: string) => localPeople(s, view, ME, q).map((p) => p.id);

  expect(find('ан')).toEqual([3, 2]);          // контакт первым, затем по имени; себя (Анна Я) нет
  expect(find('анна пет')).toEqual([2]);       // все слова — по началу слов
  expect(find('пет анна')).toEqual([2]);
  expect(find('анна смир')).toEqual([]);
  expect(find('работа')).toEqual([3]);         // контактное имя
  expect(find('смирн')).toEqual([3]);          // и собственное имя профиля
  expect(find('@ton')).toEqual([3]);           // @имя по началу
  expect(find('anya')).toEqual([2]);
  expect(find('relay')).toEqual([]);           // системный
  expect(find('елк')).toEqual([5]);            // ё = е
  expect(find('')).toEqual([]);
  const anna = localPeople(s, view, ME, 'анна')[0];
  expect(anna).toEqual({ id: 2, name: 'Анна Петрова', username: 'anya_p', photo: { id: 'p2', small: 's2', thumb: '', at: 0 }, chatId: 10 });
  expect(localPeople(s, view, ME, 'антон')[0].chatId).toBeNull();
});

test('local people: limit 20', async () => {
  const { s } = await open();
  for (let i = 0; i < 30; i++) s.profile.applyUser(user(100 + i, 'Иван ' + String.fromCharCode(1072 + i)));
  expect(localPeople(s, s.contacts.table.rows, ME, 'иван').length).toBe(20);
});

// ---------- медиа ----------

const photo = (id: string, name = 'IMG.jpg') => ({ id, kind: 'photo', mime: 'image/jpeg', name, size: 1, w: 1, h: 1 });
const file = (id: string, name: string) => ({ id, kind: 'file', mime: 'application/pdf', name, size: 1, w: null, h: null });

async function mediaCase() {
  const { db, s } = await open();
  s.profile.applyUser(user(2, 'Анна'));
  s.applyChats([direct(7, 2, 'Анна')]);
  const put = (id: number, chatId: number, p: Record<string, unknown>) => s.applyUpdate({ type: 'newMessage', message: msg({ id, chatId, senderId: 2, ...p } as never) });
  put(1, 7, { kind: 'photo', body: 'море', attachment: photo('a1') });
  put(2, 8, { kind: 'file', body: '', attachment: file('a2', 'Отчёт квартал.pdf') });
  put(3, 8, { kind: 'photo', body: 'горы https://x.y', attachment: photo('a3') });
  put(4, 7, { body: 'смотри https://example.com' });
  put(5, 7, { kind: 'photo', body: 'удалю', attachment: photo('a5') });
  put(6, 8, { kind: 'photo', body: 'закат', attachment: photo('a6') });
  put(7, 7, { body: 'просто текст' });
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 5 });
  await s.flush();
  return { db, s };
}

test('local media: kind filter across chats, newest first, deleted excluded, chat title and kind', async () => {
  const { db, s } = await mediaCase();
  const ids = async (kind: 'media' | 'file' | 'link', q = '', before?: number) => (await localMedia(db, s, kind, q, before)).hits.map((h) => h.message.id);
  expect(await ids('media')).toEqual([6, 3, 1]);
  expect(await ids('file')).toEqual([2]);
  expect(await ids('link')).toEqual([4, 3]);   // ссылка и в подписи фото
  const r = await localMedia(db, s, 'media', '', undefined);
  expect(r.hits[2]).toMatchObject({ chatTitle: 'Анна', chatKind: 'direct', message: { id: 1, chatId: 7, body: 'море' } });
  expect(r.hits[2].message).not.toHaveProperty('key');
  expect(r.hits[2].message).not.toHaveProperty('tab');
  expect(r.hasMore).toBe(false);
});

test('local media: q by word prefix of body and file name', async () => {
  const { db, s } = await mediaCase();
  const ids = async (kind: 'media' | 'file' | 'link', q: string) => (await localMedia(db, s, kind, q, undefined)).hits.map((h) => h.message.id);
  expect(await ids('media', 'гор')).toEqual([3]);
  expect(await ids('file', 'отчет кварт')).toEqual([2]);
  expect(await ids('file', 'годовой')).toEqual([]);
  expect(await ids('link', 'смотри')).toEqual([4]);
});

test('local media: paging by before, hasMore', async () => {
  const { db, s } = await open();
  for (let id = 1; id <= 9; id++) s.applyUpdate({ type: 'newMessage', message: msg({ id, chatId: 7 + (id % 3), senderId: 2, kind: 'photo', attachment: photo('p' + id) } as never) });
  await s.flush();
  const p1 = await localMedia(db, s, 'media', '', undefined, 4);
  expect(p1.hits.map((h) => h.message.id)).toEqual([9, 8, 7, 6]);
  expect(p1.hasMore).toBe(true);
  const p2 = await localMedia(db, s, 'media', '', 6, 4);
  expect(p2.hits.map((h) => h.message.id)).toEqual([5, 4, 3, 2]);
  expect(p2.hasMore).toBe(true);
  const p3 = await localMedia(db, s, 'media', '', 2, 4);
  expect(p3.hits.map((h) => h.message.id)).toEqual([1]);
  expect(p3.hasMore).toBe(false);
});

test('local top: direct chats by the last message, not the service chat', async () => {
  const { s } = await open();
  s.applyChats([direct(7, 2, 'Анна'), direct(8, 3, 'Борис'), { ...direct(9, 4, 'Relay'), peer: { id: 4, name: 'Relay', system: true } },
    { id: 11, kind: 'group', title: 'Группа', lastReadId: 0, unread: 0, last: null }]);
  const at = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 8, senderId: 3, createdAt: at(1) }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 2, chatId: 7, senderId: 2, createdAt: at(2) }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 3, chatId: 9, senderId: 4, createdAt: at(3) }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 4, chatId: 11, senderId: 2, createdAt: at(4) }) });
  expect(localTop(s)).toEqual([7, 8]);
});

// ---------- через движок: с сетью — сервер, без сети — устройство ----------

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });

test('engine: online people/media/top come from the server; offline — from the device', async () => {
  await resetDb();
  const a = await srv.login('Анна'), b = await srv.login('Борис Котов');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  await sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body: 'глянь https://example.com' });
  const ea = await Engine.open(srv.config(a));
  engines.push(ea);
  ea.connect();
  await ea.whenIdle();
  const feed = watchInto(ea, { kind: 'messages', chatId, limit: 50 });
  await feed.until((l) => l.length === 1);
  await ea.whenIdle();

  // с сетью: ответ сервера (у сервера — точное совпадение подстроки «отов», у устройства — только начало слова)
  expect((await ea.call({ type: 'searchPeople', q: 'отов' }) as { id: number }[]).map((p) => p.id)).toEqual([b.userId]);
  const online = await ea.call({ type: 'searchMedia', kind: 'link', q: '' }) as { hits: { message: { body: string }; chatKind: string }[] };
  expect(online.hits.map((h) => [h.message.body, h.chatKind])).toEqual([['глянь https://example.com', 'direct']]);
  expect(await ea.call({ type: 'topChats' })).toEqual([chatId]);

  ea.disconnect();
  await Bun.sleep(20);
  expect(await ea.call({ type: 'searchPeople', q: 'отов' })).toEqual([]);
  expect(await ea.call({ type: 'searchPeople', q: 'кот' })).toEqual([{ id: b.userId, name: 'Борис Котов', username: null, photo: null, chatId }]);
  const offline = await ea.call({ type: 'searchMedia', kind: 'link', q: 'глян' }) as { hits: { message: { body: string }; chatTitle: string }[]; hasMore: boolean };
  expect(offline.hits.map((h) => [h.message.body, h.chatTitle])).toEqual([['глянь https://example.com', 'Борис Котов']]);
  expect(offline.hasMore).toBe(false);
  expect(await ea.call({ type: 'topChats' })).toEqual([chatId]);
});
