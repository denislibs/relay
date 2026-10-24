import { describe, expect, test } from 'bun:test';
import { canAskReadBy, commentsLabel, compactCount, isOwnChannelPost, subscribersText, threadTitle, type NotifyChat } from './channelText';

describe('channelText', () => {
  test('подпись кнопки комментариев', () => {
    expect(commentsLabel(0)).toBe('Оставить комментарий');
    expect(commentsLabel(1)).toBe('1 комментарий');
    expect(commentsLabel(2)).toBe('2 комментария');
    expect(commentsLabel(4)).toBe('4 комментария');
    expect(commentsLabel(5)).toBe('5 комментариев');
    expect(commentsLabel(11)).toBe('11 комментариев');
    expect(commentsLabel(12)).toBe('12 комментариев');
    expect(commentsLabel(21)).toBe('21 комментарий');
    expect(commentsLabel(22)).toBe('22 комментария');
    expect(commentsLabel(111)).toBe('111 комментариев');
    expect(threadTitle(0)).toBe('Комментарии');
    expect(threadTitle(3)).toBe('3 комментария');
  });

  test('подписчики', () => {
    expect(subscribersText(1)).toBe('1 подписчик');
    expect(subscribersText(3)).toBe('3 подписчика');
    expect(subscribersText(14)).toBe('14 подписчиков');
  });

  test('просмотры компактно', () => {
    expect(compactCount(0)).toBe('0');
    expect(compactCount(999)).toBe('999');
    expect(compactCount(1000)).toBe('1K');
    expect(compactCount(1250)).toBe('1,2K');
    expect(compactCount(15_900)).toBe('15K');
    expect(compactCount(1_560_000)).toBe('1,5M');
  });

  test('свой пост и его копия не уведомляют того, кто публикует в канале', () => {
    const chats = new Map<number, NotifyChat>([
      [1, { id: 1, kind: 'channel', canPost: true, linkedChatId: 2 }],
      [2, { id: 2, kind: 'group', linkedChatId: 1 }],
      [3, { id: 3, kind: 'channel', canPost: false, linkedChatId: 4 }],
      [4, { id: 4, kind: 'group', linkedChatId: 3 }],
    ]);
    const of = (id: number) => chats.get(id);
    expect(isOwnChannelPost({ chatId: 1, post: true }, of)).toBe(true);    // пост в моём канале
    expect(isOwnChannelPost({ chatId: 2, post: true }, of)).toBe(true);    // его копия в группе обсуждения
    expect(isOwnChannelPost({ chatId: 2 }, of)).toBe(false);               // комментарий в группе — уведомляет
    expect(isOwnChannelPost({ chatId: 3, post: true }, of)).toBe(false);   // подписчик канала — уведомляем
    expect(isOwnChannelPost({ chatId: 4, post: true }, of)).toBe(false);   // копия в группе чужого канала
    expect(isOwnChannelPost({ chatId: 1, post: true, mention: true }, of)).toBe(false);   // упоминание важнее
    expect(isOwnChannelPost({ chatId: 9, post: true }, of)).toBe(false);   // чата нет в списке
  });

  test('кто прочитал — только своё в небольшой группе, не комментарий и не копия', () => {
    const own = { senderId: 7, id: 10 };
    expect(canAskReadBy(own, { kind: 'group', members: 5 }, 7)).toBe(true);
    expect(canAskReadBy(own, { kind: 'group', members: 101 }, 7)).toBe(false);
    expect(canAskReadBy(own, { kind: 'channel', members: 5 }, 7)).toBe(false);
    expect(canAskReadBy(own, { kind: 'direct' }, 7)).toBe(false);
    expect(canAskReadBy({ ...own, threadId: 3 }, { kind: 'group', members: 5 }, 7)).toBe(false);
    expect(canAskReadBy({ ...own, origin: { chatId: 1, id: 2 } }, { kind: 'group', members: 5 }, 7)).toBe(false);
    expect(canAskReadBy({ senderId: 8, id: 10 }, { kind: 'group', members: 5 }, 7)).toBe(false);
    expect(canAskReadBy({ senderId: 7, id: null }, { kind: 'group', members: 5 }, 7)).toBe(false);
  });
});
