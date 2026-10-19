import { test, expect } from 'bun:test';
import { parseRich } from './settings.js';

const T = (v) => ({ t: 'text', v });
test('plain text and emoji', () => {
  expect(parseRich('привет 👋')).toEqual([T('привет 👋')]);
  expect(parseRich('')).toEqual([]);
  expect(parseRich(null)).toEqual([]);
});
test('links: http(s), bare www, trailing punctuation', () => {
  expect(parseRich('see https://a.com/x?y=1, ok')).toEqual([T('see '), { t: 'link', v: 'https://a.com/x?y=1', href: 'https://a.com/x?y=1' }, T(', ok')]);
  expect(parseRich('www.example.org!')).toEqual([{ t: 'link', v: 'www.example.org', href: 'https://www.example.org' }, T('!')]);
  expect(parseRich('(https://a.com/p).')).toEqual([T('('), { t: 'link', v: 'https://a.com/p', href: 'https://a.com/p' }, T(').')]);
  expect(parseRich('http://a.com/w_(x)')[0]).toEqual({ t: 'link', v: 'http://a.com/w_(x)', href: 'http://a.com/w_(x)' });
});
test('dangerous schemes and markup stay text', () => {
  for (const s of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://a.com', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>']) {
    const r = parseRich(s);
    expect(r.every((p) => p.t === 'text')).toBe(true);
    expect(r.map((p) => p.v).join('')).toBe(s);
  }
});
test('mentions: 5..32 chars, not inside words/emails', () => {
  expect(parseRich('hi @durov!')).toEqual([T('hi '), { t: 'mention', v: '@durov' }, T('!')]);
  expect(parseRich('@abcd')).toEqual([T('@abcd')]);
  expect(parseRich('a@example.com')).toEqual([T('a@example.com')]);
  expect(parseRich('@' + 'a'.repeat(33))).toEqual([T('@' + 'a'.repeat(33))]);
  expect(parseRich('@' + 'a'.repeat(32))[0].t).toBe('mention');
  expect(parseRich('@1abcde')).toEqual([T('@1abcde')]);
});
test('mention inside url is part of the link', () => {
  expect(parseRich('https://t.me/@durov')).toEqual([{ t: 'link', v: 'https://t.me/@durov', href: 'https://t.me/@durov' }]);
});
test('scheme is case-insensitive', () => {
  expect(parseRich('HTTPS://A.com/x')).toEqual([{ t: 'link', v: 'HTTPS://A.com/x', href: 'HTTPS://A.com/x' }]);
  expect(parseRich('WWW.a.com')[0].href).toBe('https://WWW.a.com');
});

test('colour picker maths: hex ⇄ rgb ⇄ hsv round-trips, bad input is refused', async () => {
  const { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } = await import('./settings.js');
  expect(hexToRgb('#fec496')).toEqual([254, 196, 150]);
  expect(hexToRgb('abc')).toEqual([170, 187, 204]);
  expect(hexToRgb('#12345')).toBeNull();
  expect(hexToRgb('red')).toBeNull();
  for (const hex of ['#000000', '#ffffff', '#fec496', '#0f2a3d', '#9fcf98', '#ff0000']) expect(rgbToHex(hsvToRgb(rgbToHsv(hexToRgb(hex))))).toBe(hex);
  expect(rgbToHsv([255, 0, 0])).toEqual([0, 1, 1]);
});
