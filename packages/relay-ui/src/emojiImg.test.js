import { expect, test } from 'bun:test';
import { EMOJI_RE, emojiFile, emojiHtml } from './emojiImg.js';

const all = (s) => s.match(EMOJI_RE) ?? [];

test('emoji sequences: presentation, skin tone, ZWJ, flags, keycaps, tags; text-default signs only with FE0F', () => {
  expect(all('hi 😀!')).toEqual(['😀']);
  expect(all('👍🏽👨‍👩‍👧‍👦🏳️‍🌈')).toEqual(['👍🏽', '👨‍👩‍👧‍👦', '🏳️‍🌈']);
  expect(all('🇷🇺🇺🇸')).toEqual(['🇷🇺', '🇺🇸']);
  expect(all('#️⃣ 1️⃣')).toEqual(['#️⃣', '1️⃣']);
  expect(all('🏴󠁧󠁢󠁥󠁮󠁧󠁿')).toEqual(['🏴󠁧󠁢󠁥󠁮󠁧󠁿']);
  expect(all('© ™ 1 # ↔')).toEqual([]);
  expect(all('❤️ ❤')).toEqual(['❤️']);
});

test('file names drop FE0F and pad to four digits', () => {
  expect(emojiFile('😀')).toBe('1f600');
  expect(emojiFile('🏳️‍🌈')).toBe('1f3f3-200d-1f308');
  expect(emojiFile('#️⃣')).toBe('0023-20e3');
  expect(emojiFile('❤️')).toBe('2764');
});

test('field HTML: emoji become images with the emoji in alt, text stays', () => {
  expect(emojiHtml('a 🤪 &amp; b')).toBe('a <img class="rl-emoji" src="/emoji/apple/1f92a.png" alt="🤪" draggable="false"> &amp; b');
  expect(emojiHtml('plain')).toBe('plain');
});
