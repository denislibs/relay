import { expect, test } from 'bun:test';
import { allAdminRights, allRights, type GroupInfo } from '@relay/protocol';
import { getByChat, openDb } from '../src/idb';
import { Store } from '../src/store';
import { msg } from './fixtures';

const ME = 1, PEER = 2;
const info = (p: Partial<GroupInfo> = {}): GroupInfo => ({
  title: 'Дача', about: '', photo: null, ownerId: PEER, rights: allRights(), slowMode: 0, historyHidden: false, joinApproval: false,
  username: null, reactions: { mode: 'all', allowed: [] }, protected: false, members: 3, requests: 0, ...p,
});

test('group updates: info and title, my membership, members revision — and they survive a reopen', async () => {
  const name = 'groups-' + crypto.randomUUID();
  const s = await Store.open(await openDb(name), ME);
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 1, chatId: 9, senderId: PEER }) });
  s.applyUpdate({ type: 'groupUpdated', chatId: 9, group: info({ title: 'Дача 2', about: 'шашлыки', slowMode: 30 }) });
  s.applyUpdate({ type: 'membership', chatId: 9, me: { role: 'admin', admin: { ...allAdminRights(), addAdmins: false }, rank: 'Повар', rights: allRights(), restricted: false } });
  s.applyUpdate({ type: 'members', chatId: 9, upsert: [], remove: [] });
  s.applyUpdate({ type: 'members', chatId: 9, upsert: [], remove: [] });
  await s.flush();
  const again = await Store.open(await openDb(name), ME);
  const chat = again.chats.get(9)!;
  expect(chat.group?.title).toBe('Дача 2');   // название группы — из group, своей копии у чата нет
  expect(chat.group).toMatchObject({ about: 'шашлыки', slowMode: 30 });
  expect(chat.me).toMatchObject({ role: 'admin', rank: 'Повар' });
  expect(chat.membersRev).toBe(2);
});

test('chatRemoved drops the chat, its queued messages and its stored messages', async () => {
  const name = 'groups-' + crypto.randomUUID();
  const db = await openDb(name);
  const s = await Store.open(db, ME);
  for (let i = 1; i <= 5; i++) s.applyUpdate({ type: 'newMessage', message: msg({ id: i, chatId: 9, senderId: PEER }) });
  s.applyUpdate({ type: 'newMessage', message: msg({ id: 6, chatId: 4, senderId: PEER }) });
  await s.flush();
  expect(await getByChat(db, 9)).toHaveLength(5);
  s.applyUpdate({ type: 'chatRemoved', chatId: 9 });
  await s.flush();
  expect(s.chats.has(9)).toBe(false);
  expect(await getByChat(db, 9)).toHaveLength(0);
  expect(await getByChat(db, 4)).toHaveLength(1);   // другие чаты не тронуты
  const again = await Store.open(await openDb(name), ME);
  expect([...again.chats.keys()]).toEqual([4]);
});
