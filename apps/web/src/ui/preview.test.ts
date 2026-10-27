import { expect, test } from 'bun:test';
import { previewBody, previewThumb } from './preview';

// Превью строки чата: у кода входа цифры — точками, оформление (code, спойлер) отбрасывается.
const flat = (v: unknown): string => (Array.isArray(v) ? v.map(flat).join('') : typeof v === 'string' ? v : '');
const hasSpan = (v: unknown): boolean => Array.isArray(v) && v.some((x) => x && typeof x === 'object');

test('previewBody: login_code is masked and its entities are dropped', () => {
  const body = 'Код для входа в Relay: 48213 Никому не сообщайте';
  const m = { senderId: 1, body, service: { type: 'login_code' }, entities: [{ type: 'spoiler', offset: 0, length: 3 }, { type: 'code', offset: 23, length: 5 }] };
  const out = previewBody(m, false);
  expect(flat(out)).toBe('Код для входа в Relay: ••••• Никому не сообщайте');
  expect(hasSpan(out)).toBe(false);   // спойлер не применён: оформление отброшено
});

test('previewBody: ordinary messages keep their digits and entities', () => {
  const m = { senderId: 1, body: 'тайна 48213', entities: [{ type: 'spoiler', offset: 0, length: 5 }] };
  const out = previewBody(m, false);
  expect(flat(out)).toContain('48213');
  expect(hasSpan(out)).toBe(true);
});

test('music: cover becomes the thumb, text is «title — performer»', () => {
  const m = { senderId: 1, body: '', kind: 'audio', attachmentName: 'x.mp3', attachmentTitle: 'Плачу в код', attachmentPerformer: 'niceraudiostream479', thumb: 'data:image/jpeg;base64,AA' };
  expect(previewThumb(m)).toEqual({ src: m.thumb, video: false });
  expect(flat(previewBody(m, true))).toBe('Плачу в код — niceraudiostream479');
  expect(flat(previewBody({ ...m, thumb: null }, false))).toBe('🎧 Плачу в код — niceraudiostream479');
});

test('round video: circular thumb', () => {
  const m = { senderId: 1, body: '', kind: 'round', thumb: 'data:image/jpeg;base64,AA' };
  expect(previewThumb(m)).toEqual({ src: m.thumb, video: false, round: true });
  expect(flat(previewBody(m, true))).toBe('Видеосообщение');
});

test('sticker in the chat list: no thumbnail, just «😘 Стикер»', () => {
  const m = { senderId: 1, body: '', kind: 'sticker', sticker: { id: 1, setId: 1, format: 'webp' as const, outline: null, url: '/s.webp', w: 512, h: 512, emoji: '😘' } };
  expect(previewThumb(m)).toBeNull();
  expect(flat(previewBody(m, false))).toBe('😘 Стикер');
});
