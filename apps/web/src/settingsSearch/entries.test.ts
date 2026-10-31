import { expect, test } from 'bun:test';
import { pageIndex } from '../nav';
import { anchorOf, ENTRIES } from './entries';
import { searchSettings } from './match';

const UI = new URL('../ui/', import.meta.url).pathname;
const sources = await Promise.all(
  [...new Bun.Glob('{settings,links}/*.tsx').scanSync(UI)].map((f) => Bun.file(UI + f).text()),
);
const src = sources.join('\n');

test('ids are unique', () => {
  const ids = ENTRIES.map((e) => e.id);
  expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
});

test('every path is a page', () => {
  expect(ENTRIES.filter((e) => pageIndex(e.path) < 0).map((e) => e.path)).toEqual([]);
});

test('every top-level section has a tile, parents exist on the same page', () => {
  const byId = new Map(ENTRIES.map((e) => [e.id, e]));
  const tops = ENTRIES.filter((e) => e.kind === 'section' && e.path.split('/').length === 2);
  expect(tops.filter((e) => !e.icon || !e.tile).map((e) => e.id)).toEqual([]);
  expect(ENTRIES.filter((e) => e.parent && byId.get(e.parent)?.path !== e.path).map((e) => e.id)).toEqual([]);
  // у каждого пункта есть свой раздел верхнего уровня
  const topPaths = new Set(tops.map((e) => e.path));
  expect(ENTRIES.filter((e) => !topPaths.has(e.path.split('/').slice(0, 2).join('/'))).map((e) => e.id)).toEqual([]);
});

test('anchors are unique on a page', () => {
  const keys = ENTRIES.flatMap((e) => (anchorOf(e) ? [e.path + ' ' + anchorOf(e)] : []));
  expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
});

// строка помечена прямо (data-setting="id" / setting="id" / 'id' в данных страницы) или префиксом, к которому
// дописывается ключ ('shortcut.' + s.id)
const marked = (a: string) =>
  src.includes(`"${a}"`) || src.includes(`'${a}'`)
  || a.split('.').slice(0, -1).some((_, i, parts) => {
    const pre = a.split('.').slice(0, i + 1).join('.') + '.';
    return src.includes(`'${pre}' +`) || src.includes('`' + pre + '${');
  });

test('every row is marked with data-setting in the page sources', () => {
  expect(ENTRIES.flatMap((e) => (anchorOf(e) && !marked(anchorOf(e)!) ? [e.id] : []))).toEqual([]);
});

test('the index answers the common queries', () => {
  const ctx = { dev: false, hasPassword: true };
  const first = (q: string) => searchSettings(ENTRIES, q, ctx)[0]?.items[0]?.entry.id;
  expect(first('тёмная')).toBe('general.theme.tinted');
  expect(first('ntvf')).toBe('general.theme');
  expect(first('ночной')).toBe('general.theme.night');
  expect(first('кэш')).toBe('data.cache');
  expect(first('чёрный')).toBe('privacy.blocked');
  expect(first('пароль')).toBe('privacy.password');
  expect(first('жирн')).toBe('shortcuts.format.bold');
  expect(searchSettings(ENTRIES, 'разраб', ctx)).toEqual([]);
});
