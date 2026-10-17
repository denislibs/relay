import { expect, test } from 'bun:test';
import { patternColor } from './more.js';

test('pattern color is derived from the wallpaper background', () => {
  // светлые обои: тот же тон, насыщеннее и темнее, прозрачность 40%
  expect(patternColor(['#bdcd8c'])).toBe('rgba(119,133,75,0.4)');
  // тёмные обои: узор светлее фона
  const [r, g, b] = patternColor(['#14251f']).match(/\d+/g).map(Number);
  expect(r + g + b).toBeGreaterThan(0x14 + 0x25 + 0x1f);
  // несколько цветов градиента — по среднему
  expect(patternColor(['#a0a0a0', '#606060'])).toBe(patternColor(['#808080']));
});
