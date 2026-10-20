import { expect, test } from 'bun:test';
import { tileSrc } from './mediaGrid';

const photo = { id: 'p1', kind: 'photo', mime: 'image/jpeg' };

test('photo tile: the small server preview when there is one, else the original', () => {
  expect(tileSrc({ ...photo, preview: { name: 'preview', w: 480, h: 360, size: 30000 } })).toBe('/files/p1/preview');
  expect(tileSrc(photo)).toBe('/files/p1');
  expect(tileSrc({ ...photo, preview: null })).toBe('/files/p1');
});
