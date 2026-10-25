import { expect, test } from 'bun:test';
import { bubbleSrc, gridCorners, gridDateIndex, scrollAt, tabCounter, tabLabel, tabScrollTarget, tileSrc, videoFrameSrc, viewerPreview } from './mediaGrid';

const photo = { id: 'p1', kind: 'photo', mime: 'image/jpeg' };

test('photo tile: the small server preview when there is one, else the original', () => {
  expect(tileSrc({ ...photo, preview: { name: 'preview', w: 480, h: 360, size: 30000 } })).toBe('/files/p1/preview');
  expect(tileSrc(photo)).toBe('/files/p1');
  expect(tileSrc({ ...photo, preview: null })).toBe('/files/p1');
});

test('bubble photo: the medium copy (800 px), else the preview of a big original, else the original; the viewer keeps the original', () => {
  const preview = { name: 'preview', w: 480, h: 320, size: 30000 };
  const medium = { name: 'medium', w: 800, h: 533, size: 90000 };
  const big = { ...photo, w: 1600, h: 1067 };
  expect(bubbleSrc({ ...big, preview, variants: [medium] })).toBe('/files/p1/medium');
  // обработано до появления medium (ещё не дозаполнено) — превью вместо оригинала на сотни килобайт
  expect(bubbleSrc({ ...big, preview })).toBe('/files/p1/preview');
  expect(bubbleSrc({ ...big, preview, variants: [] })).toBe('/files/p1/preview');
  // оригинал не больше 800 px — сам размером с medium: резче превью
  expect(bubbleSrc({ ...photo, w: 800, h: 600, preview })).toBe('/files/p1');
  expect(bubbleSrc({ ...photo, w: null, h: null, preview })).toBe('/files/p1');
  // ещё не обработано — оригинал, как раньше
  expect(bubbleSrc(big)).toBe('/files/p1');
  expect(bubbleSrc({ ...big, preview: null })).toBe('/files/p1');
  // видео в пузыре — оригинал (ролик ленты выбирает inlineUrl), копия 720 — не для пузыря
  expect(bubbleSrc({ id: 'v1', kind: 'video', mime: 'video/mp4', w: 1280, h: 720, preview: { name: 'preview', w: 640, h: 360, size: 1 }, variants: [{ name: '720', w: 1280, h: 720, size: 1 }] })).toBe('/files/v1');
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

test('плашка даты над «Медиа»: первая плитка ряда, чей низ ниже линии; зазор — уже следующий ряд', () => {
  // плитка 100 px, зазор 1 px: ряд r занимает [101·r, 101·r + 100)
  const at = (y: number, n = 30) => gridDateIndex(y, 100, 101, n);
  expect(at(-500)).toBe(0);           // сетка ещё ниже вкладок
  expect(at(0)).toBe(0);
  expect(at(99.5)).toBe(0);           // низ первого ряда (100) ещё ниже линии
  expect(at(100)).toBe(3);            // линия ровно по низу ряда — он уже ушёл под вкладки
  expect(at(100.5)).toBe(3);          // линия в зазоре между рядами
  expect(at(101)).toBe(3);
  expect(at(250)).toBe(6);            // любая плитка ряда даёт первую в ряду
  expect(at(5000)).toBe(27);          // ниже конца сетки — последний ряд
  expect(at(5000, 28)).toBe(27);      // неполный последний ряд — его первая плитка
  expect(at(50, 0)).toBe(-1);
  // ряд — делением: тысячи плиток не обходятся
  expect(gridDateIndex(101 * 5000 + 10, 100, 101, 30000)).toBe(15000);
});

test('viewer first layer: what the bubble already shows (medium / preview), never the original itself and never a video', () => {
  const medium = { name: 'medium', w: 800, h: 533, size: 90000 }, preview = { name: 'preview', w: 480, h: 320, size: 30000 };
  const big = { ...photo, w: 1600, h: 1067 };
  expect(viewerPreview({ ...big, preview, variants: [medium] })).toBe('/files/p1/medium');
  expect(viewerPreview({ ...big, preview })).toBe('/files/p1/preview');
  // пузырь показывает сам оригинал — второго слоя нет, он и так грузится
  expect(viewerPreview({ ...photo, w: 800, h: 600, preview })).toBeUndefined();
  expect(viewerPreview(big)).toBeUndefined();
  expect(viewerPreview({ ...big, id: '', variants: [medium] })).toBeUndefined();
  expect(viewerPreview({ id: 'v1', kind: 'video', mime: 'video/mp4', w: 1280, h: 720, preview, variants: [medium] })).toBeUndefined();
});
