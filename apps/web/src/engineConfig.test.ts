import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// data.ts не импортировать (побочные эффекты при загрузке) — сравниваем исходники: свойства конфига и FEED_PAGE
const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8');
const props = (block: string) => block.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim().replace(/,$/, '')).filter(Boolean).sort();
const feed = (s: string) => /FEED_PAGE = (.+);/.exec(s)?.[1];

test('settings engine config equals the one data.ts sends', () => {
  const data = src('data.ts'), mine = src('engineConfig.ts');
  const a = /config: \{\n([\s\S]*?)\n\s*\},\n/.exec(data)?.[1];
  const b = /return \{\n([\s\S]*?)\n\s*\};/.exec(mine)?.[1];
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  expect(props(b!)).toEqual(props(a!));
  expect(feed(mine)).toBe(feed(data)!);
});
