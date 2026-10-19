import { expect, test } from 'bun:test';
import { nextV, Table } from '../src/rows';

type U = { id: number; name: string };
const mk = () => new Table<number, U>();

test('an older seq never overwrites a newer row; equal seq with new content does', () => {
  const t = mk();
  expect(t.put(1, { id: 1, name: 'Анна' }, 10)).toBe(true);
  expect(t.put(1, { id: 1, name: 'Старое' }, 9)).toBe(false);
  expect(t.get(1)!.name).toBe('Анна');
  const v1 = t.get(1)!.v;
  expect(t.put(1, { id: 1, name: 'Аня' }, 10)).toBe(true);
  expect(t.get(1)!.v).toBeGreaterThan(v1);
});

test('same content does not mark the row dirty', () => {
  const t = mk();
  t.put(1, { id: 1, name: 'Анна' }, 1);
  t.collect();
  expect(t.put(1, { id: 1, name: 'Анна' }, 2)).toBe(false);
  expect(t.collect().put).toHaveLength(0);
});

test('same content silently raises the stored seq and keeps v', () => {
  const t = mk();
  t.put(1, { id: 1, name: 'Анна' }, 1);
  const v1 = t.get(1)!.v;
  t.put(1, { id: 1, name: 'Анна' }, 5);
  expect(t.get(1)!.seq).toBe(5);
  expect(t.get(1)!.v).toBe(v1);
  expect(t.put(1, { id: 1, name: 'Старое' }, 4)).toBe(false);
});

test('nested objects compare by JSON', () => {
  const t = new Table<number, { id: number; photo?: { id: string } }>();
  t.put(1, { id: 1, photo: { id: 'a' } }, 1);
  expect(t.put(1, { id: 1, photo: { id: 'a' } }, 2)).toBe(false);
  expect(t.put(1, { id: 1, photo: { id: 'b' } }, 3)).toBe(true);
});

test('delete tombstones, put revives; collect drains', () => {
  const t = mk();
  t.put(1, { id: 1, name: 'a' }, 1);
  t.put(2, { id: 2, name: 'b' }, 1);
  expect(t.delete(1)).toBe(true);
  expect(t.delete(1)).toBe(false);
  expect(t.get(1)).toBeUndefined();
  expect(t.dirty.has(1)).toBe(false);
  const c = t.collect();
  expect(c.del).toEqual([1]);
  expect(c.put).toEqual([{ id: 2, name: 'b', seq: 1 }]);
  expect(t.dirty.size + t.removed.size).toBe(0);
  t.delete(2);
  t.put(2, { id: 2, name: 'b' }, 2);
  expect(t.removed.has(2)).toBe(false);
  expect(t.collect().del).toEqual([]);
});

test('load fills rows with seq and a fresh v and marks nothing dirty', () => {
  const t = mk();
  t.load([{ id: 1, name: 'a', seq: 7 }, { id: 2, name: 'b' }], (x) => x.id);
  expect(t.get(1)).toEqual({ id: 1, name: 'a', seq: 7, v: expect.any(Number) });
  expect(t.get(2)!.seq).toBe(0);
  expect(t.dirty.size).toBe(0);
});

test('v is monotonic across delete+revive, load and other tables: signatures never repeat', () => {
  const t = mk(), other = mk();
  t.put(1, { id: 1, name: 'a' }, 1);
  const seen = new Set([t.get(1)!.v]);
  t.delete(1);
  t.put(1, { id: 1, name: 'a' }, 2);          // та же строка снова — v не начинается с 1
  seen.add(t.get(1)!.v);
  other.put(1, { id: 1, name: 'a' }, 1);
  seen.add(other.get(1)!.v);
  t.load([{ id: 1, name: 'b', seq: 3 }], (x) => x.id);
  seen.add(t.get(1)!.v);
  expect(seen.size).toBe(4);
  expect(nextV()).toBeGreaterThan(t.get(1)!.v);
});
