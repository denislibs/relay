import { expect, test } from 'bun:test';
import { joinAction, parseLinkKey, showCardAt } from './joinLink';

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

test('message links: /@name/id and /c/chat/id carry the message; plain keys do not', () => {
  expect(parseLinkKey('@news/42')).toEqual({ base: '@news', chatId: null, msg: 42 });
  expect(parseLinkKey('c/1500/7')).toEqual({ base: null, chatId: 1500, msg: 7 });
  expect(parseLinkKey('@news')).toEqual({ base: '@news', chatId: null, msg: null });
  expect(parseLinkKey('+tok')).toEqual({ base: '+tok', chatId: null, msg: null });
});
