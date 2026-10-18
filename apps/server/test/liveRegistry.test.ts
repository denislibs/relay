import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { heartbeat, markOffline, markOnline, onlineUsers } from '../src/domain/liveRegistry';
import { makeUser, resetDb } from './helpers';

process.env.RELAY_PRESENCE_GRACE_MS = '300';
beforeEach(resetDb);

test('online while connected, still online during the grace pause, offline after it', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  await markOnline(a, 1);
  expect(await onlineUsers([a, b])).toEqual(new Set([a]));
  await markOffline(a);
  expect(await onlineUsers([a])).toEqual(new Set([a]));     // перезагрузка вкладки — не «ушёл»
  await Bun.sleep(400);
  expect(await onlineUsers([a])).toEqual(new Set());
});

test('another process counts too; a crashed process expires by seen_at', async () => {
  const a = await makeUser('Анна');
  await sql`insert into live_conns (process_id, user_id, conns, seen_at) values (${crypto.randomUUID()}, ${a}, 1, now())`;
  expect(await onlineUsers([a])).toEqual(new Set([a]));
  await sql`update live_conns set seen_at = now() - interval '4 minutes'`;
  expect(await onlineUsers([a])).toEqual(new Set());
});

test('heartbeat refreshes own rows and removes stale ones', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  await markOnline(a, 1);
  await sql`update live_conns set seen_at = now() - interval '2 minutes'`;
  await sql`insert into live_conns (process_id, user_id, conns, seen_at) values (${crypto.randomUUID()}, ${b}, 1, now() - interval '10 minutes')`;
  await heartbeat();
  expect(await onlineUsers([a, b])).toEqual(new Set([a]));
  expect((await sql`select count(*)::int as n from live_conns`)[0].n).toBe(1);
});
