import { describe, expect, test } from 'bun:test';
import { baseOf, findTarget, hashFor, parseHash, positionKey, sameTarget, toTarget } from './stackTarget';

describe('stackTarget', () => {
  test('лента группы и её тред — разные слои', () => {
    expect(sameTarget({ chatId: 5 }, { chatId: 5 })).toBe(true);
    expect(sameTarget({ chatId: 5 }, { chatId: 5, threadId: 9 })).toBe(false);
    expect(sameTarget({ chatId: 5, threadId: 9 }, { chatId: 5, threadId: 9 })).toBe(true);
    expect(sameTarget({ chatId: 5, threadId: 9 }, { chatId: 5, threadId: 10 })).toBe(false);
  });

  test('openInner ищет дубль по паре чат+тред', () => {
    const stack = [{ chatId: 1 }, { chatId: 5 }, { chatId: 5, threadId: 9 }, { chatId: 7 }];
    expect(findTarget(stack, { chatId: 5, threadId: 9 })).toBe(2);
    expect(findTarget(stack, { chatId: 5 })).toBe(1);
    expect(findTarget(stack, { chatId: 5, threadId: 10 })).toBe(-1);
    expect(findTarget(stack, { chatId: 9 })).toBe(-1);
  });

  test('ключ позиции прокрутки', () => {
    expect(positionKey({ chatId: 3 })).toBe('3');
    expect(positionKey({ chatId: 3, threadId: 40 })).toBe('3:40');
  });

  test('адрес верхнего слоя и обратно', () => {
    expect(hashFor(null)).toBe('');
    expect(hashFor({ chatId: 3 })).toBe('#chat=3');
    expect(hashFor({ chatId: 3, threadId: 40 })).toBe('#chat=3&thread=40');
    expect(parseHash('#chat=3&thread=40')).toEqual({ chatId: 3, threadId: 40 });
    expect(parseHash('#chat=3')).toEqual({ chatId: 3 });
    expect(parseHash('#chat=3&thread=x')).toEqual({ chatId: 3 });
    expect(parseHash('#chat=-1')).toBeNull();
    expect(parseHash('')).toBeNull();
    expect(parseHash(hashFor({ chatId: 12, threadId: 7 }))).toEqual({ chatId: 12, threadId: 7 });
  });

  test('тред гостя: канал поста в адресе (&via=) и под тредом', () => {
    expect(hashFor({ chatId: 3, threadId: 40, via: 2 })).toBe('#chat=3&thread=40&via=2');
    expect(hashFor({ chatId: 3, via: 2 })).toBe('#chat=3');   // via — только у треда
    expect(parseHash('#chat=3&thread=40&via=2')).toEqual({ chatId: 3, threadId: 40, via: 2 });
    expect(parseHash('#chat=3&thread=40&via=x')).toEqual({ chatId: 3, threadId: 40 });
    expect(baseOf({ chatId: 3, threadId: 40, via: 2 })).toBe(2);
    expect(baseOf({ chatId: 3, threadId: 40 })).toBe(3);
    expect(baseOf({ chatId: 3, via: 2 })).toBe(3);
    expect(sameTarget({ chatId: 3, threadId: 40, via: 2 }, { chatId: 3, threadId: 40 })).toBe(true);
  });

  test('openInner принимает id или слой', () => {
    expect(toTarget(4)).toEqual({ chatId: 4 });
    expect(toTarget({ chatId: 4, threadId: 1 })).toEqual({ chatId: 4, threadId: 1 });
  });
});
