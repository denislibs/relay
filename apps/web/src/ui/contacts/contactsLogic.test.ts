import { expect, test } from 'bun:test';
import { contactDirty, contactPatch, contactValid, filterContacts, initialsOf, sortContacts } from './contactsLogic';

const c = (key: string, x: Record<string, unknown>) => ({ key, ...x });

test('sort: online first, then last seen desc, then name', () => {
  const list = [
    c('a', { name: 'Яна', online: false, lastSeen: '2026-10-01T10:00:00Z' }),
    c('b', { name: 'Борис', online: true, lastSeen: null }),
    c('c', { name: 'Вера', online: false, lastSeen: '2026-10-02T10:00:00Z' }),
    c('d', { name: 'Анна', online: false, lastSeen: null }),
    c('e', { name: 'Глеб', online: false, lastSeen: null }),
  ];
  expect(sortContacts(list).map((x) => x.key)).toEqual(['b', 'c', 'a', 'd', 'e']);
});

test('filter by contact name, own name and @username', () => {
  const list = [c('a', { name: 'Боря', publicName: 'Борис Котов', username: 'boris_k' }), c('b', { name: 'Вера', publicName: 'Вера', username: null })];
  expect(filterContacts(list, 'бор').map((x) => x.key)).toEqual(['a']);
  expect(filterContacts(list, 'котов').map((x) => x.key)).toEqual(['a']);
  expect(filterContacts(list, '@BORIS').map((x) => x.key)).toEqual(['a']);
  expect(filterContacts(list, '  ').length).toBe(2);
});

test('initials and the edit form', () => {
  expect(initialsOf(' анна ', 'смирнова')).toBe('АС');
  expect(initialsOf('😀x', '')).toBe('😀');
  const base = c('k1', { firstName: 'Боря', lastName: '', note: '' });
  expect(contactDirty(base, { firstName: ' Боря ', lastName: '', note: ' ' })).toBe(false);
  expect(contactPatch(base, { firstName: 'Боря', lastName: 'К', note: 'коллега' })).toEqual({ lastName: 'К', note: 'коллега' });
  expect(contactValid({ firstName: ' ', lastName: '', note: '' })).toBe(false);
  expect(contactValid({ firstName: 'Б', lastName: '', note: '😀'.repeat(128) })).toBe(true);
  expect(contactValid({ firstName: 'Б', lastName: '', note: '😀'.repeat(129) })).toBe(false);
});

test('by name: Latin, then Cyrillic, then the rest under «#»; sections per first letter', async () => {
  const { sortByName, sectionsByLetter, letterOf } = await import('./contactsLogic');
  const list = [c('1', { name: 'Яна' }), c('2', { name: 'azamat' }), c('3', { name: 'Борис' }), c('4', { name: '42 Bot' }), c('5', { name: 'Alibek' }), c('6', { name: 'ёжик' }), c('7', { name: 'Zed' })];
  expect(sortByName(list).map((x) => x.name)).toEqual(['Alibek', 'azamat', 'Zed', 'Борис', 'ёжик', 'Яна', '42 Bot']);
  expect(sectionsByLetter(sortByName(list)).map((s) => s.letter + s.items.length)).toEqual(['A2', 'Z1', 'Б1', 'Ё1', 'Я1', '#1']);
  expect(letterOf('  ника')).toBe('Н');
});
