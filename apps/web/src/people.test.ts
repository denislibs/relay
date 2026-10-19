import { expect, test } from 'bun:test';
import type { Patch, Query } from '@relay/sync-engine/src/types';
import { getGlobal } from './global';
import { personName, startPeople, wantPeople } from './people';

// поддельный движок: запоминает подписки, патчи шлём руками
type Sub = { ids: number[]; push(p: Patch): void; closed: boolean };
const subs: Sub[] = [];
startPeople({
  watch(q: Query, onPatch: (p: Patch) => void) {
    const s: Sub = { ids: (q as { ids: number[] }).ids, push: onPatch, closed: false };
    subs.push(s);
    return { update() {}, close() { s.closed = true; } };
  },
});
const person = (id: number, name: string) => ({ key: String(id), id, name, photo: null });
const tick = () => new Promise<void>((r) => queueMicrotask(r));

test('ids wanted in one microtask go out as one subscription', async () => {
  wantPeople([1, 2]);
  wantPeople([2, 3]);
  expect(subs.length).toBe(0);
  await tick();
  expect(subs.length).toBe(1);
  expect([...subs[0].ids].sort()).toEqual([1, 2, 3]);
  subs[0].push({ op: 'snapshot', items: [person(1, 'Анна'), person(2, 'Борис')], order: ['1', '2'] });
  expect(personName(1)).toBe('Анна');
  expect(personName(3)).toBe('');
  // уже известные id — подписка не пересоздаётся
  wantPeople([1, 3]);
  await tick();
  expect(subs.length).toBe(1);
});

test('people stay on screen while the subscription is recreated', async () => {
  const before = getGlobal().people[1];
  wantPeople([4]);
  await tick();
  expect(subs.length).toBe(2);
  expect([...subs[1].ids].sort()).toEqual([1, 2, 3, 4]);
  // новая ещё ничего не прислала: старая жива, люди на месте
  expect(subs[0].closed).toBe(false);
  expect(personName(1)).toBe('Анна');
  subs[1].push({ op: 'snapshot', items: [person(1, 'Анна'), person(2, 'Борис'), person(4, 'Глеб')], order: ['1', '2', '4'] });
  expect(subs[0].closed).toBe(true);
  expect(personName(4)).toBe('Глеб');
  // тот же человек без изменений — тот же объект: селекторы не перерисовывают
  expect(getGlobal().people[1]).toBe(before);
  // запоздалый патч старой подписки не затирает новую
  subs[0].push({ op: 'diff', upsert: [person(1, 'Старое')], remove: [] });
  expect(personName(1)).toBe('Анна');
  subs[1].push({ op: 'diff', upsert: [person(2, 'Борис Б.')], remove: [] });
  expect(personName(2)).toBe('Борис Б.');
});

test('a new engine (sign-in as another user without reload) starts from scratch', async () => {
  const a = subs.filter((s) => !s.closed);
  expect(a.length).toBeGreaterThan(0);
  const b: Sub[] = [];
  startPeople({
    watch(q: Query, onPatch: (p: Patch) => void) {
      const s: Sub = { ids: (q as { ids: number[] }).ids, push: onPatch, closed: false };
      b.push(s);
      return { update() {}, close() { s.closed = true; } };
    },
  });
  expect(a.every((s) => s.closed)).toBe(true);
  expect(getGlobal().people).toEqual({});
  expect(personName(1)).toBe('');
  await tick();
  expect(b.length).toBe(0);   // прежний набор забыт — подписываться не на кого
  wantPeople([7]);
  await tick();
  expect(b.length).toBe(1);
  expect(b[0].ids).toEqual([7]);
  // поздний патч прежнего движка не попадает в новые данные
  a[0].push({ op: 'snapshot', items: [person(1, 'Анна')], order: ['1'] });
  expect(personName(1)).toBe('');
  b[0].push({ op: 'snapshot', items: [person(7, 'Ева')], order: ['7'] });
  expect(personName(7)).toBe('Ева');
});
