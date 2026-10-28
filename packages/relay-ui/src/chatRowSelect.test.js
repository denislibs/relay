import { test, expect } from 'bun:test';
import { h } from 'preact';
import { ChatRow } from './kit.js';

// В ките нет ни preact-render-to-string, ни DOM: ChatRow — чистая функция, смотрим на дерево vnode.
function row(extra) { return ChatRow(Object.assign({ name: 'A', preview: 'x', time: '1' }, extra)); }
function classes(v) { return (v && v.props && v.props.class) || ''; }
function hasClass(v, c) {
  if (v == null || typeof v !== 'object') return false;
  if (classes(v).split(' ').indexOf(c) >= 0) return true;
  var kids = v.props && v.props.children;
  return [].concat(kids == null ? [] : kids).some(function (k) { return hasClass(k, c); });
}

test('вне режима — без галочки и без aria-pressed', () => {
  const v = row({});
  expect(hasClass(v, 'rl-row-check')).toBe(false);
  expect(hasClass(v, 'rl-row-sel')).toBe(false);
  expect(v.props['aria-pressed']).toBeUndefined();
});
test('в режиме — галочка; отмеченная — rl-row-sel-on и aria-pressed', () => {
  const off = row({ selecting: true, selected: false });
  const on = row({ selecting: true, selected: true });
  expect(hasClass(off, 'rl-row-check')).toBe(true);
  expect(classes(off)).toContain('rl-row-sel');
  expect(classes(off)).not.toContain('rl-row-sel-on');
  expect(off.props['aria-pressed']).toBe('false');
  expect(classes(on)).toContain('rl-row-sel-on');
  expect(on.props['aria-pressed']).toBe('true');
});
test('selecting/selected не протекают в DOM-атрибуты кнопки', () => {
  const v = row({ selecting: true, selected: true });
  expect('selecting' in v.props).toBe(false);
  expect('selected' in v.props).toBe(false);
});
