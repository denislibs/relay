import { expect, test } from 'bun:test';
import { pollVerdict } from './session';

test('/dev/stats polling: 404 and 401 stop it, other errors retry', () => {
  expect(pollVerdict(200)).toBe('ok');
  expect(pollVerdict(404)).toBe('stop');   // сервер без DEV_LOGIN
  expect(pollVerdict(401)).toBe('stop');   // вышли из аккаунта
  expect(pollVerdict(500)).toBe('retry');
  expect(pollVerdict(429)).toBe('retry');
});
