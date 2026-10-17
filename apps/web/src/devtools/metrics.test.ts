import { expect, test } from 'bun:test';
import { ERRORS_CAP, clearErrors, getErrors, ingestLogErrors, markErrorsSeen, newErrorCount, pushError } from './metrics';

test('errors: ring of 200, repeats folded into a counter, new-errors count', () => {
  clearErrors();
  for (let i = 0; i < ERRORS_CAP + 50; i++) pushError('window', 'e' + i);
  expect(getErrors().length).toBe(ERRORS_CAP);
  expect(getErrors()[0].message).toBe('e50');
  markErrorsSeen();
  expect(newErrorCount()).toBe(0);
  pushError('promise', 'boom', 'Error: boom\n at a\n at b');
  pushError('promise', 'boom', 'Error: boom\n at a\n at b');
  const last = getErrors().at(-1)!;
  expect(last.count).toBe(2);
  expect(newErrorCount()).toBe(1);
});

test('engine log events: errors, server err frames and failed ops become errors once', () => {
  clearErrors();
  const ev = [
    { id: 1, t: 1, kind: 'error', type: 'host', data: { message: 'x', stack: 's' } },
    { id: 2, t: 2, kind: 'ws-in', type: 'err', data: { code: 'internal', retry: true } },
    { id: 3, t: 3, kind: 'engine', type: 'opFail', data: { key: 'profile', code: 'bio_too_long' } },
    { id: 4, t: 4, kind: 'ws-in', type: 'ack', data: {} },
  ];
  ingestLogErrors(ev);
  ingestLogErrors(ev);   // тот же снимок ещё раз — без дублей
  expect(getErrors().map((e) => e.source)).toEqual(['host', 'server', 'op']);
  expect(getErrors()[1].message).toBe('err internal (повтор)');
});

test('engine restart: a new log epoch resets the error cursor (ids start again at 1)', () => {
  clearErrors();
  ingestLogErrors([{ id: 5, ep: 'A', t: 1, kind: 'error', type: 'engine', data: { message: 'old' } }]);
  // тот же id в той же эпохе — повтор; меньший id в новой эпохе — новое событие
  ingestLogErrors([{ id: 5, ep: 'A', t: 1, kind: 'error', type: 'engine', data: { message: 'old' } }]);
  ingestLogErrors([{ id: 1, ep: 'B', t: 2, kind: 'error', type: 'host', data: { message: 'after restart' } }]);
  ingestLogErrors([{ id: 2, ep: 'B', t: 3, kind: 'ws-in', type: 'err', data: { code: 'internal' } }]);
  expect(getErrors().map((e) => e.message)).toEqual(['engine: old', 'host: after restart', 'err internal']);
});
