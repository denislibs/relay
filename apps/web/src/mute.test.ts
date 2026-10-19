import { expect, test } from 'bun:test';
import { getGlobal, setGlobal } from './global';
import { bindMute, isMuted, loadLegacyMutes, migrateLegacyMutes, muteChat, nextExpiry, startMuteTimers, unmuteChat } from './mute';
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

type S = ReturnType<typeof getGlobal>;
const state = (ids: number[], status: Partial<S['status']> = {}): S => ({ ...getGlobal(), chatsLoaded: true, chats: ids.map((id) => ({ key: 'c' + id, id })), status: { ...getGlobal().status, synced: true, ...status } });
const rec = () => { const calls: [number, number | null][] = []; return { calls, set: async (id: number, until: number | null) => { calls.push([id, until]); } }; };

test('migration waits for the first sync and the chat list', async () => {
  const kv = fake({ 'relay.muted': '[1]' });
  loadLegacyMutes(kv, NOW);
  const r = rec();
  expect(await migrateLegacyMutes({ ...state([1]), chatsLoaded: false }, r.set, NOW)).toBe(false);
  expect(await migrateLegacyMutes(state([1], { synced: false }), r.set, NOW)).toBe(false);
  expect(r.calls).toEqual([]);
  expect(kv.m['relay.muted']).toBe('[1]');
  expect(await migrateLegacyMutes(state([1]), r.set, NOW)).toBe(true);
  expect(r.calls).toEqual([[1, 0]]);
  expect(kv.m).toEqual({});
});

test('migration: only this account\'s chats are sent (forever / future until), expired skipped; foreign ids dropped once the list is complete', async () => {
  const kv = fake({ 'relay.muted': JSON.stringify([1, 2, 3, 99]), 'relay.mutedUntil': JSON.stringify({ 2: NOW + 3600_000, 3: NOW - 1 }) });
  loadLegacyMutes(kv, NOW);
  const r = rec();
  // список не полный: 99 может быть глубже — не шлём, но и не выбрасываем
  expect(await migrateLegacyMutes(state([1, 2, 3]), r.set, NOW)).toBe(false);
  expect(r.calls).toEqual([[1, 0], [2, NOW + 3600_000]]);
  expect(JSON.parse(kv.m['relay.muted'])).toEqual([99]);
  // список полный — 99 чужой: молча выбрасываем, ключи удалены
  expect(await migrateLegacyMutes(state([1, 2, 3], { chatsComplete: true }), r.set, NOW)).toBe(true);
  expect(r.calls.length).toBe(2);
  expect(kv.m).toEqual({});
  // повтор — ничего не шлёт
  expect(await migrateLegacyMutes(state([1, 2, 3, 99], { chatsComplete: true }), r.set, NOW)).toBe(true);
  expect(r.calls.length).toBe(2);
});

test('migration: a failed call keeps the keys; broken JSON is just dropped', async () => {
  const kv = fake({ 'relay.muted': JSON.stringify([7]) });
  loadLegacyMutes(kv, NOW);
  expect(await migrateLegacyMutes(state([7]), async () => { throw new Error('engine down'); }, NOW)).toBe(false);
  expect(kv.m['relay.muted']).toBe('[7]');
  const bad = fake({ 'relay.muted': '{oops', 'relay.mutedUntil': '[' });
  loadLegacyMutes(bad, NOW);
  const r = rec();
  expect(await migrateLegacyMutes(state([7], { chatsComplete: true }), r.set, NOW)).toBe(true);
  expect(r.calls).toEqual([]);
  expect(bad.m).toEqual({});
});

test('until migrated, the old device list keeps the bell muted (no flicker); a user choice overrides it', () => {
  const kv = fake({ 'relay.muted': JSON.stringify([4, 5, 6]), 'relay.mutedUntil': JSON.stringify({ 5: NOW + 10, 6: NOW - 10 }) });
  loadLegacyMutes(kv, NOW);
  expect(isMuted({ id: 4, muteUntil: null }, NOW)).toBe(true);
  expect(isMuted({ id: 5 }, NOW)).toBe(true);
  expect(isMuted({ id: 5 }, NOW + 11)).toBe(false);
  expect(isMuted({ id: 6 }, NOW)).toBe(false);
  expect(isMuted({ id: 8 }, NOW)).toBe(false);
  expect(nextExpiry([], NOW)).toBe(NOW + 10);
  bindMute(async () => {});
  unmuteChat(4);
  expect(isMuted({ id: 4 }, NOW)).toBe(false);
  expect(JSON.parse(kv.m['relay.muted'])).toEqual([5]);
  loadLegacyMutes(fake(), NOW);   // убрать прежний список для следующих тестов
  expect(isMuted({ id: 5 }, NOW)).toBe(false);
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
