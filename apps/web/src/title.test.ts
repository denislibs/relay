import { expect, test } from 'bun:test';
import { badgeCount, titleFor } from './title';

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
