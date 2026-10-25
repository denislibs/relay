import { expect, test } from 'bun:test';
import { groupByChat, mediaKey, messagesLabel, movedTooFar, toggleKey } from './mediaSelect';

test('key holds chat and message: same id in two chats is two tiles', () => {
  expect(mediaKey(5, 10)).toBe('5:10');
  expect(mediaKey(6, 10)).not.toBe(mediaKey(5, 10));
});

test('toggle adds in pick order and removes', () => {
  let sel: string[] = [];
  sel = toggleKey(sel, '1:3');
  sel = toggleKey(sel, '1:1');
  expect(sel).toEqual(['1:3', '1:1']);
  expect(toggleKey(sel, '1:3')).toEqual(['1:1']);
  expect(toggleKey(['1:1'], '1:1')).toEqual([]);
});

test('grouped by source chat in order of first pick; unknown keys skipped', () => {
  const items: Record<string, { id: number }> = { '1:3': { id: 3 }, '2:7': { id: 7 }, '1:1': { id: 1 } };
  expect(groupByChat(['1:3', '2:7', 'x', '1:1', '9:9'], (k) => items[k])).toEqual([
    { chatId: 1, items: [{ id: 3 }, { id: 1 }] },
    { chatId: 2, items: [{ id: 7 }] },
  ]);
  expect(groupByChat([], (k) => items[k])).toEqual([]);
});

test('messages label in Russian plural forms', () => {
  expect(messagesLabel(1)).toBe('1 сообщение');
  expect(messagesLabel(3)).toBe('3 сообщения');
  expect(messagesLabel(5)).toBe('5 сообщений');
  expect(messagesLabel(11)).toBe('11 сообщений');
  expect(messagesLabel(12)).toBe('12 сообщений');
  expect(messagesLabel(21)).toBe('21 сообщение');
  expect(messagesLabel(24)).toBe('24 сообщения');
});

test('long press is cancelled by a finger that moved like a scroll', () => {
  expect(movedTooFar(0, 0, 3, 4)).toBe(false);
  expect(movedTooFar(0, 0, 0, 11)).toBe(true);
});
