import { expect, test } from 'bun:test';
import { fold, layoutVariants, normalize, searchSettings, type Entry } from './match';

const E: Entry[] = [
  { id: 'general', path: 'settings/general', title: 'Общие настройки', kind: 'section', icon: 'general', tile: 'orange' },
  { id: 'general.theme', path: 'settings/general', title: 'Тема', kind: 'subsection' },
  { id: 'general.theme.dark', path: 'settings/general', parent: 'general.theme', title: 'Тёмная', kind: 'option', keywords: ['ночной режим'] },
  { id: 'general.theme.light', path: 'settings/general', parent: 'general.theme', title: 'Светлая', kind: 'option' },
  { id: 'general.wallpaper', path: 'settings/general/wallpaper', title: 'Обои', kind: 'section' },
  { id: 'general.wallpaper.reset', path: 'settings/general/wallpaper', title: 'Сбросить', kind: 'row' },
  { id: 'notifications', path: 'settings/notifications', title: 'Уведомления', kind: 'section', icon: 'bell', tile: 'red' },
  { id: 'notifications.web', path: 'settings/notifications', title: 'Уведомления в браузере', kind: 'toggle' },
  { id: 'notifications.sound', path: 'settings/notifications', title: 'Звук', kind: 'toggle' },
  { id: 'notifications.night', path: 'settings/notifications', title: 'Ночной звук', kind: 'toggle' },
  { id: 'privacy', path: 'settings/privacy', title: 'Конфиденциальность', kind: 'section' },
  { id: 'privacy.password.off', path: 'settings/privacy', title: 'Отключить пароль', kind: 'row', when: (c) => c.hasPassword === true },
  { id: 'dev', path: 'settings/dev', title: 'Для разработчиков', kind: 'section', when: (c) => c.dev },
];
const ctx = { dev: false, hasPassword: false };
const ids = (q: string, c = ctx) => searchSettings(E, q, c).flatMap((g) => g.items.map((i) => i.entry.id));

test('normalize: case, punctuation, ё → е, spaces collapsed', () => {
  expect(normalize('  Тёмная, ТЕМА!  ')).toBe('темная тема');
  expect(fold('Ёж-ик')).toBe('еж ик');
  expect(fold('Ёж-ик').length).toBe('Ёж-ик'.length);   // позиции совпадают с исходной строкой
});

test('layout variants: as is, qwerty → йцукен, йцукен → qwerty', () => {
  expect(layoutVariants('ntvf')).toContain('тема');
  expect(layoutVariants('еуьф')).toContain('tema');
  expect(layoutVariants('ntvf')[0]).toBe('ntvf');
  expect(layoutVariants('nt,f')).toContain('теба');   // знаки на месте русских букв
  expect(layoutVariants('')).toEqual([]);
});

test('prefix of a title word finds the entry; ё/е are the same', () => {
  expect(ids('тем')).toEqual(['general.theme', 'general.theme.dark']);
  expect(ids('темн')).toEqual(['general.theme.dark']);
  expect(ids('тёмн')).toEqual(['general.theme.dark']);
});

test('wrong keyboard layout', () => {
  expect(ids('ntvf')).toEqual(['general.theme']);
});

test('every query word must match (AND), crumbs count', () => {
  expect(ids('звук увед')).toEqual(['notifications.sound', 'notifications.night']);
  expect(ids('звук обои')).toEqual([]);
  expect(ids('сброс обои')).toEqual(['general.wallpaper.reset']);
  expect(ids('обои')).not.toContain('general.wallpaper.reset');   // одни крошки без слова из заголовка — не находка
});

test('title start beats a word inside, synonyms rank below direct matches', () => {
  expect(ids('ночн')).toEqual(['notifications.night', 'general.theme.dark']);
  const hit = searchSettings(E, 'ночной', ctx).flatMap((g) => g.items).find((i) => i.entry.id === 'general.theme.dark')!;
  expect(hit.hits).toEqual([]);   // в заголовке подсвечивать нечего
});

test('a section ranks above its own entries and groups by top-level section', () => {
  const g = searchSettings(E, 'обои', ctx);
  expect(g.map((x) => x.section.id)).toEqual(['general']);
  expect(g[0].items.map((i) => i.entry.id)).toEqual(['general.wallpaper']);
  expect(ids('сброс')).toEqual(['general.wallpaper.reset']);
  const u = searchSettings(E, 'увед', ctx);
  expect(u[0].items.map((i) => i.entry.id)).toEqual(['notifications', 'notifications.web']);
});

test('crumbs skip the root and the entry itself', () => {
  const all = searchSettings(E, 'тем', ctx).flatMap((g) => g.items);
  expect(all.find((i) => i.entry.id === 'general.theme.dark')!.crumbs).toEqual(['Общие настройки', 'Тема']);
  expect(searchSettings(E, 'общие', ctx)[0].items[0].crumbs).toEqual([]);
  expect(searchSettings(E, 'сброс', ctx)[0].items[0].crumbs).toEqual(['Общие настройки', 'Обои']);
});

test('when hides unavailable entries', () => {
  expect(ids('разраб')).toEqual([]);
  expect(ids('разраб', { dev: true, hasPassword: false })).toEqual(['dev']);
  expect(ids('отключ')).toEqual([]);
  expect(ids('отключ', { dev: false, hasPassword: true })).toEqual(['privacy.password.off']);
});

test('title highlight ranges point into the original title', () => {
  const hit = searchSettings(E, 'зв', ctx).flatMap((g) => g.items).find((i) => i.entry.id === 'notifications.night')!;
  expect(hit.hits).toEqual([[7, 9]]);
  const lay = searchSettings(E, 'ntv', ctx)[0].items[0];
  expect(lay.hits).toEqual([[0, 3]]);
});

test('empty query gives nothing', () => {
  expect(searchSettings(E, '  ', ctx)).toEqual([]);
});
