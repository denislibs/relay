import { expect, test } from 'bun:test';
import { previewBody } from './preview';

// Превью строки чата: у кода входа цифры — точками, оформление (code, спойлер) отбрасывается.
const flat = (v: unknown): string => (Array.isArray(v) ? v.map(flat).join('') : typeof v === 'string' ? v : '');
const hasSpan = (v: unknown): boolean => Array.isArray(v) && v.some((x) => x && typeof x === 'object');

test('previewBody: login_code is masked and its entities are dropped', () => {
  const body = 'Код для входа в Relay: 48213 Никому не сообщайте';
  const m = { senderId: 1, body, service: { type: 'login_code' }, entities: [{ type: 'spoiler', offset: 0, length: 3 }, { type: 'code', offset: 23, length: 5 }] };
  const out = previewBody(m, false);
  expect(flat(out)).toBe('Код для входа в Relay: ••••• Никому не сообщайте');
  expect(hasSpan(out)).toBe(false);   // спойлер не применён: оформление отброшено
});

test('previewBody: ordinary messages keep their digits and entities', () => {
  const m = { senderId: 1, body: 'тайна 48213', entities: [{ type: 'spoiler', offset: 0, length: 5 }] };
  const out = previewBody(m, false);
  expect(flat(out)).toContain('48213');
  expect(hasSpan(out)).toBe(true);
});
