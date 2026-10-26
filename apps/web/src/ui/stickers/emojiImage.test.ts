import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EMOJI, emojiTones, searchEmoji } from './emojiData';
import { emojiFile } from './emojiImage';

const dir = join(import.meta.dir, '..', '..', '..', 'public', 'emoji', 'apple');

test('имя файла: код-пойнты через «-», без fe0f, не короче 4 знаков', () => {
  expect(emojiFile('😀')).toBe('1f600');
  expect(emojiFile('❤️')).toBe('2764');
  expect(emojiFile('#️⃣')).toBe('0023-20e3');
  expect(emojiFile('🏳️‍🌈')).toBe('1f3f3-200d-1f308');
  expect(emojiFile('🇷🇺')).toBe('1f1f7-1f1fa');
});

test('у каждого эмодзи панели есть картинка', () => {
  const missing = EMOJI.flatMap((c) => c.list).filter((e) => !existsSync(join(dir, emojiFile(e) + '.png')));
  expect(missing).toEqual([]);
});

test('у каждого оттенка кожи есть картинка, оттенков ровно пять', () => {
  const bad = EMOJI.flatMap((c) => c.list).flatMap((e) => {
    const t = emojiTones(e);
    if (!t) return [];
    return t.length !== 5 ? [e] : t.filter((v) => !existsSync(join(dir, emojiFile(v) + '.png')));
  });
  expect(bad).toEqual([]);
  expect(emojiTones('👋')?.length).toBe(5);
});

test('поиск: русские слова и английские имена Unicode', () => {
  expect(searchEmoji('кот')).toContain('🐱');
  expect(searchEmoji('cat')).toContain('🐈');
  expect(searchEmoji('thumbs up')).toContain('👍');
});
