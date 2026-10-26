import { expect, test } from 'bun:test';
import { badgeCount, blinkText, clampPending, titleFor } from './title';

const flags = [false, true];
for (const hideChat of flags) for (const hideUnread of flags) for (const chat of [null, 'Анна']) for (const unread of [0, 3, 150]) {
  test(`titleFor chat=${chat} unread=${unread} hideChat=${hideChat} hideUnread=${hideUnread}`, () => {
    const prefs = { hideChatInTitle: hideChat, hideUnreadInTitle: hideUnread };
    const pre = unread > 0 && !hideUnread ? `(${unread > 99 ? '99+' : unread}) ` : '';
    const body = chat && !hideChat ? 'Анна — Relay' : 'Relay';
    expect(titleFor({ chatTitle: chat, unread, prefs })).toBe(pre + body);
    expect(badgeCount(unread, prefs)).toBe(hideUnread ? 0 : unread);
  });
}
test('formats', () => {
  expect(titleFor({ chatTitle: 'Анна', unread: 3, prefs: { hideChatInTitle: false, hideUnreadInTitle: false } })).toBe('(3) Анна — Relay');
  expect(titleFor({ chatTitle: 'Анна', unread: 3, prefs: { hideChatInTitle: true, hideUnreadInTitle: true } })).toBe('Relay');
});

test('blink text: Russian plural forms, capped at 99+', () => {
  expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101].map(blinkText)).toEqual([
    '1 новое сообщение', '2 новых сообщения', '4 новых сообщения', '5 новых сообщений', '11 новых сообщений', '12 новых сообщений',
    '14 новых сообщений', '21 новое сообщение', '22 новых сообщения', '25 новых сообщений', '99+ новых сообщений']);
});

test('pending never exceeds unread: read elsewhere lowers it, read to zero drops the chat', () => {
  const unread = new Map([[1, 5], [2, 1], [3, 0]]);
  const out = clampPending(new Map([[1, 3], [2, 4], [3, 2], [9, 1]]), (id) => unread.get(id));
  expect([...out]).toEqual([[1, 3], [2, 1], [9, 1]]);   // чат 9 ещё не в списке — счёт остаётся
});
