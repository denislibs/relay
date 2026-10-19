import { expect, test } from 'bun:test';
import { autoloadSubtitle, chatKindFor, isDefaultAutoload, mediaPolicy, shouldAutoload } from './autoload';
import { mediaHeld } from '@relay/ui';
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

test('chatKindFor + mediaPolicy: per-chat photo autoload and autoplay flags', () => {
  const contacts = new Set([7]);
  expect(chatKindFor({ kind: 'group', peerId: null }, contacts)).toBe('group');
  expect(chatKindFor({ kind: 'direct', peerId: 7 }, contacts)).toBe('contact');
  expect(chatKindFor({ kind: 'direct', peerId: 8 }, contacts)).toBe('private');
  expect(chatKindFor(undefined, contacts)).toBe('private');
  const p = defaultPrefs();
  expect(mediaPolicy(p, 'group')).toEqual({ photo: true, video: true, file: false, fileMaxMb: 10, autoplayVideo: true, autoplayGif: true });
  p.autoload.file.groups = true;
  expect(mediaPolicy(p, 'group')).toMatchObject({ file: true, fileMaxMb: 10 });
  p.autoload.photo.groups = false; p.anim.autoplayGif = false;
  expect(mediaPolicy(p, 'group')).toMatchObject({ photo: false, autoplayGif: false });
  expect(mediaPolicy(p, 'contact').photo).toBe(true);
  p.autoload.enabled = false;
  expect(mediaPolicy(p, 'contact').photo).toBe(false);
});

test('kit mediaHeld: incoming photo held only when the policy says no; own media and no provider always load', () => {
  const it = [{ src: '/files/a', kind: 'image' }];
  expect(mediaHeld(null, it, false)).toBe(false);
  expect(mediaHeld({ photo: true, video: true }, it, false)).toBe(false);
  expect(mediaHeld({ photo: false, video: true }, it, false)).toBe(true);
  expect(mediaHeld({ photo: false, video: true }, it, true)).toBe(false);   // своё
  expect(mediaHeld({ photo: false, video: true }, [{ src: undefined, kind: 'image' }], false)).toBe(false);
  expect(mediaHeld({ photo: true, video: false }, [{ src: '/files/v', kind: 'video' }], false)).toBe(true);
});
