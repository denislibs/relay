import { expect, test } from 'bun:test';
import { joinAction, showCardAt } from './joinLink';

test('joinAction: a member opens the chat; @public channel previews; groups and +invites get the card', () => {
  expect(joinAction('@news', { kind: 'channel', member: true })).toBe('open');
  expect(joinAction('+abc', { kind: 'group', member: true })).toBe('open');
  expect(joinAction('@news', { kind: 'channel', member: false })).toBe('preview');
  // приватный канал по приглашению — карточка, как в Telegram (t.me/+hash)
  expect(joinAction('+abc', { kind: 'channel', member: false })).toBe('card');
  expect(joinAction('@chat', { kind: 'group', member: false })).toBe('card');
});

test('showCardAt: an invite card opens at once; an @name waits for the answer (no flash for a channel or a person)', () => {
  expect(showCardAt(null, false)).toBe(false);
  expect(showCardAt('+abc', false)).toBe(true);
  expect(showCardAt('@news', false)).toBe(false);
  expect(showCardAt('@news', true)).toBe(true);
});
