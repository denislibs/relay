import { expect, test } from 'bun:test';
import { floodText, floodWait, httpWait, waitText } from './flood';

test('waitText rounds up to seconds, minutes, hours', () => {
  expect(waitText(0.2)).toBe('через 1 с');
  expect(waitText(59)).toBe('через 59 с');
  expect(waitText(61)).toBe('через 2 мин');
  expect(waitText(3600)).toBe('через 1 ч');
  expect(waitText(5000)).toBe('через 2 ч');
});

test('floodWait reads engine errors ("flood:12"), server objects and ignores the rest', () => {
  expect(floodWait(new Error('flood:12'))).toBe(12);
  expect(floodWait(new Error('flood'))).toBe(0);
  expect(floodWait({ code: 'flood', retryAfter: 7 })).toBe(7);
  expect(floodWait(new Error('offline'))).toBeNull();
  expect(floodWait(new Error('flood_x'))).toBeNull();
  expect(floodText(12, 'Слишком много звонков')).toBe('Слишком много звонков. Попробуйте через 12 с');
  expect(floodText(0)).toBe('Слишком часто. Попробуйте позже');
});

test('httpWait: body retryAfter, else Retry-After header', async () => {
  expect(await httpWait(Response.json({ code: 'flood', retryAfter: 9 }, { status: 429 }))).toBe(9);
  expect(await httpWait(new Response('<html>', { status: 429, headers: { 'retry-after': '30' } }))).toBe(30);
});
