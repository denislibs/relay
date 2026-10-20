import { expect, test } from 'bun:test';
import { tileSrc, videoFrameSrc } from './mediaGrid';

const photo = { id: 'p1', kind: 'photo', mime: 'image/jpeg' };

test('photo tile: the small server preview when there is one, else the original', () => {
  expect(tileSrc({ ...photo, preview: { name: 'preview', w: 480, h: 360, size: 30000 } })).toBe('/files/p1/preview');
  expect(tileSrc(photo)).toBe('/files/p1');
  expect(tileSrc({ ...photo, preview: null })).toBe('/files/p1');
});

test('video tile frame: the short muted server preview when there is one, else the original; seeks past a black first frame', () => {
  const v = { id: 'v1', kind: 'video', mime: 'video/mp4' };
  expect(videoFrameSrc({ ...v, preview: { name: 'preview', w: 640, h: 360, size: 900000 } })).toBe('/files/v1/preview#t=0.1');
  expect(videoFrameSrc(v)).toBe('/files/v1#t=0.1');
});
