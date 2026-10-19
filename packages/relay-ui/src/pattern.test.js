import { expect, test } from 'bun:test';
import { buildPattern, patternColor } from './more.js';

test('pattern color is derived from the wallpaper background', () => {
  // светлые обои: тот же тон, насыщеннее и темнее, прозрачность 40%
  expect(patternColor(['#bdcd8c'])).toBe('rgba(119,133,75,0.4)');
  // тёмные обои: узор светлее фона
  const [r, g, b] = patternColor(['#14251f']).match(/\d+/g).map(Number);
  expect(r + g + b).toBeGreaterThan(0x14 + 0x25 + 0x1f);
  // несколько цветов градиента — по среднему
  expect(patternColor(['#a0a0a0', '#606060'])).toBe(patternColor(['#808080']));
});

test('buildPattern: unknown / prototype names fall back to the default set', () => {
  const def = buildPattern('catsAndDogs', '#000');
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'nope']) expect(buildPattern(name, '#000')).toBe(def);
  expect(typeof def).toBe('string');
});

test('drawn patterns: a file link until loaded, then the lines in the requested colour; garbage is refused', async () => {
  const { loadPattern, patternSize, PATTERN_SETS } = await import('./more.js');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="#000" d="M0 0h9"/><path d="M1 1h2v2z"/></svg>';
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(url === '/patterns/garden.svg' ? svg : '<html>oops</html>');
  try {
    expect(PATTERN_SETS.garden).toBe('file');
    expect(patternSize('garden')).toBe(500);
    expect(patternSize('catsAndDogs')).toBe(420);
    expect(buildPattern('garden', 'rgba(1,2,3,0.4)')).toBe('"/patterns/garden.svg"');
    await loadPattern('garden');
    const tinted = decodeURIComponent(buildPattern('garden', 'rgba(1,2,3,0.4)'));
    expect(tinted).toContain('stroke="rgba(1,2,3,0.4)"');
    expect(tinted).not.toContain('stroke="#000"');
    expect(tinted).toContain('<svg fill="rgba(1,2,3,0.4)" ');   // детали без своего fill красятся тем же цветом
    await expect(loadPattern('ocean')).rejects.toThrow();
    expect(buildPattern('ocean', '#000')).toBe('"/patterns/ocean.svg"');
  } finally { globalThis.fetch = real; }
});
