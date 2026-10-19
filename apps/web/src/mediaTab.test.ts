import { expect, test } from 'bun:test';
import { Mirror } from '@relay/sync-engine/src/client';
import { mediaOf } from './mediaTab';

const msg = (id: number) => ({ key: String(id), id, body: 'm' + id });
const counts = { media: 2, file: 0, link: 1, audio: 0, voice: 0 };

test('no ~media yet means the engine has not answered', () => {
  const m = new Mirror();
  m.apply({ op: 'snapshot', items: [], order: [] } as never);
  expect(mediaOf(m)).toBeNull();
});

test('cold snapshot: empty and loading, counts unknown', () => {
  const m = new Mirror();
  m.apply({ op: 'snapshot', items: [{ key: '~media', done: false, loading: true, counts: null }], order: ['~media'] } as never);
  expect(mediaOf(m)).toEqual({ items: [], done: false, loading: true, counts: null });
});

test('items keep engine order (newest first) and service key is skipped', () => {
  const m = new Mirror();
  m.apply({ op: 'snapshot', items: [msg(9), msg(5), { key: '~media', done: true, loading: false, counts }], order: ['9', '5', '~media'] } as never);
  const v = mediaOf(m)!;
  expect(v.items.map((i) => i.id)).toEqual([9, 5]);
  expect(v).toMatchObject({ done: true, loading: false, counts });
});
