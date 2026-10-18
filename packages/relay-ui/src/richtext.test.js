import { expect, test } from 'bun:test';
import { applyMarkdown, clean, covers, safeUrl, segments, splice, toggleFormat, toHtml, trimValue } from './richtext.js';

const v = (text, entities = []) => ({ text, entities });

test('toHtml escapes text, nests formats in a stable order, keeps the last empty line visible', () => {
  expect(toHtml(v('a<b>&"'))).toBe('a&lt;b&gt;&amp;&quot;');
  expect(toHtml(v('ab', [{ type: 'italic', offset: 0, length: 2 }, { type: 'bold', offset: 0, length: 1 }]))).toBe('<b><i>a</i></b><i>b</i>');
  expect(toHtml(v('x\n'))).toBe('x<br><br>');
  expect(toHtml(v('a\nb'))).toBe('a<br>b');
  expect(toHtml(v('go', [{ type: 'link', offset: 0, length: 2, url: 'https://x.io/?a="1"' }]))).toContain('href="https://x.io/?a=&quot;1&quot;"');
});

test('clean merges one type, trims whitespace edges (not in code), drops junk', () => {
  expect(clean('hello world', [{ type: 'bold', offset: 0, length: 3 }, { type: 'bold', offset: 2, length: 4 }])).toEqual([{ type: 'bold', offset: 0, length: 5 }]);
  expect(clean(' ab ', [{ type: 'bold', offset: 0, length: 4 }])).toEqual([{ type: 'bold', offset: 1, length: 2 }]);
  expect(clean(' ab ', [{ type: 'code', offset: 0, length: 4 }])).toEqual([{ type: 'code', offset: 0, length: 4 }]);
  expect(clean('ab', [{ type: 'evil', offset: 0, length: 2 }, { type: 'bold', offset: 5, length: 2 }, { type: 'link', offset: 0, length: 2, url: 'javascript:alert(1)' }])).toEqual([]);
});

test('toggleFormat: on, off when fully covered, mono excludes the rest', () => {
  let x = toggleFormat(v('hello world'), 'bold', 0, 5);
  expect(x.entities).toEqual([{ type: 'bold', offset: 0, length: 5 }]);
  expect(covers(x, 'bold', 0, 5)).toBe(true);
  expect(covers(x, 'bold', 0, 7)).toBe(false);
  x = toggleFormat(x, 'bold', 1, 3);
  expect(x.entities).toEqual([{ type: 'bold', offset: 0, length: 1 }, { type: 'bold', offset: 3, length: 2 }]);
  x = toggleFormat(toggleFormat(v('abc'), 'italic', 0, 3), 'code', 0, 3);
  expect(x.entities).toEqual([{ type: 'code', offset: 0, length: 3 }]);
  x = toggleFormat(x, 'link', 0, 3, 'https://a.b');
  expect(x.entities).toEqual([{ type: 'link', offset: 0, length: 3, url: 'https://a.b' }]);
  expect(toggleFormat(x, 'link', 0, 3, null).entities).toEqual([]);
});

test('splice shifts entities and keeps the parts around a replaced range', () => {
  const x = v('abcdef', [{ type: 'bold', offset: 1, length: 4 }]);
  expect(splice(x, 2, 4, v('XYZ'))).toEqual(v('abXYZef', [{ type: 'bold', offset: 1, length: 1 }, { type: 'bold', offset: 5, length: 1 }]));
  expect(splice(x, 0, 0, v('>', [{ type: 'italic', offset: 0, length: 1 }]))).toEqual(v('>abcdef', [{ type: 'italic', offset: 0, length: 1 }, { type: 'bold', offset: 2, length: 4 }]));
});

test('trimValue moves entities with the leading whitespace', () => {
  expect(trimValue(v('  hi there \n', [{ type: 'bold', offset: 2, length: 2 }]))).toEqual(v('hi there', [{ type: 'bold', offset: 0, length: 2 }]));
});

test('applyMarkdown: inline styles, links, code keeps markers inside, snake_case untouched', () => {
  expect(applyMarkdown(v('a **b** c'))).toEqual(v('a b c', [{ type: 'bold', offset: 2, length: 1 }]));
  expect(applyMarkdown(v('__i__ ~~s~~ ||p||'))).toEqual(v('i s p', [{ type: 'italic', offset: 0, length: 1 }, { type: 'strike', offset: 2, length: 1 }, { type: 'spoiler', offset: 4, length: 1 }]));
  expect(applyMarkdown(v('see [docs](example.com/x)'))).toEqual(v('see docs', [{ type: 'link', offset: 4, length: 4, url: 'https://example.com/x' }]));
  expect(applyMarkdown(v('`**not bold**`'))).toEqual(v('**not bold**', [{ type: 'code', offset: 0, length: 12 }]));
  expect(applyMarkdown(v('```js\nconst a = 1;```'))).toEqual(v('const a = 1;', [{ type: 'pre', offset: 0, length: 12 }]));
  expect(applyMarkdown(v('snake_case_name and 2 ** 3'))).toEqual(v('snake_case_name and 2 ** 3'));
  expect(applyMarkdown(v('[x](javascript:alert(1))')).entities).toEqual([]);
  // уже оформленное не теряется при снятии маркеров
  expect(applyMarkdown(v('ab **c**', [{ type: 'italic', offset: 0, length: 2 }]))).toEqual(v('ab c', [{ type: 'italic', offset: 0, length: 2 }, { type: 'bold', offset: 3, length: 1 }]));
});

test('safeUrl accepts http(s)/mailto, adds https, rejects the rest', () => {
  expect(safeUrl('example.com')).toBe('https://example.com');
  expect(safeUrl('http://a.b/c')).toBe('http://a.b/c');
  expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'a b', '', 'file:///etc/passwd']) expect(safeUrl(bad)).toBe(null);
});

test('segments split by every boundary', () => {
  expect(segments('abcd', [{ type: 'bold', offset: 1, length: 2 }])).toEqual([{ text: 'a', marks: {} }, { text: 'bc', marks: { bold: true } }, { text: 'd', marks: {} }]);
});
