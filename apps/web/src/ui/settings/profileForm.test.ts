import { expect, test } from 'bun:test';
import { age, birthdayText } from '../format';
import { canSave, formFromMe, isDirty, profilePatch, usernameShapeOk } from './profileForm';

const me = { userId: 1, name: 'Анна Смирнова', firstName: 'Анна', lastName: 'Смирнова', username: 'anna_s', bio: 'Привет', birthday: { day: 29, month: 4, year: 1990 }, phone: '+7900' };

test('birthdayText and age', () => {
  const now = new Date(2026, 9, 17);
  expect(birthdayText({ day: 29, month: 4, year: 1990 }, now)).toBe('29 апреля (36 лет)');
  expect(birthdayText({ day: 29, month: 4 }, now)).toBe('29 апреля');
  expect(birthdayText({ day: 1, month: 1, year: 2025 }, now)).toBe('1 января (1 год)');
  expect(birthdayText({ day: 1, month: 1, year: 2023 }, now)).toBe('1 января (3 года)');
  expect(birthdayText({ day: 1, month: 1, year: 2015 }, now)).toBe('1 января (11 лет)');
  expect(age({ day: 18, month: 10, year: 2000 }, now)).toBe(25);   // завтра — ещё не исполнилось
  expect(age({ day: 17, month: 10, year: 2000 }, now)).toBe(26);
});

test('username shape mirrors the server', () => {
  for (const ok of ['anna_s', '@Anna_S', 'a1234', 'abcde_f']) expect(usernameShapeOk(ok)).toBe(true);
  for (const bad of ['anna', '1anna', 'anna_', 'an__na', 'анна_смир', 'a'.repeat(33)]) expect(usernameShapeOk(bad)).toBe(false);
});

test('patch carries only changed, normalized fields', () => {
  const f = formFromMe(me);
  expect(isDirty(me, f)).toBe(false);
  expect(profilePatch(me, { ...f, firstName: '  Анна  ' })).toEqual({});
  expect(profilePatch(me, { ...f, bio: '  ', lastName: 'Новая', birthday: null })).toEqual({ lastName: 'Новая', bio: null, birthday: null });
  expect(isDirty(me, { ...f, username: '@ANNA_S' })).toBe(false);
  expect(isDirty(me, { ...f, username: 'anna_new' })).toBe(true);
  // старый кэш без раздельных полей
  expect(formFromMe({ userId: 1, name: 'Борис Иванов' })).toMatchObject({ firstName: 'Борис', lastName: 'Иванов', bio: '', username: '' });
});

test('save is allowed only with a name and a free (or unverifiable) username', () => {
  const f = formFromMe(me);
  expect(canSave(me, { ...f, firstName: ' ' }, null)).toBe(false);
  expect(canSave(me, { ...f, bio: 'x'.repeat(141) }, null)).toBe(false);
  expect(canSave(me, { ...f, username: 'anna_new' }, 'checking')).toBe(false);
  expect(canSave(me, { ...f, username: 'anna_new' }, 'taken')).toBe(false);
  expect(canSave(me, { ...f, username: 'anna_new' }, 'free')).toBe(true);
  expect(canSave(me, { ...f, username: 'anna_new' }, 'offline')).toBe(true);
  expect(canSave(me, { ...f, username: '' }, null)).toBe(true);   // убрать имя пользователя можно
});
