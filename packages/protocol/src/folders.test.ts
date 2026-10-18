import { expect, test } from 'bun:test';
import { folderError, graphemes, nextFolderId, normalizeFolder, normalizeFolders } from './folders';

const base = { id: 2, title: 'Работа', include: [5], exclude: [] };

test('normalize drops junk, dedupes ids and keeps a chat only in include when it is in both', () => {
  expect(normalizeFolder({ ...base, include: [5, 5, -1, 1.5, 'x', 7], exclude: [7, 8, 8], extra: 1, contacts: 'yes', title: '  Мои   чаты ' }))
    .toEqual({ id: 2, title: 'Мои чаты', emoji: null, include: [5, 7], exclude: [8], contacts: false, nonContacts: false, groups: false, excludeMuted: false, excludeRead: false });
  expect(normalizeFolder({ ...base, id: 1 })).toBeNull();
  expect(normalizeFolder({ ...base, id: 0 })).toBeNull();
  expect(normalizeFolder(null)).toBeNull();
});

test('validation: title 1..12 graphemes, one emoji, at least one chat or type, chat limit', () => {
  const ok = normalizeFolder(base)!;
  expect(folderError(ok)).toBeNull();
  expect(folderError({ ...ok, title: '' })).toBe('folder_title');
  expect(folderError({ ...ok, title: 'абвгдеёжзийк' })).toBeNull();           // 12
  expect(folderError({ ...ok, title: 'абвгдеёжзийкл' })).toBe('folder_title'); // 13
  expect(folderError({ ...ok, title: '👨‍👩‍👧 семья' })).toBeNull();
  expect(graphemes('👨‍👩‍👧')).toBe(1);
  expect(folderError({ ...ok, emoji: '💼' })).toBeNull();
  expect(folderError({ ...ok, emoji: '💼💼' })).toBe('folder_emoji');
  expect(folderError({ ...ok, include: [] })).toBe('folder_empty');
  expect(folderError({ ...ok, include: [], groups: true })).toBeNull();
  expect(folderError({ ...ok, include: Array.from({ length: 201 }, (_, i) => i + 1) })).toBe('folder_too_many_chats');
});

test('list: unique ids, at most 10; next id grows past the largest', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ ...base, id: i + 2 }));
  expect(normalizeFolders([...many, { ...base, id: 2 }]).length).toBe(10);
  expect(normalizeFolders([{ ...base, id: 3 }, { ...base, id: 3, title: 'дубль' }]).map((f) => f.title)).toEqual(['Работа']);
  expect(nextFolderId([])).toBe(2);
  expect(nextFolderId(normalizeFolders([{ ...base, id: 7 }, { ...base, id: 3 }]))).toBe(8);
});
