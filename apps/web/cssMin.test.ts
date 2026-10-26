import { describe, expect, test } from 'bun:test';
import { minifyCss } from './cssMin';

describe('minifyCss', () => {
  test('drops comments and collapses whitespace', () => {
    expect(minifyCss('/* шапка */\n.a {\n  color: red;\n  margin: 0 auto;\n}\n')).toBe('.a{color: red;margin: 0 auto}');
  });
  test('keeps significant spaces in selectors', () => {
    expect(minifyCss('.a :hover, .b > .c  .d { x: 1 }')).toBe('.a :hover, .b > .c .d{x: 1}');
  });
  test('drops the space before a comma, keeps the one after (custom property values are kept as text)', () => {
    expect(minifyCss(':root { --f: a , b,c; }')).toBe(':root{--f: a, b,c}');
  });
  test('keeps strings intact, including comment-like text and escapes', () => {
    const css = `.q::before { content: "/* not a comment */  \\"x\\"" ; background: url('data:image/svg+xml,%3Csvg  a="1"%3E') }`;
    expect(minifyCss(css)).toBe(`.q::before{content: "/* not a comment */  \\"x\\"";background: url('data:image/svg+xml,%3Csvg  a="1"%3E')}`);
  });
  test('a comment between words still separates them', () => {
    expect(minifyCss('.a/**/.b{}')).toBe('.a .b{}');
  });
  test('keeps spaces inside values (calc, shorthands) as single spaces', () => {
    expect(minifyCss('.a { width: calc(100%  -  2px); font: 600  14px/20px  var(--f) }')).toBe('.a{width: calc(100% - 2px);font: 600 14px/20px var(--f)}');
  });
  test('at-rules and nested blocks', () => {
    expect(minifyCss('@media (max-width: 720px) {\n  .a { b: c; }\n}\n')).toBe('@media (max-width: 720px){.a{b: c}}');
  });
});
