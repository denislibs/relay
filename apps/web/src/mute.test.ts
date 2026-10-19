import { expect, test } from 'bun:test';
import { getGlobal, setGlobal } from './global';
import { bindMute, isMuted, migrateLocalMutes, muteChat, nextExpiry, startMuteTimers, unmuteChat } from './mute';
import type { KV } from './prefs';

const fake = (init: Record<string, string> = {}): KV & { m: Record<string, string> } => {
  const m = { ...init };
  return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: (k) => { delete m[k]; } };
};
const NOW = 1_000_000;

test('isMuted: null/undefined — no; 0 — forever; future — yes; past — no', () => {
  expect(isMuted({ muteUntil: null }, NOW)).toBe(false);
  expect(isMuted({}, NOW)).toBe(false);
  expect(isMuted(undefined, NOW)).toBe(false);
  expect(isMuted({ muteUntil: 0 }, NOW)).toBe(true);
  expect(isMuted({ muteUntil: NOW + 1 }, NOW)).toBe(true);
  expect(isMuted({ muteUntil: NOW }, NOW)).toBe(false);
  expect(isMuted({ muteUntil: NOW - 1 }, NOW)).toBe(false);
});

test('nextExpiry: nearest future deadline; forever and expired do not count', () => {
  expect(nextExpiry([{ muteUntil: 0 }, { muteUntil: null }, { muteUntil: NOW - 5 }], NOW)).toBeNull();
  expect(nextExpiry([{ muteUntil: NOW + 50 }, { muteUntil: 0 }, { muteUntil: NOW + 10 }], NOW)).toBe(NOW + 10);
});

test('migration: old keys become setMute calls (forever / future until), expired skipped, keys removed', async () => {
  const kv = fake({ 'relay.muted': JSON.stringify([1, 2, 3]), 'relay.mutedUntil': JSON.stringify({ 2: NOW + 3600_000, 3: NOW - 1 }) });
  const calls: [number, number | null][] = [];
  await migrateLocalMutes(async (id, until) => { calls.push([id, until]); }, kv, NOW);
  expect(calls).toEqual([[1, 0], [2, NOW + 3600_000]]);
  expect(kv.m).toEqual({});
  // повтор — ничего не шлёт
  await migrateLocalMutes(async (id, until) => { calls.push([id, until]); }, kv, NOW);
  expect(calls.length).toBe(2);
});

test('migration: a failed call keeps the keys for the next start; broken JSON is just dropped', async () => {
  const kv = fake({ 'relay.muted': JSON.stringify([7]) });
  await migrateLocalMutes(async () => { throw new Error('engine down'); }, kv, NOW);
  expect(kv.m['relay.muted']).toBe('[7]');
  const bad = fake({ 'relay.muted': '{oops', 'relay.mutedUntil': '[' });
  const calls: number[] = [];
  await migrateLocalMutes(async (id) => { calls.push(id); }, bad, NOW);
  expect(calls).toEqual([]);
  expect(bad.m).toEqual({});
});

test('muteChat / unmuteChat go to setMute', () => {
  const calls: [number, number | null][] = [];
  bindMute(async (id, until) => { calls.push([id, until]); });
  const t0 = Date.now();
  muteChat(5, null);
  muteChat(6, 3600);
  unmuteChat(7);
  expect(calls[0]).toEqual([5, 0]);
  expect(calls[1][0]).toBe(6);
  expect(calls[1][1]! - t0).toBeGreaterThanOrEqual(3600_000);
  expect(calls[1][1]! - t0).toBeLessThan(3600_000 + 1000);
  expect(calls[2]).toEqual([7, null]);
});

test('timer: muteTick bumps when the nearest mute expires', async () => {
  startMuteTimers();
  const tick0 = getGlobal().muteTick;
  setGlobal({ chats: [{ key: 'c1', id: 1, muteUntil: Date.now() + 30 }, { key: 'c2', id: 2, muteUntil: 0 }] });
  await new Promise((r) => setTimeout(r, 80));
  expect(getGlobal().muteTick).toBe(tick0 + 1);
  setGlobal({ chats: [] });
});
