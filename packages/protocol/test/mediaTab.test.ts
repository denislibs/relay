import { expect, test } from 'bun:test';
import { mediaTab, mediaTabs } from '../src/index';

type In = Parameters<typeof mediaTab>[0];
const att = (kind: string, mime: string) => ({ id: 'a', kind, mime, name: 'x', size: 1, w: null, h: null }) as unknown as In['attachment'];
const m = (kind: In['kind'], body = '', attachment: In['attachment'] = null, entities?: In['entities']): In => ({ kind, body, attachment, entities });

test('фото, видео и файл-видео — media', () => {
  expect(mediaTab(m('photo', '', att('photo', 'image/png')))).toBe('media');
  expect(mediaTab(m('video', '', att('video', 'video/mp4')))).toBe('media');
  expect(mediaTab(m('file', '', att('file', 'video/mp4')))).toBe('media');
});
test('прочие файлы — file (и без mime)', () => {
  expect(mediaTab(m('file', '', att('file', 'application/pdf')))).toBe('file');
  expect(mediaTab(m('file', '', null))).toBe('file');
});
test('audio, голос и кружок', () => {
  expect(mediaTab(m('audio', '', att('audio', 'audio/mpeg')))).toBe('audio');
  expect(mediaTab(m('voice', '', att('voice', 'audio/ogg')))).toBe('voice');
  expect(mediaTab(m('round', '', att('round', 'video/mp4')))).toBe('voice');
});
test('ссылка в тексте или сущности — link', () => {
  expect(mediaTab(m('text', 'смотри https://example.com'))).toBe('link');
  expect(mediaTab(m('text', 'WWW.example.com'))).toBe('link');
  expect(mediaTab(m('text', 'тут', null, [{ type: 'link', offset: 0, length: 3, url: 'https://x.y' }]))).toBe('link');
});
test('текст без ссылки, голое «www», служебное — null', () => {
  expect(mediaTab(m('text', 'без ссылок'))).toBeNull();
  expect(mediaTab(m('text', 'www'))).toBeNull();
  expect(mediaTab(m('text', 'https:// '))).toBeNull();
  expect(mediaTab({ ...m('text', 'Код https://relay.app'), service: { type: 'login_code' } })).toBeNull();
});
test('пересечение: фото со ссылкой в подписи — обе вкладки, основная media', () => {
  const x = m('photo', 'см. https://a.b', att('photo', 'image/png'));
  expect(mediaTabs(x)).toEqual(['media', 'link']);
  expect(mediaTab(x)).toBe('media');
});
