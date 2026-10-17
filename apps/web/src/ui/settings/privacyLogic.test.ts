import { expect, test } from 'bun:test';
import { candidates, parseRulePath, peopleCount, ruleCaption, ruleSubtitle, samePeople, withPeople } from './privacyLogic';
import { lastSeenText } from '../format';

test('rule subtitle: mode label and only the exceptions that matter for it', () => {
  expect(ruleSubtitle({ mode: 'contacts', allow: [1], deny: [2, 3] })).toBe('Мои контакты (−2, +1)');
  expect(ruleSubtitle({ mode: 'everyone', allow: [1], deny: [2] })).toBe('Все (−1)');
  expect(ruleSubtitle({ mode: 'nobody', allow: [1], deny: [2] })).toBe('Никто (+1)');
  expect(ruleSubtitle({ mode: 'contacts', allow: [], deny: [] })).toBe('Мои контакты');
});

test('people count and captions', () => {
  expect(peopleCount(0)).toBe('Добавить пользователей');
  expect([1, 2, 5, 11, 21, 22, 112].map(peopleCount)).toEqual(['1 пользователь', '2 пользователя', '5 пользователей', '11 пользователей', '21 пользователь', '22 пользователя', '112 пользователей']);
  expect(ruleCaption('lastSeen', 'everyone')).not.toContain('недавно');
  expect(ruleCaption('lastSeen', 'nobody')).toContain('был(а) недавно');
  expect(ruleCaption('phone', 'contacts')).toContain('только ваши контакты');
});

test('candidates: contacts first-class, direct peers, already chosen; no self, no duplicates', () => {
  const contacts = [{ key: 'k2', userId: 2, name: 'Борис', username: 'boris_k' }, { key: 'k1', userId: 1, name: 'Я' }];
  const chats = [{ key: 'c1', kind: 'direct', peerId: 2, title: 'Борис Котов' }, { key: 'c2', kind: 'direct', peerId: 3, title: 'Вера' }, { key: 'c3', kind: 'group', peerId: null, title: 'Группа' }];
  expect(candidates(contacts, chats, 1, [9])).toEqual([
    { id: 2, name: 'Борис', about: '@boris_k' },
    { id: 3, name: 'Вера', about: '' },
    { id: 9, name: 'Пользователь', about: '' },
  ]);
});

test('withPeople moves chosen people out of the opposite list; samePeople ignores order', () => {
  expect(withPeople({ mode: 'contacts', allow: [1], deny: [2, 3] }, 'allow', [3, 4])).toEqual({ mode: 'contacts', allow: [3, 4], deny: [2] });
  expect(withPeople({ mode: 'nobody', allow: [1, 5], deny: [] }, 'deny', [5])).toEqual({ mode: 'nobody', deny: [5], allow: [1] });
  expect(samePeople([1, 2], [2, 1])).toBe(true);
  expect(samePeople([1], [1, 2])).toBe(false);
});

test('rule paths', () => {
  expect(parseRulePath('settings/privacy/rule/lastSeen')).toEqual({ key: 'lastSeen', list: null });
  expect(parseRulePath('settings/privacy/rule/phone/deny')).toEqual({ key: 'phone', list: 'deny' });
  expect(parseRulePath('settings/privacy/rule/phoneDiscovery')).toBeNull();
  expect(parseRulePath('settings/privacy/rule/x/allow')).toBeNull();
});

test('last seen hidden by a rule reads «был(а) недавно»', () => {
  expect(lastSeenText(false, 'recently')).toBe('был(а) недавно');
  expect(lastSeenText(false, null)).toBe('был(а) давно');
});
