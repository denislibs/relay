import { expect, test } from 'bun:test';
import { Mirror } from '@relay/sync-engine/src/client';
import type { Patch, Query } from '@relay/sync-engine/src/types';
import { inOwnMusic, musicOf, photosOf, resetProfileLists, startOwnMusic } from './profileLists';

const tr = (id: string) => ({ key: id, attId: id, title: 'T' + id, duration: 5, mime: 'audio/mpeg', addedAt: '2026-01-01' });
const meta = { key: '~profileMusic', loaded: true, loading: false };

test('inOwnMusic follows the own profileMusic subscription', () => {
  let push!: (p: Patch) => void, q!: Query, closed = 0;
  startOwnMusic(7, (query, cb) => { q = query; push = cb; return { close() { closed++; } }; });
  expect(q).toEqual({ kind: 'profileMusic', userId: 7 });
  expect(inOwnMusic('a')).toBe(false);
  push({ op: 'snapshot', items: [tr('a'), tr('b'), meta], order: ['a', 'b', '~profileMusic'] } as never);
  expect(inOwnMusic('a')).toBe(true);
  expect(inOwnMusic('c')).toBe(false);
  expect(inOwnMusic(undefined)).toBe(false);
  push({ op: 'diff', upsert: [tr('c')], remove: ['a'], order: ['c', 'b', '~profileMusic'] } as never);
  expect(inOwnMusic('a')).toBe(false);
  expect(inOwnMusic('c')).toBe(true);
  // вход другим пользователем: прежняя подписка закрыта, список очищен
  startOwnMusic(8, () => ({ close() {} }));
  expect(closed).toBe(1);
  expect(inOwnMusic('c')).toBe(false);
  resetProfileLists();
});

test('musicOf / photosOf read the mirror and skip ~ keys', () => {
  const m = new Mirror();
  m.apply({ op: 'snapshot', items: [], order: [] } as never);
  expect(musicOf(m)).toBeNull();
  m.apply({ op: 'snapshot', items: [tr('a'), meta], order: ['a', '~profileMusic'] } as never);
  expect(musicOf(m)).toEqual({ tracks: [{ id: 'a', title: 'Ta', duration: 5, mime: 'audio/mpeg' }], loaded: true, loading: false });
  const p = new Mirror();
  p.apply({ op: 'snapshot', items: [{ key: '3', pid: 3, id: 'f', small: 's', thumb: 't', at: 1 }, { key: '~profilePhotos', loaded: false, loading: true, total: 4 }], order: ['3', '~profilePhotos'] } as never);
  expect(photosOf(p)).toEqual({ photos: [{ pid: 3, id: 'f', small: 's', thumb: 't', at: 1 }], loaded: false, loading: true, total: 4 });
});
