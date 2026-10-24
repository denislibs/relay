import { expect, test } from 'bun:test';
import { mentionsIn, USERNAME } from './mentions';

test('MENTION_RE: boundaries, case, width', () => {
  expect(mentionsIn('привет @Anna_K и @boris1, как дела?')).toEqual(['anna_k', 'boris1']);
  expect(mentionsIn('(@vera_v) @vera_v')).toEqual(['vera_v']);   // скобки — граница; повтор один раз
  expect(mentionsIn('medium.com/@writer и mail@example.com и x/@path_name')).toEqual([]);
  expect(mentionsIn('@@double_at word@inside')).toEqual([]);
  expect(mentionsIn('@abcd короткое')).toEqual([]);   // 4 знака — не имя
  expect(mentionsIn('@' + 'a'.repeat(33))).toEqual([]);   // длиннее 32 — не имя
  expect(mentionsIn('@' + 'a'.repeat(32))).toEqual(['a'.repeat(32)]);
  expect(mentionsIn('@1abcde')).toEqual([]);
  expect(mentionsIn('@anna_kя')).toEqual([]);   // продолжение слова
  expect(USERNAME.test('anna_k')).toBe(true);
  expect(USERNAME.test('Anna_k')).toBe(false);
});

test('mentionsIn: not inside code, pre or link entities; articles skip code blocks', () => {
  const text = 'код `@inside_code` блок @in_pre ссылка @in_link и @real_one';
  const at = (s: string) => text.indexOf(s);
  expect(mentionsIn(text, [
    { type: 'code', offset: at('@inside_code'), length: '@inside_code'.length },
    { type: 'pre', offset: at('@in_pre'), length: 7 },
    { type: 'link', offset: at('@in_link'), length: 8, url: 'https://x.y' },
    { type: 'bold', offset: at('@real_one'), length: 9 },
  ])).toEqual(['real_one']);
  expect(mentionsIn('', [], [
    { type: 'p', text: 'абзац @in_para' },
    { type: 'code', text: '@in_code_block' },
    { type: 'quote', blocks: [{ type: 'h', level: 2, text: '@in_quote' }] },
    { type: 'ul', items: [[{ type: 'p', text: 'пункт @in_list', entities: [{ type: 'code', offset: 0, length: 5 }] }]] },
  ])).toEqual(['in_para', 'in_quote', 'in_list']);
});
