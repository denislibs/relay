import { test, expect } from 'bun:test';
import { ProgressRing } from './kit.js';

// spin: дуга растёт и сходит и при известном прогрессе (видео, файлы); процент остаётся скринридеру
const flat = (v, out = []) => { if (!v || typeof v !== 'object') return out; out.push(v); const c = v.props?.children; (Array.isArray(c) ? c : [c]).forEach((x) => flat(x, out)); return out; };
const tree = (p) => { let v = ProgressRing(p); if (typeof v.type === 'function') v = v.type(v.props); return flat(v); };

test('spin: growing arc with a known progress, percent kept for screen readers', () => {
  const ring = tree({ progress: 0.4, spin: true, onMedia: true, size: 40 });
  expect(ring[0].props.class).toContain('rl-ring-spin');
  expect(ring[0].props['aria-valuenow']).toBe(40);
  expect(ring.find((n) => n.type === 'circle' && n.props.class === 'rl-ring-arc').props.pathLength).toBe(100);
  const pre = tree({ progress: 0.4, preloader: true, spin: true });
  expect(pre[0].props.class).not.toContain('rl-preloader-det');
  expect(pre[0].props['aria-valuenow']).toBe(40);
});

test('without spin a known progress still draws its length', () => {
  expect(tree({ progress: 0.4, preloader: true })[0].props.class).toContain('rl-preloader-det');
  expect(tree({ progress: 0.4 })[0].props.class).not.toContain('rl-ring-spin');
});
