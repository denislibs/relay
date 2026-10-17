import { expect, test } from 'bun:test';
import { PREFS_KEY, defaultPrefs, getPrefs, loadPrefs, resetPrefsForTest, setPath, setPref, type KV } from './prefs';

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
