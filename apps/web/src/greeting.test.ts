import { expect, test } from 'bun:test';
import { greetingChat, historyEmpty } from './greeting';

const ME = 1;
const direct = { id: 10, kind: 'direct', peerId: 2, peer: { id: 2 } };
const plain = { thread: false, blocked: false };

test('greeting chat: only a direct chat with someone else', () => {
  expect(greetingChat(direct, ME, plain)).toBe(true);
  expect(greetingChat({ ...direct, kind: 'group', peerId: null }, ME, plain)).toBe(false);
  expect(greetingChat({ ...direct, kind: 'channel', peerId: null }, ME, plain)).toBe(false);
  expect(greetingChat({ ...direct, peer: { id: 3, system: true }, peerId: 3 }, ME, plain)).toBe(false);   // служебный «Relay»
  expect(greetingChat({ ...direct, peerId: ME }, ME, plain)).toBe(false);                                // с самим собой
  expect(greetingChat({ ...direct, peerId: null }, ME, plain)).toBe(false);
  expect(greetingChat(direct, ME, { thread: true, blocked: false })).toBe(false);
  expect(greetingChat(direct, ME, { thread: false, blocked: true })).toBe(false);                     // писать нельзя
  expect(greetingChat({ ...direct, preview: true }, ME, plain)).toBe(false);
  expect(greetingChat(undefined, ME, plain)).toBe(false);
});

test('history empty: only after the window is known and nothing lies beyond it', () => {
  expect(historyEmpty(null, 0)).toBe(false);                                                    // окно ещё не пришло
  expect(historyEmpty({ hasOlder: true, hasNewer: false, live: true }, 0)).toBe(false);         // первая страница грузится
  expect(historyEmpty({ hasOlder: false, hasNewer: true, live: false }, 0)).toBe(false);
  expect(historyEmpty({ hasOlder: false, hasNewer: false, live: true }, 1)).toBe(false);        // уже есть сообщение
  expect(historyEmpty({ hasOlder: false, hasNewer: false, live: true }, 0)).toBe(true);
});
