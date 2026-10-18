import { expect, test } from 'bun:test';
import type { SessionInfo } from '@relay/protocol';
import { dayKey, dismiss, pickBanner, sessionsAfterOps, sessionsSeen, type BannerInput } from './banners';

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

const s = (o: Partial<SessionInfo>): SessionInfo => ({ id: 1, device: 'Chrome, macOS', ip: '1.2.3.4', createdAt: '2026-10-18T10:00:00Z', lastActiveAt: '2026-10-18T10:00:00Z', current: false, online: true, unconfirmed: false, ...o });

test('unconfirmed login beats every other banner; not shown on the unconfirmed device itself', () => {
  const base = { notify: 'default' as const, dismissed: {}, me: null, contacts: [], today: new Date('2026-10-18') };
  const fresh = s({ id: 2, unconfirmed: true });
  expect(pickBanner({ ...base, sessions: [s({ id: 1, current: true }), fresh] })).toEqual({ kind: 'unconfirmed', session: fresh });
  expect(pickBanner({ ...base, sessions: [s({ id: 2, current: true, unconfirmed: true })] })).toEqual({ kind: 'notify' });
  expect(pickBanner({ ...base, sessions: null })).toEqual({ kind: 'notify' });
});

test('sessions as the UI sees them: pending end hides the row, pending or just-sent confirm clears «unconfirmed»', () => {
  const list = [s({ id: 1, current: true }), s({ id: 2, unconfirmed: true }), s({ id: 3, unconfirmed: true })];
  expect(sessionsSeen(list, []).map((x) => [x.id, x.unconfirmed])).toEqual([[1, false], [2, true], [3, true]]);
  expect(sessionsSeen(list, ['sessionConfirm:2']).map((x) => [x.id, x.unconfirmed])).toEqual([[1, false], [2, false], [3, true]]);
  expect(sessionsSeen(list, ['session:3']).map((x) => x.id)).toEqual([1, 2]);
  // ответили «Да» — плашки нет, пока подтверждение в очереди
  const both = [s({ id: 1, current: true }), s({ id: 2, unconfirmed: true })];
  expect(pickBanner({ notify: 'on', dismissed: {}, me: null, contacts: [], today, sessions: sessionsSeen(both, ['sessionConfirm:2']) })).toBeNull();
});

test('a confirm or end rejected by the server (not not_found) brings the banner and the row back at once', () => {
  const list = [s({ id: 1, current: true }), s({ id: 2, unconfirmed: true }), s({ id: 3 })];
  const gone = ['sessionConfirm:2', 'session:3'];
  // удачно — применяем тем же кадром
  const ok = sessionsAfterOps(list, gone, new Set());
  expect(ok.map((x) => [x.id, x.unconfirmed])).toEqual([[1, false], [2, false]]);
  // отказ (например fresh_session) — список как с сервера: плашка «Это вы?» снова видна
  const back = sessionsAfterOps(list, gone, new Set(gone));
  expect(back.map((x) => [x.id, x.unconfirmed])).toEqual([[1, false], [2, true], [3, false]]);
  expect(pickBanner({ notify: 'on', dismissed: {}, me: null, contacts: [], today, sessions: back })).toMatchObject({ kind: 'unconfirmed', session: { id: 2 } });
});
