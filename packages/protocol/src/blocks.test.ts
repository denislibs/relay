import { expect, test } from 'bun:test';
import { ARTICLE_LIMITS, blocksText, blocksToText, normalizeBlocks, textToBlocks } from './blocks';

test('normalize keeps valid blocks, drops empty edges and headings, rejects unknown types', () => {
  const b = normalizeBlocks([
    { type: 'p', text: '' },
    { type: 'h', level: 2, text: 'Заголовок' },
    { type: 'h', level: 1, text: '  ' },
    { type: 'p', text: 'жирный текст', entities: [{ type: 'bold', offset: 0, length: 6 }] },
    { type: 'ul', items: [[{ type: 'p', text: 'раз' }], [{ type: 'p', text: 'два' }, { type: 'ol', items: [[{ type: 'p', text: 'вложенный' }]], start: 3 }]] },
    { type: 'quote', blocks: [{ type: 'p', text: 'цитата' }] },
    { type: 'code', text: 'let x = 1', lang: 'js' },
    { type: 'hr' },
    { type: 'p', text: '' },
  ]);
  expect(b?.map((x) => x.type)).toEqual(['h', 'p', 'ul', 'quote', 'code', 'hr']);
  expect(normalizeBlocks([{ type: 'script', text: 'x' }])).toBeNull();
  expect(normalizeBlocks([])).toBeNull();
  expect(normalizeBlocks('x')).toBeNull();
});

test('limits: too long, too many blocks, too deep', () => {
  expect(normalizeBlocks([{ type: 'p', text: 'a'.repeat(ARTICLE_LIMITS.length + 1) }])).toBeNull();
  expect(normalizeBlocks(Array.from({ length: ARTICLE_LIMITS.blocks + 1 }, () => ({ type: 'p', text: 'x' })))).toBeNull();
  let deep: unknown = { type: 'p', text: 'x' };
  for (let i = 0; i < 20; i++) deep = { type: 'quote', blocks: [deep] };
  expect(normalizeBlocks([deep])).toBeNull();
});

test('plain text for previews and search', () => {
  const b = normalizeBlocks([{ type: 'h', level: 1, text: 'План' }, { type: 'ol', items: [[{ type: 'p', text: 'раз' }], [{ type: 'p', text: 'два' }]] }, { type: 'hr' }])!;
  expect(blocksText(b)).toBe('План\n1. раз\n2. два\n———');
});

test('simple article (paragraphs and code) becomes a normal message; anything else stays an article', () => {
  const simple = normalizeBlocks([{ type: 'p', text: 'привет', entities: [{ type: 'italic', offset: 0, length: 6 }] }, { type: 'code', text: 'x()' }])!;
  expect(blocksToText(simple)).toEqual({ text: 'привет\nx()', entities: [{ type: 'italic', offset: 0, length: 6 }, { type: 'pre', offset: 7, length: 3 }] });
  expect(blocksToText(normalizeBlocks([{ type: 'h', level: 1, text: 'x' }])!)).toBeNull();
});

test('text with formatting → blocks and back', () => {
  const text = 'раз\nдва\ncode()\nтри';
  const ents = [{ type: 'bold' as const, offset: 4, length: 3 }, { type: 'pre' as const, offset: 8, length: 6 }];
  const blocks = textToBlocks(text, ents);
  expect(blocks).toEqual([{ type: 'p', text: 'раз' }, { type: 'p', text: 'два', entities: [{ type: 'bold', offset: 0, length: 3 }] }, { type: 'code', text: 'code()' }, { type: 'p', text: 'три' }]);
  expect(blocksToText(blocks)).toEqual({ text, entities: [{ type: 'bold', offset: 4, length: 3 }, { type: 'pre', offset: 8, length: 6 }] });
});
