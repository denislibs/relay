import { expect, test } from 'bun:test';
import { openDb } from '../src/idb';
import { Store } from '../src/store';
import { msg } from './fixtures';

const ME = 1, PEER = 2;
const open = async () => { const name = 'terms-' + crypto.randomUUID(); const db = await openDb(name); return { name, db, s: await Store.open(db, ME) }; };
const rows = (db: IDBDatabase) => new Promise<any[]>((res, rej) => { const r = db.transaction('terms').objectStore('terms').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const words = async (db: IDBDatabase) => (await rows(db)).map((r) => r.term).sort();

test('new message is indexed; edit replaces words; delete removes all', async () => {
  const { db, s } = await open();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 10, chatId: 7, senderId: PEER, body: 'Ёжик пришёл!' }) });
  await s.flush();
  expect(await words(db)).toEqual(['ежик', 'пришел']);
  expect((await rows(db))[0]).toMatchObject({ chatId: 7, sort: 10 });
  s.applyUpdate({ type: 'messageEdited', chatId: 7, id: 10, body: 'Ёжик ушёл', editedAt: new Date().toISOString() } as any);
  await s.flush();
  expect(await words(db)).toEqual(['ежик', 'ушел']);
  s.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 10 } as any);
  await s.flush();
  expect(await words(db)).toEqual([]);
});

test('edit and delete between flushes still clean old words', async () => {
  const { db, s } = await open();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 10, chatId: 7, senderId: PEER, body: 'alpha beta' }) });
  await s.flush();
  s.applyUpdate({ type: 'messageEdited', chatId: 7, id: 10, body: 'gamma', editedAt: new Date().toISOString() } as any);
  s.applyUpdate({ type: 'messageEdited', chatId: 7, id: 10, body: 'alpha delta', editedAt: new Date().toISOString() } as any);
  await s.flush();
  expect(await words(db)).toEqual(['alpha', 'delta']);
});

test('pending message is not indexed; ack indexes it under the new sort', async () => {
  const { db, s } = await open();
  const clientId = crypto.randomUUID();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 10, chatId: 7, senderId: PEER, body: 'seed' }) });
  s.addPending({ clientId, chatId: 7, body: 'pending words', createdAt: Date.now() } as any);
  await s.flush();
  expect(await words(db)).toEqual(['seed']);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 11, chatId: 7, senderId: ME, clientId, body: 'pending words' }) });
  await s.flush();
  const r = await rows(db);
  expect(r.map((x) => x.term).sort()).toEqual(['pending', 'seed', 'words']);
  expect(r.find((x) => x.term === 'pending')).toMatchObject({ sort: 11, key: clientId });
});

test('removing a chat deletes its terms; other chats keep theirs', async () => {
  const { db, s } = await open();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 10, chatId: 7, senderId: PEER, body: 'one two' }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 11, chatId: 8, senderId: PEER, body: 'three' }) });
  await s.flush();
  expect(await words(db)).toEqual(['one', 'three', 'two']);
  s.resetDialogs();
  await s.flush();
  expect(await words(db)).toEqual([]);
});

test('removeChat deletes only that chat terms (even when messages are not in memory)', async () => {
  const { name, db, s } = await open();
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 10, chatId: 7, senderId: PEER, body: 'one two' }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 11, chatId: 8, senderId: PEER, body: 'three' }) });
  await s.flush();
  const again = await Store.open(await openDb(name), ME);   // сообщения только в IDB
  again.removeChat(7);
  await again.flush();
  expect(await words(db)).toEqual(['three']);
});

const row = (db: IDBDatabase, key: string) => new Promise<any>((res, rej) => { const r = db.transaction('messages').objectStore('messages').get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

test('delete/edit of a cached but unloaded message repairs the stored row and its terms', async () => {
  const { name, db, s } = await open();
  const a = msg({ id: 10, chatId: 7, senderId: PEER, body: 'secret words' }), b = msg({ id: 11, chatId: 7, senderId: PEER, body: 'old text' });
  s.applyUpdate({ type: 'newMessage', message: a });
  s.applyUpdate({ type: 'newMessage', message: b });
  await s.flush();
  const again = await Store.open(await openDb(name), ME);   // сообщения только в IDB
  again.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 10 } as any);
  again.applyUpdate({ type: 'messageEdited', chatId: 7, id: 11, body: 'new text', editedAt: new Date().toISOString() } as any);
  await again.flush();
  expect(await words(db)).toEqual(['new', 'text']);
  expect(await row(db, a.clientId)).toBeUndefined();   // удалённое — строки нет совсем
  expect(await row(db, b.clientId)).toMatchObject({ body: 'new text' });
});

const reopened = async () => {
  const { name, db, s } = await open();
  const a = msg({ id: 10, chatId: 7, senderId: PEER, body: 'alpha beta' });
  s.applyUpdate({ type: 'newMessage', message: a });
  await s.flush();
  return { db, a, again: await Store.open(await openDb(name), ME) };
};
const edit = (s: Store, body: string) => s.applyUpdate({ type: 'messageEdited', chatId: 7, id: 10, body, editedAt: new Date().toISOString() } as any);

test('edit then delete of an unloaded message in one flush leaves nothing', async () => {
  const { db, a, again } = await reopened();
  edit(again, 'gamma');
  again.applyUpdate({ type: 'messageDeleted', chatId: 7, id: 10 } as any);
  await again.flush();
  expect(await words(db)).toEqual([]);
  expect(await row(db, a.clientId)).toBeUndefined();
});

test('two edits of an unloaded message: final body and only its terms', async () => {
  const { db, a, again } = await reopened();
  edit(again, 'gamma');
  edit(again, 'delta');
  await again.flush();
  expect(await words(db)).toEqual(['delta']);
  expect(await row(db, a.clientId)).toMatchObject({ body: 'delta' });
});

test('queued edit then load then a newer edit in memory: the newer one wins', async () => {
  const { db, a, again } = await reopened();
  edit(again, 'gamma');
  await again.loadChatMessages(7);
  expect(again.messageById(7, 10)!.body).toBe('gamma');
  edit(again, 'delta');
  await again.flush();
  expect(await words(db)).toEqual(['delta']);
  expect(await row(db, a.clientId)).toMatchObject({ body: 'delta' });
});
