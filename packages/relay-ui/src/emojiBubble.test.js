import { expect, test } from 'bun:test';
import { emojiFontSize, EMOJI_STICKER_PX } from './emojiBubble.js';

test('размер глифа по числу эмодзи — таблица Telegram', () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8, 100].map(emojiFontSize)).toEqual([112, 90, 84, 72, 60, 48, 36, 36, 36]);
  expect(EMOJI_STICKER_PX).toBe(112);
});
