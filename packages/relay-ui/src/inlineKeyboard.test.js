import { test, expect } from 'bun:test';
import { keyboardRows } from './inlineKeyboard.js';

test('rows keep their order; callback keeps data, url keeps only http(s)', () => {
  expect(keyboardRows([
    [{ text: 'Это я', kind: 'callback', data: 'login:ok:1' }, { text: 'Сайт', kind: 'url', url: 'https://relay.example/x' }],
    [{ text: 'Всё', kind: 'callback', data: 'login:others:1' }],
  ])).toEqual([
    [{ text: 'Это я', kind: 'callback', data: 'login:ok:1' }, { text: 'Сайт', kind: 'url', url: 'https://relay.example/x' }],
    [{ text: 'Всё', kind: 'callback', data: 'login:others:1' }],
  ]);
});

test('dangerous or broken links stay visible but lead nowhere', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'https://a b', '', 5, undefined]) {
    expect(keyboardRows([[{ text: 'x', kind: 'url', url }]])).toEqual([[{ text: 'x', kind: 'url', url: null }]]);
  }
});

test('junk is dropped: unknown kinds, empty text, empty rows; nothing left → null', () => {
  expect(keyboardRows(null)).toBeNull();
  expect(keyboardRows(undefined)).toBeNull();
  expect(keyboardRows([])).toBeNull();
  expect(keyboardRows([[], [{ text: '  ', kind: 'callback', data: 'a' }], [{ text: 'x', kind: 'game' }], 'row', [null]])).toBeNull();
  expect(keyboardRows([[{ text: 'ok', kind: 'callback' }], []])).toEqual([[{ text: 'ok', kind: 'callback', data: '' }]]);
});
