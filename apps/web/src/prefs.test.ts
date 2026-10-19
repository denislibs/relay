import { expect, test } from 'bun:test';
import { PREFS_KEY, defaultPrefs, getPrefs, levelOf, loadPrefs, resetPrefsForTest, setPath, setPref, subscribePrefs, type KV } from './prefs';

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
  expect(loadPrefs(fake({ 'relay.theme': 'dark' })).theme).toBe('dark');
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

test('version: persisted, missing = v1, unknown -> defaults keeping theme', () => {
  const kv = fake(); resetPrefsForTest(kv); setPref('sendKey', 'ctrlEnter');
  expect(JSON.parse(kv.m[PREFS_KEY]).v).toBe(1);
  expect(loadPrefs(fake({ [PREFS_KEY]: JSON.stringify({ sendKey: 'ctrlEnter' }) })).sendKey).toBe('ctrlEnter');
  const f = loadPrefs(fake({ [PREFS_KEY]: JSON.stringify({ v: 2, theme: 'dark', sendKey: 'ctrlEnter', textSize: 20 }) }));
  expect(f).toEqual({ ...defaultPrefs(), theme: 'dark' });
  expect(loadPrefs(fake({ [PREFS_KEY]: JSON.stringify({ v: 2, theme: 'neon' }) })).theme).toBe('system');
});

test('setPref rejects garbage and clamps', () => {
  const kv = fake(); resetPrefsForTest(kv);
  setPref('anim', null); setPref('wallpaper', 5); setPref('autoload.photo', 'x');
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
  expect(getPrefs().anim).toEqual({ level: 0, ui: false, wallpaper: false, blur: false, autoplayGif: false, autoplayVideo: false });
  setPref('anim.level', 1);
  expect(getPrefs().anim).toEqual({ level: 1, ui: true, wallpaper: false, blur: false, autoplayGif: true, autoplayVideo: true });
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
  setPref('wallpaper.light.blur', true);
  expect(getPrefs().wallpaper.light.blur).toBe(true);
  setPref('wallpaper.light.blur', 'yes');
  expect(getPrefs().wallpaper.light.blur).toBe(false);
  setPref('wallpaper.dark.colors', ['#112233', 'red;}body{x', '#fff', '#000']);
  expect(getPrefs().wallpaper.dark.colors).toBeNull();
  setPref('wallpaper.dark.colors', ['#112233', '#abc', '#fff', '#000000']);
  expect(getPrefs().wallpaper.dark.colors).toEqual(['#112233', '#abc', '#fff', '#000000']);
  setPref('wallpaper.dark.colors', ['#112233']);
  expect(getPrefs().wallpaper.dark.colors).toBeNull();
  setPref('wallpaper.light.pattern', '"); x');
  expect(getPrefs().wallpaper.light.pattern).toBe('cuteMix');
  setPref('wallpaper.light.pattern', 'doodles');
  expect(getPrefs().wallpaper.light.pattern).toBe('doodles');
  expect(getPrefs().wallpaper.light).toMatchObject({ intensity: 50, image: null });
  setPref('wallpaper.light.intensity', 140);
  expect(getPrefs().wallpaper.light.intensity).toBe(100);
  setPref('wallpaper.light.intensity', 33.6);
  expect(getPrefs().wallpaper.light.intensity).toBe(34);
  setPref('wallpaper.dark.image', 'mv4k2x1');
  expect(getPrefs().wallpaper.dark.image).toBe('mv4k2x1');
  setPref('wallpaper.dark.image', '../x"');
  expect(getPrefs().wallpaper.dark.image).toBeNull();
});
