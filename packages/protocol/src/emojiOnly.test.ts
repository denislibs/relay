import { expect, test } from 'bun:test';
import { emojiOnly } from './emoji';

test('один эмодзи — count 1 и ключ без FE0F/тона', () => {
  expect(emojiOnly('❤️')).toEqual({ count: 1, keys: ['❤'] });
  expect(emojiOnly('👍🏽')).toEqual({ count: 1, keys: ['👍'] });
  expect(emojiOnly(' 🔥 \n')).toEqual({ count: 1, keys: ['🔥'] });
});

test('несколько эмодзи и строки — count как размер сетки', () => {
  expect(emojiOnly('😀😃😄')?.count).toBe(3);
  expect(emojiOnly('😀 😃  😄')?.count).toBe(3);        // пробелы не считаются
  expect(emojiOnly('😀😃\n😄')?.count).toBe(2);         // строк 2, в строке максимум 2
  expect(emojiOnly('😀\n😃\n😄')?.count).toBe(3);
  expect(emojiOnly('😀😃😄😁😆😅🤣😂')?.count).toBe(8);
});

test('составные эмодзи — одна графема: ZWJ, флаги, keycap, ❤‍🔥', () => {
  expect(emojiOnly('👨‍👩‍👧‍👦')?.count).toBe(1);
  expect(emojiOnly('🇷🇺🇺🇸')?.count).toBe(2);
  expect(emojiOnly('1️⃣')?.count).toBe(1);
  expect(emojiOnly('❤️‍🔥')).toEqual({ count: 1, keys: ['❤‍🔥'] });
  expect(emojiOnly('🏳️‍🌈')?.count).toBe(1);
});

test('текст, цифры, оформление, пусто — не эмодзи-сообщение', () => {
  expect(emojiOnly('👍 класс')).toBeNull();
  expect(emojiOnly('ok')).toBeNull();
  expect(emojiOnly('1')).toBeNull();
  expect(emojiOnly('')).toBeNull();
  expect(emojiOnly('   ')).toBeNull();
  expect(emojiOnly('😀', [{ type: 'bold' }])).toBeNull();
  expect(emojiOnly('😀'.repeat(101))).toBeNull();
});
