import { test, expect } from 'bun:test';
import { searchKeyAction } from './searchInput.js';

test('Esc clears text first, then blurs an empty field', () => {
  expect(searchKeyAction('Escape', 'abc')).toBe('clear');
  expect(searchKeyAction('Escape', '')).toBe('blur');
});
test('other keys are left to the field', () => {
  expect(searchKeyAction('Enter', 'abc')).toBe(null);
  expect(searchKeyAction('a', '')).toBe(null);
});
