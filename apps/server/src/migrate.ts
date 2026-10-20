import { watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from './db';

const DIR = join(import.meta.dir, '..', 'migrations');

/**
 * Применяет новые файлы dir по порядку имён. Каждый — в своей транзакции под общим замком с повторной проверкой:
 * сервис migrate и dev-сервер (watchMigrations) могут запуститься одновременно — файл применится один раз.
 */
export async function migrate(dir = DIR): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql`select name from schema_migrations`).map((r) => r.name as string));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const text = await Bun.file(join(dir, name)).text();
    const ran = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('relay:migrate'))`;
      const [had] = await tx`select 1 from schema_migrations where name = ${name}`;
      if (had) return false;
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${name})`;
      return true;
    });
    if (ran) applied.push(name);
  }
  return applied;
}

/**
 * Dev: схема догоняет код. bun --watch перезапускает сервер на правку .ts, но не на новый .sql, а сервис migrate
 * работает только при `docker compose up` — код с новой колонкой падал 500 на каждом запросе, пока миграцию
 * не применят руками. Применяем сразу при старте и на каждое изменение папки (с паузой — файл дописывается).
 * Ошибка в недописанном файле — в лог, транзакция откатилась; следующая правка файла применит его снова.
 */
export function watchMigrations(dir = DIR, opts: { debounceMs?: number; log?: (msg: string) => void } = {}): { ready: Promise<void>; close(): void } {
  const log = opts.log ?? ((m) => console.log(m));
  let timer: ReturnType<typeof setTimeout> | undefined, running: Promise<void> = Promise.resolve();
  const run = () => {
    running = running.then(async () => {
      try {
        const applied = await migrate(dir);
        if (applied.length) log(`migrations applied: ${applied.join(', ')}`);
      } catch (err) {
        console.error('migrations:', err);
      }
    });
    return running;
  };
  const watcher = watch(dir, () => { clearTimeout(timer); timer = setTimeout(run, opts.debounceMs ?? 400); });
  return { ready: run(), close() { clearTimeout(timer); watcher.close(); } };
}

if (import.meta.main) {
  const applied = await migrate();
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
  await sql.end();
}
