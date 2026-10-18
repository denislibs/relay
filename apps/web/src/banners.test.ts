import { expect, test } from 'bun:test';
import { dayKey, dismiss, pickBanner, type BannerInput } from './banners';

const today = new Date(2026, 9, 18, 12);   // 18 октября
const base: BannerInput = { notify: 'on', dismissed: {}, me: { birthday: { day: 1, month: 1 } }, contacts: [], today };
const anna = { userId: 1, name: 'Анна', birthday: { day: 18, month: 10 } };
const boris = { userId: 2, name: 'Борис', birthday: { day: 18, month: 10 } };
const vera = { userId: 3, name: 'Вера', birthday: { day: 19, month: 10 } };

test('notifications first, only while the browser has not asked yet', () => {
  expect(pickBanner({ ...base, notify: 'default', contacts: [anna] })).toEqual({ kind: 'notify' });
  for (const n of ['on', 'off', 'denied', 'unsupported'] as const) expect(pickBanner({ ...base, notify: n })).toBeNull();
  expect(pickBanner({ ...base, notify: 'default', dismissed: { notify: true } })).toBeNull();
});

test('birthdays today: every contact whose day and month match, year ignored', () => {
  expect(pickBanner({ ...base, contacts: [anna, vera, boris, { userId: 4, name: 'Без даты' }] }))
    .toEqual({ kind: 'birthdays', people: [{ userId: 1, name: 'Анна' }, { userId: 2, name: 'Борис' }] });
  expect(pickBanner({ ...base, contacts: [vera] })).toBeNull();
});

test('closed birthdays come back the next day', () => {
  const d = dismiss({}, { kind: 'birthdays', people: [] }, today);
  expect(d).toEqual({ birthdays: dayKey(today) });
  expect(pickBanner({ ...base, dismissed: d, contacts: [anna] })).toBeNull();
  const tomorrow = new Date(2026, 9, 19, 9);
  expect(pickBanner({ ...base, today: tomorrow, dismissed: d, contacts: [vera] })?.kind).toBe('birthdays');
});

test('own birthday suggestion last; closing it is for good', () => {
  expect(pickBanner({ ...base, me: { birthday: null } })).toEqual({ kind: 'setBirthday' });
  expect(pickBanner({ ...base, me: { birthday: null }, contacts: [anna] })?.kind).toBe('birthdays');
  expect(pickBanner({ ...base, me: { birthday: null }, dismissed: dismiss({}, { kind: 'setBirthday' }, today) })).toBeNull();
  expect(pickBanner({ ...base, me: null })).toBeNull();
});
