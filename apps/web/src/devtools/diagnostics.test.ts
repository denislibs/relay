import { expect, test } from 'bun:test';
import { diagnosticsFile, redact } from './diagnostics';

test('redact: message bodies, profile and contact fields never reach the diagnostics file', () => {
  const userUpdated = { kind: 'ws-in', type: 'updates', data: { items: [{ update: { type: 'userUpdated', user: {
    id: 7, firstName: 'Аня', lastName: 'Секретова', username: 'anya_s', phone: '+79001234567', bio: 'живу на Ленина 5',
    birthday: { day: 3, month: 4, year: 1990 }, lastSeen: null,
  } } }, { update: { type: 'newMessage', message: { id: 1, body: 'пароль 1234', attachment: { name: 'паспорт.pdf', size: 10 } } } },
  { update: { type: 'contactsChanged', contact: { userId: 7, firstName: 'Аня', note: 'бывшая' } } }] } };
  const json = JSON.stringify(redact(userUpdated));
  for (const leak of ['Аня', 'Секретова', 'anya_s', '+79001234567', 'Ленина', '1990', 'пароль', 'паспорт', 'бывшая']) expect(json).not.toContain(leak);
  const u = (redact(userUpdated) as any).data.items[0].update.user;
  expect(u).toMatchObject({ id: 7, firstName: '‹3 симв.›', phone: '‹12 симв.›', birthday: '‹скрыто›', lastSeen: null });
});

test('redact: depth limit, arrays and plain values; diagnosticsFile names the file and redacts', () => {
  let deep: any = { v: 1 };
  for (let i = 0; i < 12; i++) deep = { n: deep };
  expect(JSON.stringify(redact(deep))).toContain('"…"');
  expect(redact([{ q: 'поиск' }, 3, null])).toEqual([{ q: '‹5 симв.›' }, 3, null]);
  const f = diagnosticsFile('abc', { log: [{ data: { text: 'привет' } }] }, new Date('2026-10-17T12:30:05Z'));
  expect(f.name).toBe('relay-diagnostics-abc-2026-10-17T12-30-05.json');
  expect(f.json).not.toContain('привет');
});
