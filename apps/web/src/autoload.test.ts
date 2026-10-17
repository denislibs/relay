import { expect, test } from 'bun:test';
import { autoloadSubtitle, isDefaultAutoload, shouldAutoload } from './autoload';
import { defaultPrefs } from './prefs';

const MB = 1024 * 1024;
const al = () => defaultPrefs().autoload;

test('shouldAutoload: master switch, kind × chat flags and file size limit', () => {
  const p = { autoload: al() };
  expect(shouldAutoload(p, { kind: 'photo', chat: 'group', size: 5 * MB })).toBe(true);
  expect(shouldAutoload(p, { kind: 'file', chat: 'private', size: 1 })).toBe(false);   // файлы по умолчанию выкл.
  p.autoload.file.private = true;
  expect(shouldAutoload(p, { kind: 'file', chat: 'private', size: 10 * MB })).toBe(true);
  expect(shouldAutoload(p, { kind: 'file', chat: 'private', size: 10 * MB + 1 })).toBe(false);
  expect(shouldAutoload(p, { kind: 'video', chat: 'contact', size: 900 * MB })).toBe(true);   // лимит только у файлов
  p.autoload.video.contacts = false;
  expect(shouldAutoload(p, { kind: 'video', chat: 'contact', size: 1 })).toBe(false);
  p.autoload.enabled = false;
  expect(shouldAutoload(p, { kind: 'photo', chat: 'contact', size: 1 })).toBe(false);
});

test('autoloadSubtitle', () => {
  const a = al();
  expect(autoloadSubtitle(a, 'photo')).toBe('Вкл. для всех чатов');
  expect(autoloadSubtitle(a, 'file')).toBe('Выкл.');
  a.video = { contacts: true, private: true, groups: false };
  expect(autoloadSubtitle(a, 'video')).toBe('Контакты, личные чаты');
  a.file = { contacts: false, private: false, groups: true };
  a.fileMaxMb = 50;
  expect(autoloadSubtitle(a, 'file')).toBe('Группы, до 50 МБ');
  a.file = { contacts: true, private: true, groups: true };
  expect(autoloadSubtitle(a, 'file')).toBe('Вкл. для всех чатов, до 50 МБ');
});

test('isDefaultAutoload', () => {
  const a = al();
  expect(isDefaultAutoload(a, al())).toBe(true);
  a.fileMaxMb = 50;
  expect(isDefaultAutoload(a, al())).toBe(false);
});
