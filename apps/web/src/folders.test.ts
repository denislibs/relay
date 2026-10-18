import { expect, test } from 'bun:test';
import type { ChatFolder } from '@relay/protocol';
import { chatsWord, folderBadge, folderChats, folderIcon, folderSubtitle, inFolder, recommendedFor, RECOMMENDED, type FolderChat } from './folders';

const F = (o: Partial<ChatFolder> = {}): ChatFolder => ({ id: 2, title: 'П', emoji: null, include: [], exclude: [], contacts: false, nonContacts: false, groups: false, excludeMuted: false, excludeRead: false, ...o });
const friend: FolderChat = { id: 1, kind: 'direct', peerId: 100, unread: 0 };
const stranger: FolderChat = { id: 2, kind: 'direct', peerId: 200, unread: 3 };
const group: FolderChat = { id: 3, kind: 'group', peerId: null, unread: 1 };
const mutedGroup: FolderChat = { id: 4, kind: 'group', peerId: null, unread: 5 };
const ctx = { contacts: new Set([100]), isMuted: (c: FolderChat) => c.id === 4 };
const ids = (l: FolderChat[]) => l.map((c) => c.id);
const all = [friend, stranger, group, mutedGroup];

test('types: contacts, non-contacts, groups', () => {
  expect(ids(folderChats(F({ contacts: true }), all, ctx))).toEqual([1]);
  expect(ids(folderChats(F({ nonContacts: true }), all, ctx))).toEqual([2]);
  expect(ids(folderChats(F({ groups: true }), all, ctx))).toEqual([3, 4]);
  expect(ids(folderChats(null, all, ctx))).toEqual([1, 2, 3, 4]);
});

test('precedence: exclude beats include, include beats exclude-read/muted, flags filter the rest', () => {
  expect(inFolder(F({ include: [1], exclude: [1] }), friend, ctx)).toBe(false);
  expect(inFolder(F({ include: [1], excludeRead: true }), friend, ctx)).toBe(true);          // прочитан, но включён явно
  expect(inFolder(F({ include: [4], excludeMuted: true }), mutedGroup, ctx)).toBe(true);
  expect(ids(folderChats(F({ contacts: true, nonContacts: true, groups: true, excludeRead: true }), all, ctx))).toEqual([2, 3, 4]);
  expect(ids(folderChats(F({ groups: true, excludeMuted: true }), all, ctx))).toEqual([3]);
  expect(ids(folderChats(F({ groups: true, exclude: [3] }), all, ctx))).toEqual([4]);
});

test('badge: unread chats; grey when every unread chat is muted; All ignores muted chats', () => {
  expect(folderBadge(F({ groups: true }), all, ctx)).toEqual({ count: 2, muted: false });
  expect(folderBadge(F({ include: [4] }), all, ctx)).toEqual({ count: 1, muted: true });
  expect(folderBadge(F({ contacts: true }), all, ctx)).toEqual({ count: 0, muted: false });
  expect(folderBadge(null, all, ctx)).toEqual({ count: 2, muted: false });
});

test('icon, subtitle, plural, recommendations hide once added', () => {
  expect(folderIcon(null)).toEqual({ icon: 'chats' });
  expect(folderIcon(F({ emoji: '💼', groups: true }))).toEqual({ icon: 'briefcase' });
  expect(folderIcon(F({ emoji: '🦄' }))).toEqual({ emoji: '🦄' });
  expect(folderIcon(F({ groups: true }))).toEqual({ icon: 'community' });
  expect(folderIcon(F({ include: [1] }))).toEqual({ icon: 'folder' });
  expect(folderSubtitle(F({ groups: true }), 9)).toBe('Все группы');
  expect(folderSubtitle(F({ groups: true, contacts: true }), 21)).toBe('21 чат');
  expect([1, 2, 5, 11, 22, 112].map(chatsWord)).toEqual(['1 чат', '2 чата', '5 чатов', '11 чатов', '22 чата', '112 чатов']);
  expect(recommendedFor([]).map((r) => r.key)).toEqual(['unread', 'personal', 'groups']);
  expect(recommendedFor([{ ...RECOMMENDED[2].folder, id: 5, title: 'Мои группы' }]).map((r) => r.key)).toEqual(['unread', 'personal']);
});

test('toggle a chat in a folder: add to include; remove — from include, and exclude when the type still matches', async () => {
  const { toggleChatInFolder } = await import('./folders');
  const f = F({ include: [], groups: true });
  const added = toggleChatInFolder(F({ exclude: [1] }), friend, ctx);
  expect([added.include, added.exclude]).toEqual([[1], []]);
  const removedByType = toggleChatInFolder(f, group, ctx);
  expect([removedByType.include, removedByType.exclude]).toEqual([[], [3]]);
  const removedExplicit = toggleChatInFolder(F({ include: [1] }), friend, ctx);
  expect([removedExplicit.include, removedExplicit.exclude]).toEqual([[], []]);
});
