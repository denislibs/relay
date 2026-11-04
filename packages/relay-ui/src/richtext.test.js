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

test('clipboardHtml: Bot API markup, escaped, spoiler kept, newlines as <br> outside pre', async () => {
  const { clipboardHtml } = await import('./messageCopy.js');
  expect(clipboardHtml('a <b>\nc', [{ type: 'bold', offset: 0, length: 1 }])).toBe('<strong>a</strong> &lt;b&gt;<br>c');
  expect(clipboardHtml('ss tt', [{ type: 'spoiler', offset: 0, length: 2 }, { type: 'link', offset: 3, length: 2, url: 'https://x.io/?q="1"' }]))
    .toBe('<tg-spoiler>ss</tg-spoiler> <a href="https://x.io/?q=&quot;1&quot;">tt</a>');
  expect(clipboardHtml('x\ny', [{ type: 'pre', offset: 0, length: 3 }])).toBe('<pre><code>x\ny</code></pre>');
});

test('date entities: kept with date and format, chip HTML, Telegram tg-time on copy, toggled on a selection', async () => {
  const { clipboardHtml } = await import('./messageCopy.js');
  const v0 = v('встреча завтра', [{ type: 'date', offset: 8, length: 6, date: 1792400000, format: 'r' }]);
  expect(clean(v0.text, v0.entities)).toEqual([{ type: 'date', offset: 8, length: 6, date: 1792400000, format: 'r' }]);
  expect(clean('x', [{ type: 'date', offset: 0, length: 1, date: 5, format: 'zz' }])).toEqual([]);
  expect(toHtml(v0)).toBe('встреча <span class="rl-date-chip" contenteditable="false" data-date="1792400000" data-format="r">завтра</span>');
  expect(clipboardHtml(v0.text, v0.entities)).toBe('встреча <tg-time unix="1792400000" format="r">завтра</tg-time>');
  expect(toggleFormat(v('в 10 утра'), 'date', 2, 9, { date: 100, format: '' }).entities).toEqual([{ type: 'date', offset: 2, length: 7, date: 100 }]);
});

const bq = (offset, length, extra = {}) => ({ type: 'blockquote', offset, length, ...extra });

test('blockquote: one block in the field, adjacent newlines replaced by it, a filler line after it at the end', () => {
  expect(toHtml(v('a\nq\nb', [bq(2, 1)]))).toBe('a<blockquote class="rl-bq-edit"><span class="rl-bq-edit-toggle" contenteditable="false" role="button" aria-label="Сворачивать цитату" data-bq-toggle="1"></span>q</blockquote>b');
  expect(toHtml(v('qq', [bq(0, 2, { collapsed: true }), { type: 'bold', offset: 0, length: 1 }]))).toContain('data-collapsed="1"');
  expect(toHtml(v('qq', [bq(0, 2), { type: 'bold', offset: 0, length: 1 }])).match(/<blockquote/g).length).toBe(1);
  expect(toHtml(v('q', [bq(0, 1)])).endsWith('</blockquote><br>')).toBe(true);
  // пустая строка рядом остаётся
  expect(toHtml(v('a\n\nq', [bq(3, 1)])).startsWith('a<br><blockquote')).toBe(true);
});

test('blockquote: clean merges, does not mix with pre, keeps only true collapsed', () => {
  expect(clean('abcdef', [bq(0, 3, { collapsed: true }), bq(2, 2, { collapsed: true })])).toEqual([bq(0, 4, { collapsed: true })]);
  expect(clean('abcdef', [bq(0, 3, { collapsed: true }), bq(2, 2)])).toEqual([bq(0, 4)]);
  expect(clean('abcdef', [bq(0, 4), { type: 'pre', offset: 2, length: 2 }])).toEqual([{ type: 'pre', offset: 2, length: 2 }]);
});

test('blockquote toggle: whole lines, removes pre, keeps other formatting; code inside is fine, pre takes the quote off', () => {
  const t = v('one\ntwo\nthree');
  expect(toggleFormat(t, 'blockquote', 5, 6).entities).toEqual([bq(4, 3)]);
  expect(toggleFormat(v('one\ntwo', [bq(4, 3)]), 'blockquote', 4, 7).entities).toEqual([]);
  const withPre = toggleFormat(v('one', [{ type: 'pre', offset: 0, length: 3 }]), 'blockquote', 0, 3);
  expect(withPre.entities).toEqual([bq(0, 3)]);
  const code = toggleFormat(v('one two', [bq(0, 7)]), 'code', 0, 3);
  expect(code.entities).toEqual([bq(0, 7), { type: 'code', offset: 0, length: 3 }]);
  expect(toggleFormat(v('one two', [bq(0, 7)]), 'pre', 0, 3).entities).toEqual([{ type: 'pre', offset: 0, length: 3 }, bq(4, 3)]);
  expect(toggleFormat(v('one two', [bq(0, 7)]), 'bold', 0, 3).entities.map((e) => e.type).sort()).toEqual(['blockquote', 'bold']);
});

test('markdown: lines with > become one quote, markers removed; not inside a code block', () => {
  expect(applyMarkdown(v('> раз\n> два\nтри'))).toEqual(v('раз\nдва\nтри', [bq(0, 7)]));
  expect(applyMarkdown(v('a\n> q'))).toEqual(v('a\nq', [bq(2, 1)]));
  expect(applyMarkdown(v('> a\nb\n> c'))).toEqual(v('a\nb\nc', [bq(0, 1), bq(4, 1)]));
  expect(applyMarkdown(v('1 > 2'))).toEqual(v('1 > 2'));
  expect(applyMarkdown(v('```\n> a```')).entities.map((e) => e.type)).toEqual(['pre']);
});

test('clipboardHtml: blockquote is one block, expandable for collapsed', async () => {
  const { clipboardHtml } = await import('./messageCopy.js');
  expect(clipboardHtml('a\nqq', [bq(2, 2), { type: 'bold', offset: 2, length: 1 }])).toBe('a<br><blockquote><strong>q</strong>q</blockquote>');
  expect(clipboardHtml('q', [bq(0, 1, { collapsed: true })])).toBe('<blockquote expandable>q</blockquote>');
});
