import { expect, test } from 'bun:test';
import { flushFrames, requestMeasure, requestMutation } from './schedule.js';

test('flushFrames прогоняет очередь сейчас: замеры раньше записей, вложенная работа — следующим проходом', () => {
  const log = [];
  requestMutation(() => log.push('w1'));
  requestMeasure(() => { log.push('m1'); requestMutation(() => log.push('w2')); });
  flushFrames(1);
  expect(log).toEqual(['m1', 'w1']);
  flushFrames(3);
  expect(log).toEqual(['m1', 'w1', 'w2']);
});

test('flushFrames без работы ничего не делает', () => {
  expect(() => flushFrames(5)).not.toThrow();
});
