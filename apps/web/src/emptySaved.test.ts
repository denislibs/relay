import { test, expect } from 'bun:test';
import { isEmptySaved } from './chatFlags';

// как в Telegram (tweb, telegram-tt): пустое «Избранное» в списке не стоит, строка появляется с первым сообщением
const saved = { id: 1, saved: true, last: null, draft: null, pinnedAt: null };
test('пустое «Избранное» — не в списке', () => { expect(isEmptySaved(saved)).toBe(true); });
test('с сообщением, черновиком или закреплённое — в списке', () => {
  expect(isEmptySaved({ ...saved, last: { id: 5, body: 'заметка' } })).toBe(false);
  expect(isEmptySaved({ ...saved, draft: 'черновик' })).toBe(false);
  expect(isEmptySaved({ ...saved, pinnedAt: 1 })).toBe(false);
});
test('обычный пустой чат правило не трогает', () => {
  expect(isEmptySaved({ ...saved, saved: undefined })).toBe(false);
  expect(isEmptySaved(undefined)).toBe(false);
});
