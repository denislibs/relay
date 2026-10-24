import { describe, expect, test } from 'bun:test';
import { canAskReadBy, commentsAction, commentsLabel, compactCount, guestJoinLabel, isOwnChannelPost, postCopyChannel, subscribersText, threadTitle, type NotifyChat } from './channelText';

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

  test('кнопка комментариев: участник и подписчик канала — в тред, без копии — ждать, не подписан — подсказка', () => {
    expect(commentsAction({ member: true, subscriber: true, replies: true })).toBe('thread');
    expect(commentsAction({ member: false, subscriber: true, replies: true })).toBe('thread');   // не вступая в группу
    expect(commentsAction({ member: true, subscriber: false, replies: true })).toBe('thread');   // участник группы вне канала
    expect(commentsAction({ member: false, subscriber: true, replies: false })).toBe('wait');
    expect(commentsAction({ member: true, subscriber: false, replies: false })).toBe('wait');
    expect(commentsAction({ member: false, subscriber: false, replies: true })).toBe('hint');
    expect(commentsAction({ member: false, subscriber: false, replies: false })).toBe('hint');
  });

  test('тред гостя: вместо поля ввода — вступить или подать заявку; иначе поле ввода', () => {
    expect(guestJoinLabel(null)).toBeNull();
    expect(guestJoinLabel({ joinToSend: false, joinApproval: false })).toBeNull();
    expect(guestJoinLabel({ joinToSend: true, joinApproval: false })).toBe('Вступить в группу');
    expect(guestJoinLabel({ joinToSend: false, joinApproval: true })).toBe('Подать заявку');
    expect(guestJoinLabel({ joinToSend: true, joinApproval: true })).toBe('Подать заявку');
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

  test('копия поста в группе обсуждения — канал, к которому она относится', () => {
    const chats = new Map<number, NotifyChat>([
      [1, { id: 1, kind: 'channel', linkedChatId: 2, member: true }],
      [2, { id: 2, kind: 'group', linkedChatId: 1 }],
      [3, { id: 3, kind: 'channel', linkedChatId: 4, member: false }],
      [4, { id: 4, kind: 'group', linkedChatId: 3 }],
      [5, { id: 5, kind: 'group', linkedChatId: 9 }],   // канал не в списке
      [6, { id: 6, kind: 'group' }],
    ]);
    const of = (id: number) => chats.get(id);
    expect(postCopyChannel({ chatId: 2, post: true }, of)?.id).toBe(1);             // подписчик: уведомит сам пост
    expect(postCopyChannel({ chatId: 2, post: true }, of)?.member).toBe(true);
    expect(postCopyChannel({ chatId: 4, post: true }, of)?.member).toBe(false);     // не подписан — уведомляет копия
    expect(postCopyChannel({ chatId: 2 }, of)).toBeUndefined();                     // комментарий — не копия
    expect(postCopyChannel({ chatId: 2, post: true, mention: true }, of)).toBeUndefined();   // упоминание важнее
    expect(postCopyChannel({ chatId: 1, post: true }, of)).toBeUndefined();         // сам пост в канале
    expect(postCopyChannel({ chatId: 5, post: true }, of)).toBeUndefined();
    expect(postCopyChannel({ chatId: 6, post: true }, of)).toBeUndefined();
    expect(postCopyChannel({ chatId: 9, post: true }, of)).toBeUndefined();
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
