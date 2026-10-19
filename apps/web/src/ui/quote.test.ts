import { expect, test } from 'bun:test';
import { quoteContent } from './preview';

const flat = (v: unknown): string => (Array.isArray(v) ? v.map(flat).join('') : typeof v === 'string' ? v : '');
const txt = (m: Record<string, unknown>) => { const q = quoteContent(m); return { text: flat(q.text), thumb: q.thumbBg ?? q.thumbSrc ?? null }; };

test('a quote says what the message is, for every kind, with a thumbnail for pictures', () => {
  const thumb = 'data:image/jpeg;base64,AAAA';
  expect(txt({ senderId: 1, body: '', kind: 'photo', attachment: { kind: 'photo', mime: 'image/jpeg', name: 'a.jpg', thumb } })).toEqual({ text: 'Фото', thumb });
  expect(txt({ senderId: 1, body: 'закат', kind: 'photo', attachment: { kind: 'photo', mime: 'image/jpeg', name: 'a.jpg', thumb } })).toEqual({ text: 'закат', thumb });
  expect(txt({ senderId: 1, body: '', kind: 'file', attachment: { kind: 'file', mime: 'video/mp4', name: 'v.mp4', thumb } })).toEqual({ text: 'Видео', thumb });
  expect(txt({ senderId: 1, body: '', kind: 'audio', attachment: { kind: 'audio', mime: 'audio/mpeg', name: 'track.mp3', title: 'Офисный планктон', performer: 'Claude' } }).text).toBe('🎧 Офисный планктон — Claude');
  expect(txt({ senderId: 1, body: '', kind: 'file', attachment: { kind: 'file', mime: 'application/pdf', name: 'отчёт.pdf' } }).text).toBe('📎 отчёт.pdf');
  expect(txt({ senderId: 1, body: '', kind: 'voice', attachment: { kind: 'voice', mime: 'audio/ogg', name: 'v.ogg', duration: 75 } }).text).toBe('🎤 Голосовое сообщение · 1:15');
  expect(txt({ senderId: 1, body: '', kind: 'todo', todo: { title: 'Покупки' } }).text).toBe('☑️ Покупки');
  expect(txt({ senderId: 1, body: 'уже нет', deleted: true }).text).toBe('Сообщение удалено');
  expect(txt({ senderId: 1, body: 'просто текст' })).toEqual({ text: 'просто текст', thumb: null });
  // фото с id — настоящий файл, миниатюра подложкой
  expect(quoteContent({ senderId: 1, body: '', kind: 'photo', attachment: { id: 'abc', kind: 'photo', mime: 'image/png', name: 'p.png', thumb } })).toMatchObject({ thumbSrc: '/files/abc', thumbBg: thumb });
});
