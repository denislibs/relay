import { expect, test } from 'bun:test';
import { emojiKey } from './emoji';

test('variation selector is dropped everywhere', () => {
  expect(emojiKey('❤️')).toBe('❤');
  expect(emojiKey('✍️')).toBe('✍');
  expect(emojiKey('❤')).toBe('❤');
  expect(emojiKey('❤️️')).toBe('❤');
});

test('a single skin tone is dropped, mixed tones are kept', () => {
  expect(emojiKey('👍🏽')).toBe('👍');
  expect(emojiKey('🤝🏻')).toBe('🤝');
  expect(emojiKey('✍🏿')).toBe('✍');
  expect(emojiKey('🧑🏻‍🤝‍🧑🏻')).toBe('🧑‍🤝‍🧑');   // один тон на обоих — всё равно один
  expect(emojiKey('🧑🏻‍🤝‍🧑🏿')).toBe('🧑🏻‍🤝‍🧑🏿');
});

test('plain text and empty string are unchanged', () => {
  expect(emojiKey('hello')).toBe('hello');
  expect(emojiKey('')).toBe('');
  expect(emojiKey('👍')).toBe('👍');
});
