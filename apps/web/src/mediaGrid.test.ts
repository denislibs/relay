import { expect, test } from 'bun:test';
import { scrollAt, tabLabel, tabScrollTarget, tileSrc, videoFrameSrc } from './mediaGrid';

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

test('panel header names the current tab when the tabs are stuck', () => {
  expect(tabLabel('members')).toBe('Участники');
  expect(tabLabel('media')).toBe('Медиа');
  expect(tabLabel('file')).toBe('Файлы');
  expect(tabLabel('link')).toBe('Ссылки');
  expect(tabLabel('audio')).toBe('Музыка');
  expect(tabLabel('voice')).toBe('Голосовые');
});

test('tab click while the profile is visible: scroll so the tabs reach the top; already stuck — no scroll', () => {
  // вкладки на 300 px ниже верха прокрутки, прокручено 40 — нужно 340
  expect(tabScrollTarget({ scrollTop: 40, offset: 300, max: 2000 })).toBe(340);
  // дальше конца прокрутки не уехать
  expect(tabScrollTarget({ scrollTop: 40, offset: 300, max: 200 })).toBe(200);
  // уже прилипли (или в пределах пикселя) — ничего не делаем
  expect(tabScrollTarget({ scrollTop: 500, offset: 0, max: 2000 })).toBeNull();
  expect(tabScrollTarget({ scrollTop: 500, offset: 0.6, max: 2000 })).toBeNull();
  // уже у конца прокрутки — ехать некуда
  expect(tabScrollTarget({ scrollTop: 200, offset: 50, max: 200 })).toBeNull();
});

test('scroll tween: ~300 ms ease from start to end, monotonic, ends exactly on the target', () => {
  expect(scrollAt(100, 400, 300, 0)).toBe(100);
  expect(scrollAt(100, 400, 300, 300)).toBe(400);
  expect(scrollAt(100, 400, 300, 999)).toBe(400);
  const mid = scrollAt(100, 400, 300, 150);
  expect(mid).toBeGreaterThan(100);
  expect(mid).toBeLessThan(400);
  let prev = 100;
  for (let t = 0; t <= 300; t += 10) { const y = scrollAt(100, 400, 300, t); expect(y).toBeGreaterThanOrEqual(prev); prev = y; }
});
