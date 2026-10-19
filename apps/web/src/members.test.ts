import { expect, test } from 'bun:test';
import { Mirror } from '@relay/sync-engine/src/client';
import { membersOf } from './members';

const item = (userId: number, role: string) => ({ key: String(userId), userId, role, rank: null, name: 'U' + userId, photo: null, online: false, lastSeen: null });

test('members come from the subscription mirror, owner derived from role', () => {
  const m = new Mirror();
  m.apply({ op: 'snapshot', items: [], order: [] } as never);
  expect(membersOf(m)).toBeNull();   // движок ещё не ответил
  m.apply({ op: 'snapshot', items: [item(1, 'owner'), item(2, 'member'), { key: '~members', loaded: true, complete: true }], order: ['1', '2', '~members'] } as never);
  const x = membersOf(m)!;
  expect(x.ownerId).toBe(1);
  expect(x.members.map((u) => u.userId)).toEqual([1, 2]);
});

test('loaded empty list is an answer, not "nothing yet"', () => {
  const m = new Mirror();
  m.apply({ op: 'snapshot', items: [{ key: '~members', loaded: true, complete: true }], order: ['~members'] } as never);
  expect(membersOf(m)).toEqual({ ownerId: null, members: [] });
});
