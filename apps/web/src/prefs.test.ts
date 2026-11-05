import { expect, test } from 'bun:test';
import { PREFS_KEY, defaultPrefs, getPrefs, levelOf, loadPrefs, resolveBase, sharePattern, resetPrefsForTest, setPath, setPref, setPrefs, subscribePrefs, type KV } from './prefs';

const fake = (init: Record<string, string> = {}): KV & { m: Record<string, string> } => {
  const m = { ...init };
  return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: (k) => { delete m[k]; } };
};

test('broken JSON -> defaults', () => {
  expect(loadPrefs(fake({ [PREFS_KEY]: '{oops' }))).toEqual(defaultPrefs());
  expect(loadPrefs(fake({ [PREFS_KEY]: '[1]' }))).toEqual(defaultPrefs());
});

test('missing nested fields are filled, unknown dropped', () => {
  const p = loadPrefs(fake({ [PREFS_KEY]: JSON.stringify({ textSize: 20, anim: { level: 1 }, bogus: 1, notify: { sound: false, zzz: 1 } }) }));
  expect(p.textSize).toBe(20);
  expect(p.anim).toEqual({ ...defaultPrefs().anim, level: 1 });
  expect(p.notify).toEqual({ web: true, sound: false, volume: 0.5 });
  expect('bogus' in p).toBe(false);
  expect('zzz' in p.notify).toBe(false);
});

test('wrong types and out-of-range values fall back', () => {
  const p = loadPrefs(fake({ [PREFS_KEY]: JSON.stringify({ textSize: 'big', sendKey: 'x', theme: 'neon', anim: { level: 7 } }) }));
  expect(p.textSize).toBe(16); expect(p.sendKey).toBe('enter'); expect(p.theme).toBe('system'); expect(p.anim.level).toBe(2);
});

test('old relay.theme migrated', () => {
  expect(loadPrefs(fake({ 'relay.theme': 'dark' })).theme).toBe('night');
  expect(loadPrefs(fake({ 'relay.theme': 'light' })).theme).toBe('classic');
  expect(loadPrefs(fake({ 'relay.theme': 'junk' })).theme).toBe('system');
});

test('reduced motion -> level 0 only without stored prefs', () => {
  expect(loadPrefs(fake(), true).anim.level).toBe(0);
  expect(loadPrefs(fake({ [PREFS_KEY]: JSON.stringify({ anim: { level: 2 } }) }), true).anim.level).toBe(2);
});

test('setPath is immutable', () => {
  const a = defaultPrefs(); const b = setPath(a, 'autoload.photo.groups', false);
  expect(a.autoload.photo.groups).toBe(true); expect(b.autoload.photo.groups).toBe(false);
  expect(b.autoload.video).toBe(a.autoload.video); expect(b.notify).toBe(a.notify);
});

test('setPref persists and notifies', () => {
  const kv = fake(); resetPrefsForTest(kv);
  setPref('textSize', 20);
  expect(getPrefs().textSize).toBe(20);
  expect(JSON.parse(kv.m[PREFS_KEY]).textSize).toBe(20);
  expect(resetPrefsForTest(kv).textSize).toBe(20);
});

test('version: persisted as 2, missing = v1 (migrated), unknown -> defaults keeping theme', () => {
  const kv = fake(); resetPrefsForTest(kv); setPref('sendKey', 'ctrlEnter');
  expect(JSON.parse(kv.m[PREFS_KEY]).v).toBe(2);
  expect(loadPrefs(fake({ [PREFS_KEY]: JSON.stringify({ sendKey: 'ctrlEnter' }) })).sendKey).toBe('ctrlEnter');
  const f = loadPrefs(fake({ [PREFS_KEY]: JSON.stringify({ v: 3, theme: 'tinted', sendKey: 'ctrlEnter', textSize: 20 }) }));
  expect(f).toEqual({ ...defaultPrefs(), theme: 'tinted' });
  expect(loadPrefs(fake({ [PREFS_KEY]: JSON.stringify({ v: 3, theme: 'neon' }) })).theme).toBe('system');
});

test('v1 → v2: light/dark become Classic/Night, the accent becomes their preset, wallpapers move with them', () => {
  const v1 = { v: 1, theme: 'dark', accent: 'blue', textSize: 18,
    wallpaper: { light: { pattern: 'garden', colors: ['#aaaaaa', '#bbbbbb', '#cccccc', '#dddddd'], blur: false, intensity: 40, image: null },
      dark: { pattern: 'garden', colors: null, blur: true, intensity: 70, image: 'k3j2' } } };
  const p = loadPrefs(fake({ [PREFS_KEY]: JSON.stringify(v1) }));
  expect(p.v).toBe(2); expect(p.theme).toBe('night'); expect(p.textSize).toBe(18);
  expect(p.themes.classic).toEqual({ preset: 'a-blue', catalog: null, wallpaper: v1.wallpaper.light });
  expect(p.themes.night).toEqual({ preset: 'a-blue', catalog: null, wallpaper: v1.wallpaper.dark });
  expect(p.themes.day.wallpaper).toMatchObject({ pattern: 'garden', colors: null, image: null });   // узор общий
  expect(p.themes.tinted.preset).toBeNull();
  expect('accent' in p).toBe(false); expect('wallpaper' in p).toBe(false);
  expect(loadPrefs(fake({ [PREFS_KEY]: JSON.stringify({ v: 1, accent: 'green' }) })).themes.classic.preset).toBeNull();   // зелёный — «как в теме»
});

test('a preset belongs to its base; a catalog id is checked; contrast is boolean', () => {
  resetPrefsForTest(fake());
  setPref('themes.tinted.preset', 't-orange'); expect(getPrefs().themes.tinted.preset).toBe('t-orange');
  setPref('themes.day.preset', 't-orange'); expect(getPrefs().themes.day.preset).toBeNull();   // чужой ряд
  setPref('themes.night.catalog', 'snow'); expect(getPrefs().themes.night.catalog).toBe('snow');
  setPref('themes.night.catalog', '../x'); expect(getPrefs().themes.night.catalog).toBeNull();
  setPref('contrast', 'yes'); expect(getPrefs().contrast).toBe(false);
  setPref('contrast', true); expect(getPrefs().contrast).toBe(true);
});

test('picking a light or dark theme remembers it for "system" and the night toggle', () => {
  resetPrefsForTest(fake());
  setPref('theme', 'day'); expect(getPrefs().lastLight).toBe('day');
  setPref('theme', 'tinted'); expect(getPrefs().lastDark).toBe('tinted');
  setPref('theme', 'system');
  expect(resolveBase(getPrefs(), false)).toBe('day');
  expect(resolveBase(getPrefs(), true)).toBe('tinted');
  setPrefs({ lastLight: 'neon' }); expect(getPrefs().lastLight).toBe('classic');
});

test('setPref rejects garbage and clamps', () => {
  const kv = fake(); resetPrefsForTest(kv);
  setPref('anim', null); setPref('themes', 5); setPref('autoload.photo', 'x');
  expect(getPrefs()).toEqual(defaultPrefs());
  expect(JSON.parse(kv.m[PREFS_KEY])).toEqual(defaultPrefs());
  setPref('notify.volume', 7); expect(getPrefs().notify.volume).toBe(1);
  setPref('notify.volume', -1); expect(getPrefs().notify.volume).toBe(0);
  setPref('autoload.fileMaxMb', 40); expect(getPrefs().autoload.fileMaxMb).toBe(50);
  setPref('screen.blurDelay', 4); expect(getPrefs().screen.blurDelay).toBe(5);
  setPref('textSize', 99); expect(getPrefs().textSize).toBe(20);
  setPref('textSize', 13.6); expect(getPrefs().textSize).toBe(14);
  setPref('textSize', 1); expect(getPrefs().textSize).toBe(12);
});

test('setPref does not mutate previous state', () => {
  resetPrefsForTest(fake()); const before = getPrefs(); const snap = JSON.stringify(before);
  setPref('textSize', 99);
  expect(JSON.stringify(before)).toBe(snap);
});

test('anim level applies preset; flags leave level; levelOf custom', () => {
  resetPrefsForTest(fake());
  setPref('anim.level', 0);
  expect(getPrefs().anim).toEqual({ level: 0, ui: false, wallpaper: false, blur: false, autoplayGif: false, autoplayVideo: false, autoplayStickers: false, loopStickers: false });
  setPref('anim.level', 1);
  expect(getPrefs().anim).toEqual({ level: 1, ui: true, wallpaper: false, blur: false, autoplayGif: true, autoplayVideo: true, autoplayStickers: true, loopStickers: true });
  expect(levelOf(getPrefs().anim)).toBe(1);
  setPref('anim.blur', true);
  expect(getPrefs().anim.level).toBe(1); expect(levelOf(getPrefs().anim)).toBe('custom');
  setPref('anim.level', 2);
  expect(levelOf(getPrefs().anim)).toBe(2);
});

test('subscribePrefs notified on setPref', () => {
  resetPrefsForTest(fake()); let got = 0; const off = subscribePrefs((p) => { got = p.textSize; });
  setPref('textSize', 18); expect(got).toBe(18); off();
  setPref('textSize', 14); expect(got).toBe(18);
});

test('setPref wallpaper paths are sanitized', () => {
  resetPrefsForTest(fake());
  const L = () => getPrefs().themes.classic.wallpaper, D = () => getPrefs().themes.night.wallpaper;
  setPref('themes.classic.wallpaper.blur', true);
  expect(L().blur).toBe(true);
  setPref('themes.classic.wallpaper.blur', 'yes');
  expect(L().blur).toBe(false);
  setPref('themes.night.wallpaper.colors', ['#112233', 'red;}body{x', '#fff', '#000']);
  expect(D().colors).toBeNull();
  setPref('themes.night.wallpaper.colors', ['#112233', '#abc', '#fff', '#000000']);
  expect(D().colors).toEqual(['#112233', '#abc', '#fff', '#000000']);
  setPref('themes.night.wallpaper.colors', ['#112233']);
  expect(D().colors).toBeNull();
  setPref('themes.classic.wallpaper.pattern', '"); x');
  expect(L().pattern).toBe('cuteMix');
  setPref('themes.classic.wallpaper.pattern', 'doodles');
  expect(L().pattern).toBe('doodles');
  expect(L()).toMatchObject({ intensity: 50, image: null });
  setPref('themes.classic.wallpaper.intensity', 140);
  expect(L().intensity).toBe(100);
  setPref('themes.classic.wallpaper.intensity', 33.6);
  expect(L().intensity).toBe(34);
  setPref('themes.night.wallpaper.image', 'mv4k2x1');
  expect(D().image).toBe('mv4k2x1');
  setPref('themes.night.wallpaper.image', '../x"');
  expect(D().image).toBeNull();
});

test('узор обоев общий для всех тем, цвета — у каждой свои', () => {
  const kv = fake(); resetPrefsForTest(kv);
  setPref('themes.night.wallpaper.colors', ['#111111', '#222222', '#333333', '#444444']);
  setPref('themes.classic.wallpaper', { ...getPrefs().themes.classic.wallpaper, pattern: 'spaceCats', colors: ['#aaaaaa', '#bbbbbb', '#cccccc', '#dddddd'] });
  for (const b of ['night', 'day', 'tinted'] as const) expect(getPrefs().themes[b].wallpaper.pattern).toBe('spaceCats');
  expect(getPrefs().themes.night.wallpaper.colors).toEqual(['#111111', '#222222', '#333333', '#444444']);
  setPref('themes.tinted.wallpaper.pattern', 'garden');
  expect(getPrefs().themes.classic.wallpaper.pattern).toBe('garden');
  expect(getPrefs().themes.classic.wallpaper.colors).toEqual(['#aaaaaa', '#bbbbbb', '#cccccc', '#dddddd']);
  expect(resetPrefsForTest(kv).themes.day.wallpaper.pattern).toBe('garden');   // и в хранилище
});

test('разошедшиеся узоры из старых настроек сводятся к узору темы на экране', () => {
  const kv = fake();
  const w = defaultPrefs().themes.classic.wallpaper;
  kv.setItem(PREFS_KEY, JSON.stringify({ v: 1, theme: 'dark', wallpaper: { light: { ...w, pattern: 'garden' }, dark: { ...w, pattern: 'spaceCats' } } }));
  const p = loadPrefs(kv);
  expect(p.themes.classic.wallpaper.pattern).toBe('spaceCats');
  expect(p.themes.night.wallpaper.pattern).toBe('spaceCats');
  const changed = { ...p, themes: { ...p.themes, classic: { ...p.themes.classic, wallpaper: { ...p.themes.classic.wallpaper, pattern: 'garden' } } } };
  expect(sharePattern({ ...changed, theme: 'classic' }).themes.night.wallpaper.pattern).toBe('garden');
});
