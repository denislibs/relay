import { expect, test } from 'bun:test';
import { comboKeys, comboLabel, matchCombo, parseCombo } from './hotkeys.js';

const ev = (o) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: '', code: '', getModifierState: () => false, ...o });

test('mod is ⌘ on Apple and Ctrl elsewhere; modifiers must match exactly', () => {
  const cmdF = ev({ metaKey: true, key: 'f', code: 'KeyF' });
  const ctrlF = ev({ ctrlKey: true, key: 'f', code: 'KeyF' });
  expect(matchCombo(cmdF, 'mod+f', true)).toBe(true);
  expect(matchCombo(ctrlF, 'mod+f', true)).toBe(false);
  expect(matchCombo(ctrlF, 'mod+f', false)).toBe(true);
  expect(matchCombo(ev({ metaKey: true, shiftKey: true, key: 'F', code: 'KeyF' }), 'mod+f', true)).toBe(false);
  expect(matchCombo(ev({ metaKey: true, shiftKey: true, key: 'F', code: 'KeyF' }), 'mod+shift+f', true)).toBe(true);
});

test('Russian layout matches by physical key; Latin alt layouts by printed letter', () => {
  expect(matchCombo(ev({ metaKey: true, key: 'а', code: 'KeyF' }), 'mod+f', true)).toBe(true);
  // Dvorak: на физической KeyF печатается 'u' — это ⌘U, не ⌘F
  expect(matchCombo(ev({ metaKey: true, key: 'u', code: 'KeyF' }), 'mod+f', true)).toBe(false);
  expect(matchCombo(ev({ metaKey: true, key: 'u', code: 'KeyF' }), 'mod+u', true)).toBe(true);
});

test('digits by code, arrows and named keys', () => {
  expect(matchCombo(ev({ ctrlKey: true, shiftKey: true, key: '!', code: 'Digit1' }), 'ctrl+shift+1', true)).toBe(true);
  expect(matchCombo(ev({ altKey: true, key: 'ArrowUp', code: 'ArrowUp' }), 'alt+arrowup')).toBe(true);
  expect(matchCombo(ev({ key: 'Escape', code: 'Escape' }), 'escape')).toBe(true);
  expect(matchCombo(ev({ key: 'Escape', code: 'Escape', shiftKey: true }), 'escape')).toBe(false);
});

test('parse and labels per platform', () => {
  expect(parseCombo('mod+shift+x', false)).toEqual({ ctrl: true, meta: false, alt: false, shift: true, key: 'x' });
  expect(comboKeys('mod+shift+x', true)).toEqual(['⌘', '⇧', 'X']);
  expect(comboKeys('mod+shift+x', false)).toEqual(['Ctrl', 'Shift', 'X']);
  expect(comboLabel('mod+enter', true)).toBe('⌘↵');
  expect(comboLabel('alt+arrowdown', false)).toBe('Alt+↓');
});
