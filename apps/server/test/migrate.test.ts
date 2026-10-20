import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from '../src/db';
import { migrate, watchMigrations } from '../src/migrate';

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

/** Своя папка миграций и своя таблица на тест: общий schema_migrations не засоряем (afterEach убирает). */
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-mig-'));
  const tag = 'mig_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const files: string[] = [];
  cleanup.push(async () => {
    await sql.unsafe(`drop table if exists ${tag}`);
    if (files.length) await sql`delete from schema_migrations where name in ${sql(files)}`;
    await rm(dir, { recursive: true, force: true });
  });
  const add = async (name: string, text: string) => { files.push(name); await writeFile(join(dir, name), text); };
  return { dir, tag, add };
}

test('parallel migrate runs (compose migrate + dev server) apply a file once', async () => {
  const { dir, tag, add } = await scratch();
  await add(`${tag}_1.sql`, `create table ${tag} (id int)`);   // второй прогон без замка упал бы: relation already exists
  const runs = await Promise.all([migrate(dir), migrate(dir), migrate(dir)]);
  expect(runs.flat()).toEqual([`${tag}_1.sql`]);
});

// регрессия: код с новой колонкой (messages.buttons) подхватил bun --watch, а миграцию никто не применил —
// /auth/code падал 500 «Что-то пошло не так», пока не запустили migrate руками
test('dev watcher applies a migration that appears while the server runs', async () => {
  const { dir, tag, add } = await scratch();
  const logs: string[] = [];
  const w = watchMigrations(dir, { debounceMs: 20, log: (m) => logs.push(m) });
  cleanup.push(async () => w.close());
  await w.ready;
  await add(`${tag}_1.sql`, `create table ${tag} (id int); alter table ${tag} add column buttons jsonb`);
  for (let i = 0; i < 100 && !logs.length; i++) await Bun.sleep(20);
  expect(logs).toEqual([`migrations applied: ${tag}_1.sql`]);
  const [col] = await sql`select 1 from information_schema.columns where table_name = ${tag} and column_name = 'buttons'`;
  expect(col).toBeTruthy();
});

test('a broken (half-written) file is logged, rolled back, and applied once it is fixed', async () => {
  const { dir, tag, add } = await scratch();
  const logs: string[] = [];
  const w = watchMigrations(dir, { debounceMs: 20, log: (m) => logs.push(m) });
  cleanup.push(async () => w.close());
  await w.ready;
  const err = console.error;
  const errors: unknown[] = [];
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    await add(`${tag}_1.sql`, `create table ${tag} (id int`);
    for (let i = 0; i < 100 && !errors.length; i++) await Bun.sleep(20);
  } finally { console.error = err; }
  expect(errors.length).toBeGreaterThan(0);
  expect((await sql`select 1 from schema_migrations where name = ${tag + '_1.sql'}`).length).toBe(0);
  await writeFile(join(dir, `${tag}_1.sql`), `create table ${tag} (id int)`);
  for (let i = 0; i < 100 && !logs.length; i++) await Bun.sleep(20);
  expect(logs).toEqual([`migrations applied: ${tag}_1.sql`]);
});
