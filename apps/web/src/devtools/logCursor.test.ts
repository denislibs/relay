import { expect, test } from 'bun:test';
import { START, cursorAt, eventKey, isAfter } from './logCursor';

test('log cursor: by id within an epoch; any event of another epoch is after («Очистить» after a worker restart)', () => {
  const c = cursorAt({ ep: 'A', id: 40 });
  expect(isAfter({ ep: 'A', id: 40 }, c)).toBe(false);
  expect(isAfter({ ep: 'A', id: 41 }, c)).toBe(true);
  expect(isAfter({ ep: 'B', id: 1 }, c)).toBe(true);   // перезапуск: id снова с 1
  expect(isAfter({ ep: 'A', id: 1 }, START)).toBe(true);
  expect(cursorAt(undefined)).toEqual(START);
});

test('summary cache key differs between epochs for the same e1', () => {
  expect(eventKey({ ep: 'A', key: 'e1' })).not.toBe(eventKey({ ep: 'B', key: 'e1' }));
  expect(eventKey({ key: 'e1' })).toBe(':e1');
});
