import { expect, test } from 'bun:test';
import { unsupportedText } from './messageStub';

const msg = (o: Record<string, unknown>) => ({ key: 'k', kind: 'text', body: '', ...o });

test('unknown kind asks to update, even with a caption', () => {
  expect(unsupportedText(msg({ kind: 'poll', body: 'Куда едем?' }))).toContain('не поддерживается');
});

test('known kinds that came without content are unavailable, not blank', () => {
  expect(unsupportedText(msg({}))).toBe('Сообщение недоступно');
  expect(unsupportedText(msg({ kind: 'sticker', sticker: null }))).toBe('Стикер недоступен');
  expect(unsupportedText(msg({ kind: 'todo' }))).toBe('Чек-лист недоступен');
});

test('normal messages get no stub', () => {
  expect(unsupportedText(msg({ body: 'привет' }))).toBeNull();
  expect(unsupportedText(msg({ blocks: [{ t: 'p' }] }))).toBeNull();
  expect(unsupportedText(msg({ buttons: [] }))).toBeNull();
  expect(unsupportedText(msg({ service: { type: 'welcome' } }))).toBeNull();
  expect(unsupportedText(msg({ kind: 'photo' }))).toBeNull();
});
