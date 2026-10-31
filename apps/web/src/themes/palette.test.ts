import { expect, test } from 'bun:test';
import { contrast, ensureContrast, rgb, toHsv, withMul } from './color';
import { computePalette, paletteCss } from './palette';
import { BASE_COLORS, PRESETS, nearestBaseColor, presetById } from './presets';

const hue = (c: string) => toHsv(rgb(c))[0];
const lum = (c: string) => toHsv(rgb(c))[2];

test('classic and night without a preset are exactly the kit', () => {
  expect(computePalette('classic', null)).toEqual({});
  expect(computePalette('night', null)).toEqual({});
});

test('withMul is the iOS HSV multiply: hue wraps, saturation and brightness clamp at 1', () => {
  const c = withMul(rgb('#3685fa'), 1, 2, 4);
  expect(toHsv(c)[1]).toBeCloseTo(1, 2);
  expect(toHsv(c)[2]).toBeCloseTo(1, 2);
  expect(Math.round(toHsv(withMul(rgb('#ff0000'), 1.5, 1, 1))[0])).toBe(0);   // 0° × 1.5 = 0°
});

test('tinted: every surface comes from the accent, dark and of the accent hue', () => {
  for (const b of BASE_COLORS.filter((x) => x.name !== 'gray')) {
    const p = computePalette('tinted', { accent: b.color });
    for (const name of ['bg', 'panel', 'raised', 'field', 'page', 'bubble-in', 'bubble-out', 'line']) {
      // свой пузырь по формуле iOS — средней яркости (≈0.59), заметно светлее фона; остальное — тёмное
      expect(lum(p[name])).toBeLessThan(name === 'bubble-out' ? 0.65 : 0.45);
      const d = Math.abs(hue(p[name]) - hue(b.color)) % 360;
      expect(Math.min(d, 360 - d)).toBeLessThan(25);
    }
    // ступени глубины, как у iOS: поле ввода темнее фона, фон темнее карточек
    expect(lum(p.page)).toBeLessThan(lum(p.bg));
    expect(lum(p.bg)).toBeLessThan(lum(p.panel));
    expect(p['theme-out-ink']).toBe('#ffffff');
  }
  // синий и оранжевый акцент дают разные фоны — «Тёмная» не захардкожена
  expect(computePalette('tinted', { accent: '#0088ff' }).bg).not.toBe(computePalette('tinted', { accent: '#f08200' }).bg);
});

test('tinted: a very dark accent does not collapse the palette to black (brightness floor 0.18)', () => {
  const p = computePalette('tinted', { accent: '#05080a' });
  expect(lum(p.panel)).toBeGreaterThan(0.03);
});

test('tinted: the wallpaper is the dark gradient of the nearest base color unless the preset brings one', () => {
  expect(nearestBaseColor('#f28a10').name).toBe('orange');
  const p = computePalette('tinted', { accent: '#f28a10' });
  expect([p['wallpaper-1'], p['wallpaper-2'], p['wallpaper-3'], p['wallpaper-4']]).toEqual(BASE_COLORS.find((b) => b.name === 'orange')!.wallpaper);
});

test('day: own bubbles are filled with the accent and their text is white', () => {
  const p = computePalette('day', null);
  expect(p['bubble-out']).toBe('#2d7ed5');
  expect(p['theme-out-ink']).toBe('#ffffff');
  expect(contrast(rgb(p['theme-out-ink']), rgb(p['bubble-out']))).toBeGreaterThanOrEqual(3);
});

test('several bubble colors are averaged into one flat color (as tweb does)', () => {
  const d101 = presetById('day', 'd101')!;
  expect(computePalette('day', d101.settings)['bubble-out']).toBe('#806efa');   // поканально: (00+ff)/2, (88+53)/2, (ff+f4)/2 с округлением
});

test('a pale bubble in a dark theme gets dark text, a saturated one white', () => {
  expect(computePalette('night', { accent: '#00b09b', bubble: ['#fffec7'] })['theme-out-ink']).toBe('#0a0a0a');
  expect(computePalette('night', { accent: '#00b09b', bubble: ['#1a3a8a'] })['theme-out-ink']).toBe('#ffffff');
});

test('every preset computes and stays readable in its own bubble', () => {
  for (const [base, list] of Object.entries(PRESETS)) for (const pr of list) {
    const p = computePalette(base as 'classic', pr.settings);
    if (p['theme-out-ink']) expect(contrast(rgb(p['theme-out-ink']), rgb(p['bubble-out']))).toBeGreaterThanOrEqual(3);
    for (const v of Object.values(p)) expect(v).toMatch(/^(#[0-9a-f]{6}|rgba\(.+\))$/);
  }
});

test('ensureContrast moves toward black on light, toward white on dark, and keeps readable colors', () => {
  const onWhite = ensureContrast(rgb('#9fd3ff'), [255, 255, 255]);
  expect(contrast(onWhite, [255, 255, 255])).toBeGreaterThanOrEqual(4.9);
  const onDark = ensureContrast(rgb('#203040'), [20, 24, 28]);
  expect(contrast(onDark, [20, 24, 28])).toBeGreaterThanOrEqual(4.9);
  expect(ensureContrast(rgb('#000000'), [255, 255, 255])).toEqual([0, 0, 0]);
});

test('high contrast lifts muted text, links and own-bubble meta to 4.9:1', () => {
  for (const base of ['classic', 'night', 'day', 'tinted'] as const) {
    const p = computePalette(base, null, { contrast: true });
    expect(p['ink-muted']).toBeDefined();
    expect(contrast(rgb(p['theme-out-meta']), rgb(p['bubble-out'] ?? (base === 'night' ? '#144d37' : '#d9fdd3')))).toBeGreaterThanOrEqual(4.8);
  }
});

test('paletteCss fills the other side so nothing leaks between light and dark', () => {
  const css = paletteCss(computePalette('day', null), {});
  const dark = css.split('\n')[2];
  expect(dark).toContain('--theme-out-ink: initial;');   // своё — сброшено
  expect(dark).toContain('--bg: #161717;');                // токен кита — его тёмное значение
  expect(paletteCss({}, {})).toBe('');
});
