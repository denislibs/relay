import { expect, test } from 'bun:test';
import { ACCENTS, accentCss, accentTokens, hexToRgb } from './accent';

const hue = (hex: string) => {
  const [r, g, b] = hexToRgb(hex)!.map((x) => x / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const light = (hex: string) => { const [r, g, b] = hexToRgb(hex)!; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

test('default accent changes nothing', () => {
  expect(accentTokens('green', 'light')).toEqual({});
  expect(accentCss('green')).toBe('');
  expect(accentTokens('nope', 'dark')).toEqual({});
});

test('accent moves brand colors to the picked hue in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    const t = accentTokens('blue', theme);
    expect(Math.abs(hue(t.brand) - hue('#3a8ee6'))).toBeLessThan(6);
    expect(Math.abs(hue(t['brand-text']) - hue('#3a8ee6'))).toBeLessThan(12);
    expect(t['bubble-out']).toBeDefined();
  }
});

test('brightness never goes the wrong way: not lighter in light theme, not darker in dark', () => {
  for (const a of ACCENTS.slice(1)) {
    const l = accentTokens(a.id, 'light');
    expect(light(l['brand-text'])).toBeLessThanOrEqual(light('#1b8755') + 1);
    const d = accentTokens(a.id, 'dark');
    expect(light(d['bubble-out'])).toBeGreaterThanOrEqual(light('#144d37') - 1);
  }
});

test('peer colors are not accent; text on the accent button stays readable', () => {
  const t = accentTokens('violet', 'light');
  expect(t['peer-3']).toBeUndefined();
  expect(t['tile-green']).toBeUndefined();
  expect(['#ffffff', '#0a0a0a']).toContain(t['on-brand']);
  expect(accentTokens('violet', 'light')['on-brand']).toBe('#ffffff');   // фиолетовый тёмный — белый текст
});

test('css mirrors tokens.css selectors', () => {
  const css = accentCss('orange');
  expect(css).toContain('html:root {');
  expect(css).toContain('html:root[data-theme="dark"]');
  expect(css).toContain('prefers-color-scheme: dark');
});
