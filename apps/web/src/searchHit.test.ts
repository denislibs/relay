import { expect, test } from 'bun:test';
import { attachmentHit } from './searchHit';

const song = { kind: 'audio', name: 'track01.mp3', mime: 'audio/mpeg', title: 'Офисный планктон', performer: 'Ария' };
const pdf = { kind: 'file', name: 'Отчёт за май.pdf', mime: 'application/pdf' };

test('attachmentHit: a track found by its tags shows «title — performer», by its file name — the name', () => {
  expect(attachmentHit('', song, 'планктон')).toBe('🎧 Офисный планктон — Ария');
  expect(attachmentHit('', song, 'АРИЯ')).toBe('🎧 Офисный планктон — Ария');
  expect(attachmentHit('', song, 'track01')).toBe('🎧 track01.mp3');
  expect(attachmentHit('', { ...song, title: null }, 'ария')).toBe('🎧 track01 — Ария');   // без названия — имя файла без расширения
});

test('attachmentHit: files by name with their icon; text match wins; typo-only matches fall back sensibly', () => {
  expect(attachmentHit('', pdf, 'отчёт')).toBe('📎 Отчёт за май.pdf');
  expect(attachmentHit('', { kind: 'photo', name: 'море.jpg', mime: 'image/jpeg' }, 'море')).toBe('🖼 море.jpg');
  expect(attachmentHit('', { kind: 'file', name: 'отпуск.mp4', mime: 'video/mp4' }, 'отпуск')).toBe('📹 отпуск.mp4');
  expect(attachmentHit('отчёт во вложении', pdf, 'отчёт')).toBeNull();        // совпал текст — показываем текст
  expect(attachmentHit('смотри', pdf, 'май')).toBe('📎 Отчёт за май.pdf');     // подпись есть, но совпало вложение
  expect(attachmentHit('смотри', pdf, 'отчот')).toBeNull();                    // только опечатка (Meilisearch) — текст
  expect(attachmentHit('', song, 'плонктон')).toBe('🎧 Офисный планктон — Ария');   // текста нет — вложение
  expect(attachmentHit('просто текст', null, 'текст')).toBeNull();
});
