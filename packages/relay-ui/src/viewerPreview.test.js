import { test, expect } from 'bun:test';
import { viewerPreview } from './kit.js';

// слой «копия из пузыря» в просмотре: только у фото и только если это не сам оригинал
test('viewer preview layer: the bubble copy under the original, skipped for videos and when it is the original', () => {
  expect(viewerPreview({ src: '/files/a', preview: '/files/a/medium' })).toBe('/files/a/medium');
  expect(viewerPreview({ src: '/files/a', preview: '/files/a' })).toBeNull();
  expect(viewerPreview({ src: '/files/a' })).toBeNull();
  expect(viewerPreview({ src: '/files/v', preview: '/files/v/medium', kind: 'video' })).toBeNull();
  expect(viewerPreview(null)).toBeNull();
});
