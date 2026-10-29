import { expect, test } from 'bun:test';
import { stackDepth } from './global';
import type { ChatFrame } from './global';

const f = (key: string, extra: Partial<ChatFrame> = {}) => ({ key, chatId: 1, ready: true, ...extra }) as ChatFrame;

test('a new bottom chat being staged does not make the visible one look nested', () => {
  // openChat: прежний на экране, новый собирается скрытым вторым кадром (swap)
  const s = { chatStack: [f('a'), f('b', { ready: false, swap: true })], chatLeaving: [] };
  expect(stackDepth(s, 'a')).toBe(1);
  expect(stackDepth(s, 'b')).toBe(1);
});

test('a chat opened inside another is nested, the one under it is not', () => {
  const s = { chatStack: [f('a'), f('b', { ready: false })], chatLeaving: [] };
  expect(stackDepth(s, 'a')).toBe(1);
  expect(stackDepth(s, 'b')).toBe(2);
});

test('a nested chat leaving after «Back» keeps its depth to the end of the transition', () => {
  const s = { chatStack: [f('a')], chatLeaving: [f('b')] };
  expect(stackDepth(s, 'b')).toBe(2);
  expect(stackDepth(s, 'zzz')).toBe(1);
});
