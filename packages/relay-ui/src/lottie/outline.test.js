import { expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { decodeOutline } from './outline.js';

test('bytes map to path commands, signed and comma-separated numbers', () => {
  // в таблице индекс 12 — 'M', 19 — 'T'; 5 → «5»; 128|7 → «,7»; 64|3 → «-3»
  const bytes = new Uint8Array([192 + 12, 5, 128 | 7, 64 | 3, 192 + 19]);
  const b64 = btoa(String.fromCharCode(...bytes));
  expect(decodeOutline(b64)).toBe('MM5,7-3Tz');
  expect(decodeOutline('')).toBe('');
  expect(decodeOutline('%%%')).toBe('');
});

const meta = '/app/apps/server/assets/stickers/utyaduck/meta.json';
const local = new URL('../../../../apps/server/assets/stickers/utyaduck/meta.json', import.meta.url).pathname;
const file = [local, meta].find((p) => existsSync(p));
test.skipIf(!file)('a real sticker outline is a closed path of numbers and commands', () => {
  const path = decodeOutline(JSON.parse(readFileSync(file, 'utf8')).stickers[0].path);
  expect(path.startsWith('M')).toBe(true);
  expect(path.endsWith('z')).toBe(true);
  expect(path).toMatch(/^[MmLlCcQqSsTtHhVvAaZz0-9.,-]+$/);
  const nums = path.match(/\d+/g).map(Number);
  expect(Math.max(...nums)).toBeLessThanOrEqual(512);
});
