import { expect, test } from 'bun:test';
import { incomingText, notifyText, planIncoming, soundOn, toggleSound, volumeFromSlider, volumePct } from './notifyRules';

const base = { state: 'on' as const, device: { web: true, sound: true, volume: 0.5 }, chatMuted: false, pref: { muted: false, preview: true }, hasFocus: false };

test('planIncoming: shows only when permitted, enabled, not muted and the window is unfocused', () => {
  expect(planIncoming(base)).toEqual({ show: true, preview: true, volume: 0.5 });
  expect(planIncoming({ ...base, state: 'default' }).show).toBe(false);
  expect(planIncoming({ ...base, state: 'off' }).show).toBe(false);
  expect(planIncoming({ ...base, device: { ...base.device, web: false } }).show).toBe(false);
  expect(planIncoming({ ...base, chatMuted: true }).show).toBe(false);
  expect(planIncoming({ ...base, pref: { muted: true, preview: true } }).show).toBe(false);
  expect(planIncoming({ ...base, hasFocus: true }).show).toBe(false);
});

test('planIncoming: preview and volume follow the settings; no sound when hidden', () => {
  expect(planIncoming({ ...base, pref: { muted: false, preview: false } }).preview).toBe(false);
  expect(planIncoming({ ...base, device: { ...base.device, sound: false } }).volume).toBe(0);
  expect(planIncoming({ ...base, device: { ...base.device, volume: 0 } }).volume).toBe(0);
  expect(planIncoming({ ...base, hasFocus: true }).volume).toBe(0);
});

test('sound: zero volume means off; enabling at zero restores 50 %', () => {
  expect(soundOn({ sound: true, volume: 0 })).toBe(false);
  expect(soundOn({ sound: false, volume: 0.7 })).toBe(false);
  expect(soundOn({ sound: true, volume: 0.2 })).toBe(true);
  expect(toggleSound({ sound: false, volume: 0 }, true)).toEqual({ sound: true, volume: 0.5 });
  expect(toggleSound({ sound: false, volume: 0.3 }, true)).toEqual({ sound: true, volume: 0.3 });
  expect(toggleSound({ sound: true, volume: 0.3 }, false)).toEqual({ sound: false, volume: 0.3 });
  expect(volumeFromSlider(0)).toEqual({ sound: false, volume: 0 });
  expect(volumeFromSlider(35)).toEqual({ sound: true, volume: 0.35 });
  expect(volumeFromSlider(140)).toEqual({ sound: true, volume: 1 });
  expect(volumePct(0.35)).toBe(35);
});

test('notifyText honors hideText and preview', () => {
  const m = { title: 'Анна', text: 'секрет' };
  expect(notifyText(m, { preview: true, hideText: false })).toEqual({ title: 'Анна', body: 'секрет' });
  expect(notifyText(m, { preview: false, hideText: false })).toEqual({ title: 'Анна', body: 'Новое сообщение' });
  expect(notifyText(m, { preview: true, hideText: true })).toEqual({ title: 'Relay', body: 'Новое сообщение' });
});

test('incomingText: login code is hidden in notifications, other messages keep their text', () => {
  const code = { body: 'Код для входа в Relay: 48213\n\nНикому не сообщайте этот код', service: { type: 'login_code' } };
  expect(incomingText(code)).not.toContain('48213');
  expect(incomingText(code)).toContain('•••••');
  expect(incomingText({ body: 'Новый вход 12345', service: { type: 'new_login' } })).toBe('Новый вход 12345');
  expect(incomingText({ body: 'встреча 48213' })).toBe('встреча 48213');
  expect(incomingText({ body: 'подпись', kind: 'photo' })).toBe('🖼 подпись');
  expect(incomingText({ body: '', kind: 'voice' })).toBe('🎤 Голосовое сообщение');
  expect(incomingText({ body: '', kind: 'file', attachmentName: 'a.pdf' })).toBe('📎 a.pdf');
});
