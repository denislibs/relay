import { expect, test } from 'bun:test';
import { gridCorners, scrollAt, tabCounter, tabLabel, tabScrollTarget, tileSrc, videoFrameSrc } from './mediaGrid';

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

test('virtual grid corners: only the outer corners of the whole grid are rounded (as the CSS grid did)', () => {
  // 7 плиток: 3 + 3 + 1
  expect([0, 1, 2, 3, 4, 5, 6].map((i) => gridCorners(i, 7))).toEqual(['tl', '', 'tr', '', '', 'br', 'bl br']);
  // ровно 6: нижний ряд — левый и правый низ
  expect([3, 4, 5].map((i) => gridCorners(i, 6))).toEqual(['bl', '', 'br']);
  // одна плитка — все четыре; две — верх слева / верх и низ справа
  expect(gridCorners(0, 1)).toBe('tl tr bl br');
  expect([0, 1].map((i) => gridCorners(i, 2))).toEqual(['tl bl', 'tr br']);
});

test('счётчики вкладок для шапки: склонения, фото и видео раздельно', () => {
  const c = { media: 307, file: 8, link: 138, audio: 1, voice: 22, video: 36 };
  expect(tabCounter('media', c)).toBe('271 фото, 36 видео');
  expect(tabCounter('media', { ...c, media: 36 })).toBe('36 видео');
  expect(tabCounter('media', { ...c, media: 5, video: 0 })).toBe('5 фото');
  expect(tabCounter('media', { media: 3 })).toBe('3 медиафайла');
  expect(tabCounter('file', c)).toBe('8 файлов');
  expect(tabCounter('link', c)).toBe('138 ссылок');
  expect(tabCounter('audio', c)).toBe('1 аудиофайл');
  expect(tabCounter('voice', c)).toBe('22 голосовых сообщения');
  expect(tabCounter('voice', { voice: 11 })).toBe('11 голосовых сообщений');
  expect(tabCounter('members', null, 21)).toBe('21 участник');
  expect(tabCounter('file', null)).toBeNull();
  expect(tabCounter('groups', null, null, 13)).toBe('13 общих групп');
  expect(tabCounter('groups', null, null, 2)).toBe('2 общие группы');
  expect(tabCounter('groups', null, null, 21)).toBe('21 общая группа');
});
