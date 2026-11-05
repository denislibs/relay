import { expect, test } from 'bun:test';
import { canOpenSource, chatsText, messagesText, openSourceLabel, savedTitle, type SavedItem } from './savedDialogs';

const row = (p: Partial<SavedItem>) => ({ key: 'x', peer: 'u1', count: 1, lastId: 1, pinnedAt: null, title: 'Имя', photo: null, kind: 'user', access: true, createdAt: null, last: null, ...p }) as SavedItem;

test('склонения в шапке и панели', () => {
  expect([0, 1, 2, 5, 11, 21, 22, 25, 339].map(messagesText)).toEqual(['0 сообщений', '1 сообщение', '2 сообщения', '5 сообщений', '11 сообщений', '21 сообщение', '22 сообщения', '25 сообщений', '339 сообщений']);
  expect([0, 1, 3, 8, 12, 21].map(chatsText)).toEqual(['0 чатов', '1 чат', '3 чата', '8 чатов', '12 чатов', '21 чат']);
});

test('названия: заметки и скрытый автор — свои, без строки не «Чат №N»', () => {
  expect(savedTitle(row({ peer: 'me', title: null }))).toBe('Мои заметки');
  expect(savedTitle(row({ peer: 'hidden', title: null }))).toBe('Автор скрыт');
  expect(savedTitle(null, 'me')).toBe('Мои заметки');
  expect(savedTitle(row({ title: 'Борис' }))).toBe('Борис');
});

test('источник открывается, только если сервер сказал, что он читается', () => {
  expect(canOpenSource(row({}))).toBe(true);
  expect(canOpenSource(row({ access: false }))).toBe(false);
  expect(canOpenSource(row({ peer: 'me' }))).toBe(false);
  expect(canOpenSource(row({ peer: 'hidden', access: true }))).toBe(false);
  expect(canOpenSource(null)).toBe(false);
  expect(openSourceLabel(row({ kind: 'channel' }))).toBe('Открыть канал');
  expect(openSourceLabel(row({ kind: 'group' }))).toBe('Открыть группу');
  expect(openSourceLabel(row({ kind: 'user' }))).toBe('Открыть чат');
});
