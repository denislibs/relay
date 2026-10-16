import { expect, test } from 'bun:test';
import { sql } from '../src/db';
import { migrate } from '../src/migrate';

test('schema has all core tables', async () => {
  const rows = await sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
  const names = rows.map((r) => r.table_name);
  for (const t of ['chat_members', 'chats', 'messages', 'schema_migrations', 'sessions', 'updates', 'user_seq', 'users']) {
    expect(names).toContain(t);
  }
});

test('migrate is idempotent', async () => {
  expect(await migrate()).toEqual([]);
});

test('bigint columns come back as numbers', async () => {
  const [row] = await sql`select 9007199254740::bigint as n`;
  expect(row.n).toBe(9007199254740);
});
