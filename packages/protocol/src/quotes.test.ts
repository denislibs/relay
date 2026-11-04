import { expect, test } from 'bun:test';
import { clipQuoteEntities, hideSpoilers, locateQuote, makeQuote, normalizeEntities, parseClientFrame, QUOTE_MAX } from './index';
import { normalizeBlocks } from './blocks';

test('normalizeEntities: blockquote keeps only a true collapsed, one does not nest in another, not with pre', () => {
  expect(normalizeEntities('abcdef', [{ type: 'blockquote', offset: 0, length: 3, collapsed: true }])).toEqual([{ type: 'blockquote', offset: 0, length: 3, collapsed: true }]);
  expect(normalizeEntities('abcdef', [{ type: 'blockquote', offset: 0, length: 3, collapsed: 'yes' }])).toEqual([{ type: 'blockquote', offset: 0, length: 3 }]);
  // вложенная и перекрывающаяся цитаты склеиваются; свёрнута, только если свёрнуты обе
  expect(normalizeEntities('abcdefgh', [{ type: 'blockquote', offset: 0, length: 6, collapsed: true }, { type: 'blockquote', offset: 2, length: 2 }])).toEqual([{ type: 'blockquote', offset: 0, length: 6 }]);
  expect(normalizeEntities('abcdefgh', [{ type: 'blockquote', offset: 0, length: 3, collapsed: true }, { type: 'blockquote', offset: 2, length: 3, collapsed: true }])).toEqual([{ type: 'blockquote', offset: 0, length: 5, collapsed: true }]);
  // с блоком кода не сочетается, с остальным — да
  expect(normalizeEntities('abcdef', [{ type: 'blockquote', offset: 0, length: 4 }, { type: 'pre', offset: 2, length: 3 }])).toEqual([{ type: 'pre', offset: 2, length: 3 }]);
  expect(normalizeEntities('abcdef', [{ type: 'blockquote', offset: 0, length: 3 }, { type: 'pre', offset: 3, length: 3 }]).map((e) => e.type)).toEqual(['blockquote', 'pre']);
  expect(normalizeEntities('abcdef', [{ type: 'blockquote', offset: 0, length: 6 }, { type: 'bold', offset: 0, length: 3 }, { type: 'code', offset: 3, length: 2 }, { type: 'spoiler', offset: 1, length: 1 }]).length).toBe(4);
  // лишние поля не проходят
  expect(normalizeEntities('abc', [{ type: 'blockquote', offset: 0, length: 3, url: 'https://x.io', evil: 1 }])).toEqual([{ type: 'blockquote', offset: 0, length: 3 }]);
});

test('articles: a blockquote entity does not get into paragraph text', () => {
  const b = normalizeBlocks([{ type: 'p', text: 'abc', entities: [{ type: 'blockquote', offset: 0, length: 3 }, { type: 'bold', offset: 0, length: 1 }] }]);
  expect((b as { entities?: unknown[] }[])[0].entities).toEqual([{ type: 'bold', offset: 0, length: 1 }]);
});

test('locateQuote: at the hint, the nearest when moved, -1 when gone', () => {
  expect(locateQuote('раз два раз', 'раз', 8)).toBe(8);
  expect(locateQuote('раз два раз', 'раз', 7)).toBe(8);
  expect(locateQuote('раз два раз', 'раз', 1)).toBe(0);
  expect(locateQuote('xx раз', 'раз', 0)).toBe(3);
  expect(locateQuote('раз два', 'три', 0)).toBe(-1);
  expect(locateQuote('раз', '', 0)).toBe(-1);
});

test('clipQuoteEntities: clips and shifts, keeps spoiler, drops blocks and date', () => {
  const es = [{ type: 'bold', offset: 0, length: 5 }, { type: 'spoiler', offset: 4, length: 4 }, { type: 'blockquote', offset: 0, length: 10 }, { type: 'pre', offset: 8, length: 1 }, { type: 'date', offset: 3, length: 2, date: 1 }, { type: 'link', offset: 9, length: 1, url: 'https://x.io' }] as never;
  expect(clipQuoteEntities('0123456789', es, 3, 4)).toEqual([{ type: 'bold', offset: 0, length: 2 }, { type: 'spoiler', offset: 1, length: 3 }]);
  expect(clipQuoteEntities('0123456789', null, 3, 4)).toEqual([]);
});

test('makeQuote: trims the selection, finds it by the hint, cuts at the limit on a character boundary, null when absent', () => {
  expect(makeQuote('раз два раз', [], '  раз \n', 6)).toEqual({ text: 'раз', offset: 8 });
  expect(makeQuote('раз', [], '   ', 0)).toBeNull();
  expect(makeQuote('раз', [], 'завтра в 10:00', 0)).toBeNull();   // дата показана иначе, чем написана
  const long = makeQuote('a'.repeat(QUOTE_MAX - 1) + '😀b', [], 'a'.repeat(QUOTE_MAX - 1) + '😀b', 0)!;
  expect(long.text.length).toBe(QUOTE_MAX - 1);
  expect(long.text.isWellFormed()).toBe(true);
  // скрытый текст остаётся скрытым и в превью фрагмента
  const q = makeQuote('пароль 12345 тут', [{ type: 'spoiler', offset: 7, length: 5 }], 'пароль 12345', 0)!;
  expect(q.entities).toEqual([{ type: 'spoiler', offset: 7, length: 5 }]);
  expect(hideSpoilers(q.text, q.entities)).not.toContain('12345');
});

test('send frame: replyQuote is only text and offset; entities from a client are not taken; junk is refused', () => {
  const base = { op: 'send', reqId: 'r', clientId: crypto.randomUUID(), chatId: 1, body: 'hi', replyToId: 5 };
  const f = parseClientFrame(JSON.stringify({ ...base, replyQuote: { text: 'x', offset: 2, entities: [{ type: 'link', offset: 0, length: 1, url: 'https://evil.example' }] } }));
  expect(f).toMatchObject({ replyQuote: { text: 'x', offset: 2 } });
  expect((f as { replyQuote: object }).replyQuote).not.toHaveProperty('entities');
  expect(parseClientFrame(JSON.stringify({ ...base, replyQuote: { text: 1, offset: 2 } }))).toBeNull();
  expect(parseClientFrame(JSON.stringify({ ...base, replyQuote: { text: 'x', offset: 1.5 } }))).toBeNull();
  expect(parseClientFrame(JSON.stringify({ ...base, replyToId: null, replyQuote: { text: 'x', offset: 0 } }))).not.toHaveProperty('replyQuote');
  expect(parseClientFrame(JSON.stringify(base))).not.toHaveProperty('replyQuote');
});
